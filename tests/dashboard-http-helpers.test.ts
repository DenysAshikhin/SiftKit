import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  requestJson,
  requestSse,
  writeJson,
  removeDirectoryWithRetries,
} from './helpers/dashboard-http.ts';

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
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    assert.deepEqual(await requestJson(`${baseUrl}/json`), {
      statusCode: 200,
      body: { ok: true },
    });
    assert.deepEqual(await requestSse(`${baseUrl}/events`), {
      statusCode: 200,
      events: [
        { event: 'message', payload: { step: 'working' } },
        { event: 'done', payload: { ok: true } },
      ],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('dashboard file helpers write JSON payloads and remove directories', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-http-'));
  const nestedPath = path.join(tempRoot, 'logs', 'entry.json');

  writeJson(nestedPath, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(nestedPath, 'utf8')), { ok: true });

  await removeDirectoryWithRetries(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false);
});
