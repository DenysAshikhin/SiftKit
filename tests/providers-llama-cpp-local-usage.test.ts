import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateLlamaCppChatResponse } from '../src/providers/llama-cpp.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { mockConfig } from './_runtime-helpers.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';

const CONTENT = 'x'.repeat(400);
const REASONING = 'y'.repeat(200);
const USER_MESSAGE = 'count me locally';

type FakeServer = { baseUrl: string; close: () => Promise<void> };

// Non-streaming chat plus a tokenizer that bills every text at 2 chars/token, so
// locally counted values are distinguishable from the provider's usage numbers.
function startFakeServer(): Promise<FakeServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/tokenize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          const content = String(asObject(parseJsonValueText(body || '{}')).content || '');
          res.end(JSON.stringify({ count: Math.ceil(content.length / 2) }));
          return;
        }
        sendChatCompletionSse(res, {
          choices: [{ message: { content: CONTENT, reasoning_content: REASONING } }],
          usage: { prompt_tokens: 999, completion_tokens: 2 },
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('generateLlamaCppChatResponse reports locally counted tokens, not provider usage', async () => {
  const fake = await startFakeServer();
  try {
    const result = await generateLlamaCppChatResponse({
      config: mockConfig({ Runtime: { LlamaCpp: { BaseUrl: fake.baseUrl, NumCtx: 32000 } } }),
      model: 'mock',
      messages: [{ role: 'user', content: USER_MESSAGE }],
      timeoutSeconds: 10,
    });

    assert.equal(result.usage?.completionTokens, 200);
    assert.equal(result.usage?.outputTokens, 200);
    assert.equal(result.usage?.thinkingTokens, 100);
    assert.equal(result.usage?.promptTokens, Math.ceil(USER_MESSAGE.length / 2));
  } finally {
    await fake.close();
  }
});
