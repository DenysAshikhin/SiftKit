import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { z } from '../src/lib/zod.js';
import {
  HttpClient,
  LlamaHttpError,
  DEFAULT_USER_AGENT,
  CONNECT_TIMEOUT_MS,
} from '../src/lib/http-client.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';

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
  const address = getAddressInfo(server);
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

test('HttpClient.requestJsonFull opens a fresh socket per sequential call (no keep-alive pooling)', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    await client.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 }, JsonObjectSchema);
    await client.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 }, JsonObjectSchema);
    await client.requestJsonFull({ url: `${server.baseUrl}/v1/models`, method: 'GET', timeoutMs: 5000 }, JsonObjectSchema);
    // With keep-alive enabled these three sequential requests would reuse one
    // socket (connectionCount === 1). Pooling-disabled => one socket each.
    assert.equal(server.connectionCount(), 3);
  } finally {
    await server.close();
  }
});

test('HttpClient.streamSse opens a fresh socket per sequential call', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    writeSse(res, [JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })]);
  });
  try {
    await client.streamSse({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {});
    await client.streamSse({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {});
    assert.equal(server.connectionCount(), 2);
  } finally {
    await server.close();
  }
});

test('HttpClient.streamSse parses SSE data packets and resolves sawDone after [DONE]', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    writeSse(res, [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
    ]);
  });
  try {
    const received: JsonObject[] = [];
    const result = await client.streamSse(
      { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 },
      (parsed) => { received.push(parsed); },
    );
    assert.equal(result.sawDone, true);
    assert.equal(received.length, 2);
    assert.equal(String(asObject(asObject(asObjectArray(received[1].choices)[0]).delta).content), 'answer');
  } finally {
    await server.close();
  }
});

test('HttpClient.streamSse parses CRLF-delimited Tabby SSE packets', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tabby' } }] })}\r\n\r\n`);
    res.end('data: [DONE]\r\n\r\n');
  });
  try {
    const received: JsonObject[] = [];
    const result = await client.streamSse(
      { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 },
      (parsed) => { received.push(parsed); },
    );
    assert.equal(result.sawDone, true);
    assert.equal(received.length, 1);
    assert.equal(String(asObject(asObject(asObjectArray(received[0].choices)[0]).delta).content), 'tabby');
  } finally {
    await server.close();
  }
});

test('HttpClient.streamSse rejects with LlamaHttpError carrying status and body on >= 400', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('model loading');
  });
  try {
    await assert.rejects(
      client.streamSse({ url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000 }, () => {}),
      (error) => {
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

test('HttpClient.streamSse rejects with the abort reason when the signal aborts mid-stream', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    // Keep the connection open without ever sending [DONE].
  });
  try {
    const controller = new AbortController();
    await assert.rejects(
      client.streamSse(
        { url: `${server.baseUrl}/v1/chat/completions`, body: '{}', timeoutMs: 5000, abortSignal: controller.signal },
        () => { controller.abort(new Error('caller cancelled the stream')); },
      ),
      /caller cancelled the stream/u,
    );
  } finally {
    await server.close();
  }
});

test('HttpClient.streamSse stops and resolves when onData returns "stop"', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'second' } }] })}\n\n`);
    // Never send [DONE]; the caller stops the stream itself.
  });
  try {
    const received: JsonObject[] = [];
    const result = await client.streamSse(
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

test('HttpClient.requestJson throws on >= 400', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    await assert.rejects(
      client.requestJson({ url: `${server.baseUrl}/tokenize`, method: 'POST', timeoutMs: 5000, body: '{}' }, JsonObjectSchema),
      /HTTP 500/u,
    );
  } finally {
    await server.close();
  }
});

test('HttpClient.requestText returns status and body without throwing on >= 400', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('loading model');
  });
  try {
    const response = await client.requestText({ url: `${server.baseUrl}/v1/models`, timeoutMs: 5000 });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /loading model/u);
  } finally {
    await server.close();
  }
});

test('HttpClient.localAgent returns shared keepAlive false agents selected by protocol', () => {
  const client = new HttpClient();
  // http.Agent stores its constructor options at runtime, but @types/node does not expose
  // `.options` on the public Agent type; read it through the runtime-accurate shape.
  type AgentWithOptions = http.Agent & { options: { keepAlive: boolean } };
  const AgentWithOptionsSchema = z.custom<AgentWithOptions>((value) => value instanceof http.Agent);
  const httpAgent = AgentWithOptionsSchema.parse(client.localAgent('http://127.0.0.1:8080'));
  const secondHttpAgent = client.localAgent(new URL('http://127.0.0.1:8081'));
  const httpsAgent = AgentWithOptionsSchema.parse(client.localAgent('https://127.0.0.1:8443'));

  assert.equal(httpAgent, secondHttpAgent);
  assert.equal(httpAgent.options.keepAlive, false);
  assert.equal(httpsAgent.options.keepAlive, false);
  assert.notEqual(httpAgent, httpsAgent);
});

test('HttpClient.fetch injects default User-Agent and allows per-call override', async () => {
  const seenUserAgents: string[] = [];
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    seenUserAgents.push(String(req.headers['user-agent'] || ''));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  try {
    await client.fetch(`${server.baseUrl}/first`);
    await client.fetch(`${server.baseUrl}/second`, { headers: { 'User-Agent': 'CustomAgent/1.0' } });

    assert.equal(seenUserAgents[0], DEFAULT_USER_AGENT);
    assert.equal(seenUserAgents[1], 'CustomAgent/1.0');
  } finally {
    await server.close();
  }
});

test('HttpClient.fetch aborts at timeoutMs while preserving caller aborts', async () => {
  const client = new HttpClient();
  const server = await startServer((req, res) => {
    if (req.url === '/hang') {
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  try {
    await assert.rejects(
      client.fetch(`${server.baseUrl}/hang`, { timeoutMs: 10 }),
      /aborted|AbortError|timeout/i,
    );

    const controller = new AbortController();
    controller.abort(new Error('caller aborted fetch'));
    await assert.rejects(
      client.fetch(`${server.baseUrl}/ok`, { signal: controller.signal, timeoutMs: 5000 }),
      /caller aborted fetch|aborted|AbortError/i,
    );
  } finally {
    await server.close();
  }
});

test('HttpClient exposes fetch transport constants for centralized undici policy', () => {
  assert.equal(CONNECT_TIMEOUT_MS, 20_000);
  assert.match(DEFAULT_USER_AGENT, /Chrome\//u);
});
