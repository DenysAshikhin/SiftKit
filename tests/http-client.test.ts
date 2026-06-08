import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { LlamaClient, LlamaHttpError } from '../src/lib/llama-client.js';

type ServerHandle = {
  baseUrl: string;
  connectionCount: () => number;
  close: () => Promise<void>;
};

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<ServerHandle> {
  const server = http.createServer(handler);
  let connections = 0;
  server.on('connection', () => { connections += 1; });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connectionCount: () => connections,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function writeSse(res: http.ServerResponse, packets: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const packet of packets) {
    res.write(`data: ${packet}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

test('LlamaClient.requestJsonFull opens a fresh socket per sequential call (no keep-alive pooling)', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    await LlamaClient.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 });
    await LlamaClient.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 });
    await LlamaClient.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 });
    // With keep-alive enabled these three sequential requests would reuse one
    // socket (connectionCount === 1). Pooling-disabled => one socket each.
    assert.equal(server.connectionCount(), 3);
  } finally {
    await server.close();
  }
});

test('LlamaClient.streamChatCompletion opens a fresh socket per sequential call', async () => {
  const server = await startServer((req, res) => {
    writeSse(res, [JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })]);
  });
  try {
    await LlamaClient.streamChatCompletion({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {});
    await LlamaClient.streamChatCompletion({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {});
    assert.equal(server.connectionCount(), 2);
  } finally {
    await server.close();
  }
});

test('LlamaClient.streamChatCompletion parses SSE data packets and resolves sawDone after [DONE]', async () => {
  const server = await startServer((req, res) => {
    writeSse(res, [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
    ]);
  });
  try {
    const received: Record<string, unknown>[] = [];
    const result = await LlamaClient.streamChatCompletion(
      { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 },
      (parsed) => { received.push(parsed); },
    );
    assert.equal(result.sawDone, true);
    assert.equal(received.length, 2);
    assert.equal((received[1].choices as Array<{ delta: { content: string } }>)[0].delta.content, 'answer');
  } finally {
    await server.close();
  }
});

test('LlamaClient.streamChatCompletion rejects with LlamaHttpError carrying status and body on >= 400', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('model loading');
  });
  try {
    await assert.rejects(
      LlamaClient.streamChatCompletion({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof LlamaHttpError);
        assert.equal(error.statusCode, 503);
        assert.match(error.rawText, /model loading/u);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('LlamaClient.streamChatCompletion rejects with the abort reason when the signal aborts mid-stream', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    // Keep the connection open without ever sending [DONE].
  });
  try {
    const controller = new AbortController();
    await assert.rejects(
      LlamaClient.streamChatCompletion(
        { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000, abortSignal: controller.signal },
        () => { controller.abort(new Error('caller cancelled the stream')); },
      ),
      /caller cancelled the stream/u,
    );
  } finally {
    await server.close();
  }
});

test('LlamaClient.streamChatCompletion stops and resolves when onData returns "stop"', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'second' } }] })}\n\n`);
    // Never send [DONE]; the caller stops the stream itself.
  });
  try {
    const received: Record<string, unknown>[] = [];
    const result = await LlamaClient.streamChatCompletion(
      { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 },
      (parsed) => {
        received.push(parsed);
        return 'stop';
      },
    );
    assert.equal(received.length, 1);
    assert.equal(result.sawDone, false);
  } finally {
    await server.close();
  }
});

test('LlamaClient.requestJson throws on >= 400', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    await assert.rejects(
      LlamaClient.requestJson({ url: `${server.baseUrl}/tokenize`, method: 'POST', timeoutMs: 5000, body: '{}' }),
      /HTTP 500/u,
    );
  } finally {
    await server.close();
  }
});

test('LlamaClient.requestText returns status and body without throwing on >= 400', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('loading model');
  });
  try {
    const response = await LlamaClient.requestText({ url: `${server.baseUrl}/v1/models`, timeoutMs: 5000 });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /loading model/u);
  } finally {
    await server.close();
  }
});
