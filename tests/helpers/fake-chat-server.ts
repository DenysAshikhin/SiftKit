import http from 'node:http';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { asObject } from './dashboard-http.js';

export type FakeChatServer = {
  baseUrl: string;
  requestCount: () => number;
  bodyAt: (index: number) => JsonObject;
  close: () => Promise<void>;
};

export type FakeChatServerOptions = {
  /** The content delta streamed on every request. */
  content: string;
  /** Reasoning deltas streamed on request 1 only. Default none. */
  reasoningDeltas?: readonly string[];
  /**
   * 'none' emits no completion usage on reasoning frames (default).
   * 'cumulative' reports reasoning_tokens = deltaIndex + 1.
   * 'zero' reports reasoning_tokens = 0 on every reasoning frame.
   */
  reportedReasoningTokens?: 'none' | 'cumulative' | 'zero';
};

/** Prompt usage streamed on the first frame of request 1 and of every later request. */
export const FAKE_PROMPT_USAGE = {
  first: { promptTokens: 100, cachedTokens: 60 },
  later: { promptTokens: 110, cachedTokens: 100 },
} as const;

function toPromptUsageFrame(usage: { promptTokens: number; cachedTokens: number }): JsonObject {
  return { prompt_tokens: usage.promptTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
}

/** `count` reasoning deltas of `chars` characters each: `r00.....`, `r01.....`, ... */
export function buildReasoningDeltas(count: number, chars: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `r${String(index).padStart(2, '0')}`.padEnd(chars, '.'));
}

/**
 * OpenAI-compatible SSE stub. Records every chat body, answers token-count probes with a
 * constant, streams request 1's reasoning deltas then the content, and streams only content
 * afterward, so a thinking-budget continuation completes immediately with the answer.
 */
export function startFakeChatServer(options: FakeChatServerOptions): Promise<FakeChatServer> {
  const reportedMode = options.reportedReasoningTokens ?? 'none';
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        // Token-count probes (loop preflight) get a plain JSON answer and stay
        // out of the chat body index the assertions rely on.
        if (req.url === '/v1/token/encode' || req.url === '/tokenize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ length: 32 }));
          return;
        }
        bodies.push(raw);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const writeDelta = (delta: JsonObject, usage?: JsonObject): void => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], object: 'chat.completion.chunk', ...(usage ? { usage } : {}) })}\n\n`);
        };
        // Prompt usage rides the first frame of every request, so the first
        // request's stats survive the mid-stream budget abort.
        writeDelta({}, toPromptUsageFrame(bodies.length === 1 ? FAKE_PROMPT_USAGE.first : FAKE_PROMPT_USAGE.later));
        if (bodies.length === 1) {
          (options.reasoningDeltas ?? []).forEach((text, index) => {
            const usage = reportedMode === 'none'
              ? undefined
              : { completion_tokens_details: { reasoning_tokens: reportedMode === 'cumulative' ? index + 1 : 0 } };
            writeDelta({ reasoning_content: text }, usage);
          });
        }
        writeDelta({ content: options.content });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      // The client may destroy the socket mid-stream (budget early stop).
      res.on('error', () => {});
      req.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => bodies.length,
        bodyAt: (index: number) => asObject(parseJsonValueText(bodies[index] ?? '{}')),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
