import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SseResponseWriter } from '../src/status-server/sse-response-writer.js';
import { SseFrameParser, type SseFrame } from '../src/lib/sse-frame-parser.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { testHttpAgent } from './helpers/http-agent.js';

test('large snapshot frames drain in bounded chunks without heartbeats corrupting their data', async () => {
  const data = JSON.stringify({ text: '🧭'.repeat(3 * 1024 * 1024) });
  let peakBufferedBytes = 0;
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 1 });
    const sample = setInterval(() => { peakBufferedBytes = Math.max(peakBufferedBytes, res.writableLength); }, 1);
    writer.open();
    void writer.writeSerializedEventAndDrain('snapshot', data).then(() => writer.end()).finally(() => clearInterval(sample));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [{ event: 'snapshot', data }]);
    assert.ok(peakBufferedBytes <= 256 * 1024, `Buffered ${peakBufferedBytes} bytes`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('disconnect during a draining snapshot settles the writer', { timeout: 3000 }, async () => {
  const writes: Promise<boolean>[] = [];
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res);
    writer.open();
    writes.push(writer.writeSerializedEventAndDrain('snapshot', JSON.stringify({ text: 'x'.repeat(16 * 1024 * 1024) }))
      .finally(() => writer.end()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${getAddressInfo(server).port}/`, { agent: testHttpAgent }, response => {
        response.once('data', () => { request.destroy(); resolve(); });
      });
      request.on('error', reject);
      request.end();
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const pending = writes[0];
    assert.ok(pending);
    assert.equal(await pending, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

function collectFrames(baseUrl: string): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const parser = new SseFrameParser();
    const request = http.request(`${baseUrl}/`, { method: 'POST', agent: testHttpAgent }, (response) => {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => frames.push(...parser.push(chunk)));
      response.on('end', () => resolve(frames));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('writes framed events and ends cleanly', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writer.open();
    writer.writeEvent('progress', { kind: 'llm_start', turn: 1 });
    writer.writeEvent('result', { ok: true });
    writer.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [
      { event: 'progress', data: '{"kind":"llm_start","turn":1}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('emits heartbeat comments while idle', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 50 });
    writer.open();
    setTimeout(() => {
      writer.writeEvent('result', { ok: true });
      writer.end();
    }, 180);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = getAddressInfo(server).port;
    const raw = await new Promise<string>((resolve, reject) => {
      let result = '';
      const request = http.request(`http://127.0.0.1:${port}/`, { method: 'POST', agent: testHttpAgent }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { result += chunk; });
        response.on('end', () => resolve(result));
      });
      request.on('error', reject);
      request.end();
    });
    assert.match(raw, /: hb\n\n/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('suppresses writes after client disconnect and reports it', async () => {
  const writerRef: { value?: SseResponseWriter } = {};
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writerRef.value = writer;
    writer.open();
    writer.writeEvent('progress', { kind: 'a' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = getAddressInfo(server).port;
    await new Promise<void>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${port}/`, { method: 'POST', agent: testHttpAgent }, (response) => {
        response.on('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', reject);
      request.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const writer = writerRef.value;
    assert.ok(writer);
    assert.equal(writer.isClientDisconnected(), true);
    writer.writeEvent('progress', { kind: 'b' });
    writer.end();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('writes a pre-serialized frame without re-encoding it', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writer.open();
    writer.writeSerializedEvent('thinking', '{"turn":0,"offset":0,"text":"replayed"}');
    writer.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [
      { event: 'thinking', data: '{"turn":0,"offset":0,"text":"replayed"}' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a bounded frame is submitted whole before its drain wait and refuses an oversized frame', async () => {
  const data = JSON.stringify({ text: 'y'.repeat(60 * 1024) });
  const wire = `event: chat_projection\ndata: ${data}\n\n`;
  let bufferedAtDrainWait = -1;
  const oversized: Error[] = [];
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writer.open();
    // A 1-byte high-water mark forces the first write to report backpressure before anything drains.
    res.socket?.setNoDelay(true);
    Object.defineProperty(res, 'writableHighWaterMark', { value: 1 });
    void (async () => {
      try {
        await writer.writeBoundedSerializedEventAndDrain('chat_projection', data, 4 * 1024);
      } catch (error) {
        oversized.push(error instanceof Error ? error : new Error(String(error)));
      }
      const pending = writer.writeBoundedSerializedEventAndDrain('chat_projection', data, 64 * 1024);
      bufferedAtDrainWait = res.writableLength;
      await pending;
      writer.end();
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [{ event: 'chat_projection', data }]);
    assert.match(oversized[0]?.message ?? '', /exceeds its 4096-byte bound/u);
    // Everything (plus chunked-encoding framing) was handed to the socket synchronously; only the drain was awaited.
    assert.ok(bufferedAtDrainWait === 0 || bufferedAtDrainWait >= Buffer.byteLength(wire, 'utf8'), `buffered ${String(bufferedAtDrainWait)}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
