import http from 'node:http';
import { SseFrameParser, type SseFrame } from '../../src/lib/sse-frame-parser.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { toError } from '../../src/lib/errors.js';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.js';
import { asObject } from './dashboard-http.js';
import { testHttpAgent } from './http-agent.js';

export type CollectedSseResponse = {
  statusCode: number;
  frames: SseFrame[];
  progress: JsonObject[];
  result: JsonObject | null;
  error: JsonObject | null;
  errorMessage: string | null;
  rawBody: string;
};

const DEFAULT_REQUEST_DEADLINE_MS = 15_000;

/**
 * Collects an SSE response, failing hard once `timeoutMs` has elapsed.
 *
 * The deadline runs from the request, not from the last byte. `request.setTimeout` measures
 * socket inactivity, which a stream that keeps emitting progress frames resets forever — an
 * operation stuck in a loop that still reports would never time out client-side.
 */
export function requestSse(
  url: string,
  options: {
    body: JsonSerializable;
    timeoutMs?: number;
    headers?: Record<string, string>;
    onProgress?: (event: JsonObject) => void | Promise<void>;
  },
): Promise<CollectedSseResponse> {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(options.body);
    let deadlineHandle: NodeJS.Timeout | null = null;
    const clearDeadline = (): void => {
      if (deadlineHandle) {
        clearTimeout(deadlineHandle);
        deadlineHandle = null;
      }
    };
    const settle = (outcome: () => void): void => {
      clearDeadline();
      outcome();
    };
    const collected: CollectedSseResponse = {
      statusCode: 0,
      frames: [],
      progress: [],
      result: null,
      error: null,
      errorMessage: null,
      rawBody: '',
    };
    const parser = new SseFrameParser();
    const request = http.request(url, {
      method: 'POST',
      agent: testHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText, 'utf8'),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      collected.statusCode = response.statusCode || 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        collected.rawBody += chunk;
        for (const frame of parser.push(chunk)) {
          collected.frames.push(frame);
          const data = asObject(parseJsonValueText(frame.data));
          if (frame.event === 'progress') {
            if (options.onProgress) {
              // `catch` hands back an untyped rejection reason; toError is the repo's only
              // sanctioned normalization, so a non-Error throw still fails as a real Error.
              void Promise.resolve(options.onProgress(data)).catch((error) => {
                settle(() => reject(toError(error)));
              });
            }
            collected.progress.push(data);
          } else if (frame.event === 'result') {
            collected.result = data;
          } else if (frame.event === 'error') {
            collected.error = data;
            collected.errorMessage = String(data.error || '');
          }
        }
      });
      response.on('end', () => settle(() => resolve(collected)));
      response.on('error', (error: Error) => settle(() => reject(error)));
    });
    const deadlineMs = options.timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    deadlineHandle = setTimeout(() => {
      request.destroy(new Error(`requestSse timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    request.on('error', (error: Error) => settle(() => reject(error)));
    request.write(bodyText);
    request.end();
  });
}

export function writeSseResult(
  res: http.ServerResponse,
  payload: JsonSerializable,
  progressEvents: JsonSerializable[] = [],
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  for (const event of progressEvents) {
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}
