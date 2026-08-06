import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { requestSse } from './helpers/sse-http.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

const CLIENT_DEADLINE_MS = 1_000;

/**
 * Streams progress frames forever without ever sending a terminal frame.
 *
 * `request.setTimeout` measures socket inactivity, so a stream that keeps producing resets it on
 * every frame and the request runs unbounded — the one stall an inactivity timeout structurally
 * cannot catch. `timeoutMs` has to mean a deadline measured from the request, not a silence
 * threshold, for a caller to be able to rely on it.
 */
function startChattySseServer(): Promise<http.Server> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const heartbeat = setInterval(() => {
      response.write('event: progress\ndata: {"kind":"lock_wait"}\n\n');
    }, 100);
    response.on('close', () => clearInterval(heartbeat));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('requestSse rejects on its deadline even while the stream keeps sending frames', async (t) => {
  const server = await startChattySseServer();
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      requestSse(`${baseUrl}/stalls`, { body: { prompt: 'x' }, timeoutMs: CLIENT_DEADLINE_MS }),
      /timed out/u,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 10_000, `deadline did not fire promptly; took ${elapsedMs}ms`);
  } finally {
    await stopServer(server);
  }
});

test('requestSse still returns a stream that completes within its deadline', async (t) => {
  const server = await new Promise<http.Server>((resolve) => {
    const created = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: progress\ndata: {"kind":"started"}\n\n');
      response.write('event: result\ndata: {"ok":true}\n\n');
      response.end();
    });
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const response = await requestSse(`${baseUrl}/ok`, { body: {}, timeoutMs: 10_000 });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.result, { ok: true });
    assert.equal(response.progress.length, 1);
  } finally {
    await stopServer(server);
  }
});

// server.close() stops the listener but waits for open connections, and its callback never fires
// while one is held. Harness teardown awaits that callback, so without dropping connections first
// it hangs on exactly the stuck stream it exists to clean up.
test('startHarness teardown completes while a client connection is still open', async (t) => {
  const harness = await startHarness('siftkit-harness-close-', t);
  const { port } = new URL(harness.baseUrl);
  const heldConnection = net.connect(Number(port), '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    heldConnection.on('connect', resolve);
    heldConnection.on('error', reject);
  });
  try {
    const startedAt = Date.now();
    await harness.close();
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 10_000, `harness.close() did not complete promptly; took ${elapsedMs}ms`);
  } finally {
    heldConnection.destroy();
  }
});
