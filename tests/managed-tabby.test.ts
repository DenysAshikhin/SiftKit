import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { getFreePort } from './_runtime-helpers.js';

test('managed Tabby starts in its configured working directory and requires the expected model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-'));
  const port = await getFreePort();
  const scriptPath = path.join(root, 'fake-tabby.cjs');
  fs.writeFileSync(scriptPath, `
const http = require('node:http');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/models') {
    response.end(JSON.stringify({ data: [{ id: '3.6_27B' }] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');

  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    BaseUrl: `http://127.0.0.1:${port}`,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelId: '3.6_27B',
    StartupTimeoutMs: 5_000,
    HealthcheckTimeoutMs: 500,
    HealthcheckIntervalMs: 20,
    ShutdownTimeoutMs: 5_000,
  });

  try {
    await runtime.start();
    assert.equal(runtime.getState(), 'ready');
    assert.equal(runtime.getModelId(), '3.6_27B');
  } finally {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(runtime.getState(), 'stopped');
});
