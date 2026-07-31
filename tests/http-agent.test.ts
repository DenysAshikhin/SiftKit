import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';

import { getAddressInfo, requestJson, requestSse as requestCollectedSse } from './helpers/dashboard-http.js';
import { requestJson as requestRuntimeJson } from './helpers/runtime-http.js';
import { requestSse, writeSseResult } from './helpers/sse-http.js';

/**
 * Answers `/health` as JSON and `/events` as SSE, and can drop every connection it has accepted.
 * Dropping is what an HTTP server does to an idle keep-alive socket once `keepAliveTimeout`
 * elapses, so this reproduces that without depending on a 5-second pause.
 */
class DroppableServer {
  private readonly sockets = new Set<Socket>();

  private readonly server = http.createServer((request, response) => {
    if (request.url === '/events') {
      writeSseResult(response, { ok: true });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });

  async listen(): Promise<string> {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${getAddressInfo(this.server).port}`;
  }

  dropAcceptedConnections(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// The drop and the next request happen in the same tick, so the client cannot have observed the
// close. A client that pools connections reuses the dead one and fails with `read ECONNRESET`;
// that is the flake this guards against.
test('a test request succeeds after the server drops the connection the previous one used', async () => {
  const server = new DroppableServer();
  const baseUrl = await server.listen();
  try {
    const first = await requestJson(`${baseUrl}/health`, { timeoutMs: 2000 });
    assert.equal(first.statusCode, 200);

    server.dropAcceptedConnections();
    const second = await requestJson(`${baseUrl}/health`, { timeoutMs: 2000 });

    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.body, { ok: true });
  } finally {
    await server.close();
  }
});

// One helper left on `http.globalAgent` is enough to bring the flake back, so every shared
// client is checked rather than only the one that failed.
test('no shared test HTTP client leaves a socket pooled on the global agent', async () => {
  const server = new DroppableServer();
  const baseUrl = await server.listen();
  try {
    await requestJson(`${baseUrl}/health`, { timeoutMs: 2000 });
    await requestRuntimeJson(`${baseUrl}/health`);
    await requestCollectedSse(`${baseUrl}/events`, { timeoutMs: 2000 });
    await requestSse(`${baseUrl}/events`, { body: { ping: true }, timeoutMs: 2000 });

    assert.deepEqual(Object.keys(http.globalAgent.freeSockets), []);
  } finally {
    await server.close();
  }
});
