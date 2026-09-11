import http from 'node:http';
import { z } from 'zod';
import { closeHttpServer, getAddressInfo } from './dashboard-http.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { InferenceChatMessageSchema } from '../../src/llm-protocol/types.js';

const RequestSchema = z.object({ messages: z.array(InferenceChatMessageSchema) }).loose();
const TokenRequestSchema = z.object({ text: z.string() });
type GatedChatBackendOptions = { readonly overflowTokenText?: string };

/** The test releases each provider chunk only after observing the previous chunk in the client. */
export class GatedChatBackend {
  private readonly overflowTokenText: string | null;
  private readonly pending: http.ServerResponse[] = [];
  private waiting: { resolve(response: http.ServerResponse): void; reject(error: Error): void } | null = null;
  private closed = false;
  constructor(options: GatedChatBackendOptions = {}) {
    this.overflowTokenText = options.overflowTokenText ?? null;
  }
  readonly requests: z.infer<typeof RequestSchema>[] = [];
  private readonly server = http.createServer((request, response) => {
    const expectedMethod = request.url === '/v1/chat/completions' || request.url === '/v1/token/encode'
      ? 'POST' : request.url === '/v1/models' || request.url === '/health' ? 'GET' : null;
    if (!expectedMethod || request.method !== expectedMethod) {
      response.statusCode = expectedMethod ? 405 : 404;
      response.end('Unexpected gated backend request');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      if (request.url !== '/v1/chat/completions') {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/token/encode') {
          const text = TokenRequestSchema.parse(JSON.parse(body)).text;
          const overflow = this.overflowTokenText !== null && text.includes(this.overflowTokenText) && text.length > 1000;
          response.end(JSON.stringify({ count: overflow ? 6000 : 10 }));
        } else response.end(JSON.stringify(request.url === '/v1/models' ? { object: 'list', data: [{ id: 'mock' }] } : { ok: true }));
        return;
      }
      this.requests.push(RequestSchema.parse(JSON.parse(body)));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      if (this.waiting) {
        const waiting = this.waiting;
        this.waiting = null;
        waiting.resolve(response);
      } else this.pending.push(response);
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    return `http://127.0.0.1:${getAddressInfo(this.server).port}`;
  }

  nextRequest(): Promise<http.ServerResponse> {
    if (this.closed) return Promise.reject(new Error('Gated backend closed'));
    const response = this.pending.shift();
    if (response) return Promise.resolve(response);
    if (this.waiting) throw new Error('Only one request waiter is supported.');
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  write(response: http.ServerResponse, delta: JsonObject): void {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  }

  finish(response: http.ServerResponse): void {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
      prompt_tokens: 10, completion_tokens: 220, total_tokens: 230,
      completion_tokens_details: { reasoning_tokens: 187 },
    } })}\n\n`);
    response.end('data: [DONE]\n\n');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.reject(new Error('Gated backend closed'));
    this.waiting = null;
    this.pending.length = 0;
    if (this.server.listening) await closeHttpServer(this.server);
  }
}
