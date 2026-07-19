import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getFreePort } from './_runtime-helpers.js';

async function assertPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Port ${port} remained reachable.`);
}

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

  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelRoot: root,
    ShutdownTimeoutMs: 5_000,
  }, {
    ...preset,
    Backend: 'exl3',
    BaseUrl: `http://127.0.0.1:${port}`,
    Model: '3.6_27B',
    StartupTimeoutMs: 5_000,
    HealthcheckTimeoutMs: 500,
    HealthcheckIntervalMs: 20,
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
  await assertPortClosed(port);
});

test('failed readiness terminates Tabby before rollback can start another runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-failure-'));
  const port = await getFreePort();
  const scriptPath = path.join(root, 'wrong-model.cjs');
  fs.writeFileSync(scriptPath, `
const http = require('node:http');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ data: [{ id: 'wrong-model' }] }));
});
server.listen(${port}, '127.0.0.1');
`, 'utf8');
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelRoot: root,
    ShutdownTimeoutMs: 2_000,
  }, {
    ...preset,
    Backend: 'exl3',
    BaseUrl: `http://127.0.0.1:${port}`,
    Model: '3.6_27B',
    StartupTimeoutMs: 150,
    HealthcheckTimeoutMs: 50,
    HealthcheckIntervalMs: 20,
  });

  try {
    await assert.rejects(runtime.start(), /Timed out waiting for TabbyAPI model/u);
    await assertPortClosed(port);
    assert.equal(runtime.getState(), 'failed');
  } finally {
    runtime.stopForProcessExitSync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
