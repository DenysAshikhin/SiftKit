import http from 'node:http';
import { SseFrameParser, type SseFrame } from '../../src/lib/sse-frame-parser.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.js';
import { asObject } from './dashboard-http.js';

export type CollectedSseResponse = {
  statusCode: number;
  frames: SseFrame[];
  progress: JsonObject[];
  result: JsonObject | null;
  error: JsonObject | null;
  errorMessage: string | null;
  rawBody: string;
};

export function requestSse(
  url: string,
  options: { body: JsonSerializable; timeoutMs?: number },
): Promise<CollectedSseResponse> {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(options.body);
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText, 'utf8'),
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
            collected.progress.push(data);
          } else if (frame.event === 'result') {
            collected.result = data;
          } else if (frame.event === 'error') {
            collected.error = data;
            collected.errorMessage = String(data.message || '');
          }
        }
      });
      response.on('end', () => resolve(collected));
      response.on('error', reject);
    });
    request.setTimeout(options.timeoutMs ?? 15_000, () => request.destroy(new Error('requestSse timed out')));
    request.on('error', reject);
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
