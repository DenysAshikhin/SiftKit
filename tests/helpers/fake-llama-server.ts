import http from 'node:http';

import { parseJsonValueText } from '../../src/lib/json.js';
import { JsonRecordReader } from '../../src/lib/json-record-reader.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { getAddressInfo } from './dashboard-http.js';

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, payload: JsonObject): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export type FakeLlamaServerOptions = {
  model: string;
  assistantContent: string;
  /** Raw OpenAI-shaped `usage` block echoed back on every completion. */
  usage: JsonObject;
  charsPerToken?: number;
};

/**
 * Minimal llama.cpp/TabbyAPI-compatible inference backend: enough of the surface
 * (`/v1/models`, `/tokenize`, `/v1/chat/completions`) for a real engine run, with a
 * caller-supplied `usage` block so provider-reported counters can be pinned E2E.
 */
export class FakeLlamaServer {
  private constructor(
    readonly baseUrl: string,
    private readonly server: http.Server,
  ) {}

  static async start(options: FakeLlamaServerOptions): Promise<FakeLlamaServer> {
    const charsPerToken = options.charsPerToken ?? 4;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        sendJson(res, { data: [{ id: options.model }] });
        return;
      }
      if (req.method === 'POST' && req.url === '/tokenize') {
        const bodyText = await readRequestBody(req);
        const parsed = JsonRecordReader.asObject(bodyText ? parseJsonValueText(bodyText) : {}) ?? {};
        const content = String(parsed.content ?? '');
        sendJson(res, { count: content.trim() ? Math.max(1, Math.ceil(content.length / charsPerToken)) : 0 });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const bodyText = await readRequestBody(req);
        const parsed = JsonRecordReader.asObject(bodyText ? parseJsonValueText(bodyText) : {}) ?? {};
        if (parsed.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: options.assistantContent }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: options.usage,
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        sendJson(res, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: options.assistantContent } }],
          usage: options.usage,
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return new FakeLlamaServer(`http://127.0.0.1:${getAddressInfo(server).port}`, server);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
