import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import {
  closeHttpServer,
  requestJson,
  getAddressInfo,
  requestSse,
  writeJson,
} from './helpers/dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

test('dashboard HTTP helpers read JSON and SSE payloads', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      res.write('event: message\n');
      res.write('data: {"step":"working"}\n\n');
      res.write('event: done\n');
      res.write('data: {"ok":true}\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    assert.deepEqual(await requestJson(`${baseUrl}/json`), {
      statusCode: 200,
      body: { ok: true },
    });
    const sse = await requestSse(`${baseUrl}/events`);
    assert.equal(sse.statusCode, 200);
    assert.deepEqual(
      sse.events.map(({ event, payload }) => ({ event, payload })),
      [
        { event: 'message', payload: { step: 'working' } },
        { event: 'done', payload: { ok: true } },
      ],
    );
    assert.equal(sse.events.every((event) => Number.isFinite(event.receivedAtMs)), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('dashboard SSE requests reject at the absolute deadline while frames continue', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
    });
    response.write(': connected\n\n');
    const chatter = setInterval(() => response.write(': still-open\n\n'), 10);
    const failSafe = setTimeout(() => response.end(), 500);
    response.once('close', () => {
      clearInterval(chatter);
      clearTimeout(failSafe);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = getAddressInfo(server);
  try {
    await assert.rejects(
      requestSse(`http://127.0.0.1:${port}/events`, { timeoutMs: 75 }),
      /request timeout/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('http server close rejects connections accepted while underlying close is delayed', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
    });
    response.write('hold');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const originalClose = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void): http.Server => {
    const delayedClose = setTimeout(() => originalClose(callback), 120);
    delayedClose.unref();
    return server;
  };

  let abortClient = (): void => {};
  let closePromise: Promise<void> | null = null;
  try {
    const { port } = getAddressInfo(server);
    closePromise = closeHttpServer(server);
    await delay(20);
    const clientSettled = new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const request = http.get(`http://127.0.0.1:${port}`, (response) => {
        response.resume();
        response.once('close', settle);
        response.once('end', settle);
        response.once('error', settle);
      });
      request.once('error', settle);
      abortClient = () => request.destroy();
    });
    const closedPromptly = await Promise.race([
      Promise.all([closePromise, clientSettled]).then(() => true),
      delay(500, false, { ref: false }),
    ]);
    if (!closedPromptly) {
      abortClient();
      server.closeAllConnections();
      await Promise.allSettled([closePromise, clientSettled]);
    }
    await closePromise;
    await clientSettled;
    assert.equal(closedPromptly, true);
  } finally {
    abortClient();
    server.closeAllConnections();
    if (closePromise !== null) {
      await Promise.allSettled([closePromise]);
    }
    server.close = originalClose;
  }
});

test('dashboard file helpers write JSON payloads', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-http-');
  const nestedPath = path.join(tempRoot, 'logs', 'entry.json');

  writeJson(nestedPath, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(nestedPath, 'utf8')), { ok: true });

  await removeDirectoryWithRetries(tempRoot);
});
