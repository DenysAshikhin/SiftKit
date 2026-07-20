import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { getFreePort } from './_runtime-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

test('concurrent Tabby readiness calls perform one model load and unload explicitly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-tabby-model-'));
  let resident = false;
  let loadRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"object":"list","data":[]}');
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/load') {
      loadRequests += 1;
      setTimeout(() => {
        resident = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      }, 20);
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/unload') {
      resident = false;
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.url === '/v1/model') {
      if (!resident) {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{"id":"model-a"}');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ConfigPath: 'config.yml',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 2_000,
  }, {
    ...preset,
    id: 'exl3-a',
    Backend: 'exl3',
    BaseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    Model: 'model-a',
    ModelPath: path.join(root, 'model-a'),
    HealthcheckIntervalMs: 10,
  });
  try {
    await runtime.startProcess();
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(runtime.getModelState(), 'unloaded');
    await Promise.all([runtime.ensurePresetReady({ ...preset, id: 'exl3-a', Backend: 'exl3', BaseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`, Model: 'model-a', ModelPath: path.join(root, 'model-a') }), runtime.ensurePresetReady({ ...preset, id: 'exl3-a', Backend: 'exl3', BaseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`, Model: 'model-a', ModelPath: path.join(root, 'model-a') })]);
    assert.equal(loadRequests, 1);
    assert.equal(runtime.getModelState(), 'ready');
    await runtime.unloadPreset();
    assert.equal(runtime.getModelState(), 'unloaded');
  } finally {
    await runtime.stopProcess();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed Tabby launches with the resolved ConfigPath while process readiness permits no loaded model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-'));
  const port = await getFreePort();
  const scriptPath = path.join(root, 'fake-tabby.cjs');
  const argsPath = path.join(root, 'args.json');
  fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[]}');
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
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  }, { ...preset, Backend: 'exl3', BaseUrl: `http://127.0.0.1:${port}` });
  try {
    await runtime.startProcess();
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(runtime.getModelState(), 'unloaded');
    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, 'utf8')), ['--config', path.join(root, 'config.yml')]);
  } finally {
    await runtime.stopProcess();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external EXL3 preset does not launch the configured managed Tabby process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-external-tabby-'));
  const launchedPath = path.join(root, 'managed-launched.txt');
  const scriptPath = path.join(root, 'must-not-launch.cjs');
  fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(launchedPath)}, 'launched');
setInterval(() => {}, 1000);
`, 'utf8');
  let resident = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":[]}');
      return;
    }
    if (request.url === '/v1/model' && request.method === 'GET') {
      response.statusCode = resident ? 200 : 400;
      response.setHeader('content-type', 'application/json');
      response.end(resident ? '{"id":"model-a"}' : '{}');
      return;
    }
    if (request.url === '/v1/model/load' && request.method === 'POST') {
      resident = true;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      return;
    }
    if (request.url === '/v1/model/unload' && request.method === 'POST') {
      resident = false;
      response.statusCode = 200;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const externalPreset = {
    ...preset,
    id: 'external-exl3',
    Backend: 'exl3' as const,
    ExternalServerEnabled: true,
    BaseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    Model: 'model-a',
    ModelPath: path.join(root, 'model-a'),
  };
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 2_000,
  }, externalPreset);
  try {
    await runtime.ensurePresetReady(externalPreset);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(launchedPath), false);
  } finally {
    await runtime.unloadPreset();
    await runtime.stopProcess();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
