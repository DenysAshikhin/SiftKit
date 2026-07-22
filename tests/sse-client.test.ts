import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SseClient } from '../src/lib/sse-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${getAddressInfo(server).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('yields frames in order and completes on stream end', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
    res.write('event: result\ndata: {"ok":true}\n\n');
    res.end();
  }, async (baseUrl) => {
    const frames: SseFrame[] = [];
    for await (const frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5_000 })) {
      frames.push(frame);
    }
    assert.deepEqual(frames, [
      { event: 'progress', data: '{"kind":"a"}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  });
});

test('throws HTTP-prefixed error on non-2xx status', async () => {
  await withServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"Expected prompt."}');
  }, async (baseUrl) => {
    const iterate = async (): Promise<void> => {
      for await (const _frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5_000 })) {
        // Drain the stream.
      }
    };
    await assert.rejects(iterate, { message: /^HTTP 400: \{"error":"Expected prompt\."\}/u });
  });
});

test('idle timeout destroys a silent stream', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
  }, async (baseUrl) => {
    const iterate = async (): Promise<void> => {
      for await (const _frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 200 })) {
        // Drain the stream.
      }
    };
    await assert.rejects(iterate, /timed out after 200 ms/u);
  });
});

test('heartbeat comments reset the idle timer without yielding frames', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
      res.write(': hb\n\n');
      if (beats === 4) {
        clearInterval(timer);
        res.write('event: result\ndata: {"ok":true}\n\n');
        res.end();
      }
    }, 100);
  }, async (baseUrl) => {
    const frames: SseFrame[] = [];
    for await (const frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 250 })) {
      frames.push(frame);
    }
    assert.deepEqual(frames, [{ event: 'result', data: '{"ok":true}' }]);
  });
});

test('breaking out of iteration destroys the socket', async () => {
  let closed = false;
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
    req.on('close', () => { closed = true; });
  }, async (baseUrl) => {
    for await (const _frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5_000 })) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, true);
  });
});
