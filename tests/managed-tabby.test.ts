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

test('ManagedTabbyRuntime construction requires only engine configuration', () => {
  assert.equal(ManagedTabbyRuntime.length, 1);
});

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
        response.statusCode = 503;
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
  const exl3Preset = {
    ...preset,
    id: 'exl3-a',
    Backend: 'exl3' as const,
    BaseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    Model: 'model-a',
    ModelPath: path.join(root, 'model-a'),
    HealthcheckIntervalMs: 10,
  };
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ConfigPath: 'config.yml',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 2_000,
  });
  try {
    await Promise.all([runtime.ensurePresetReady(exl3Preset), runtime.ensurePresetReady(exl3Preset)]);
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(loadRequests, 1);
    assert.equal(runtime.getModelState(), 'ready');
    await runtime.ensurePresetReady(exl3Preset);
    assert.equal(loadRequests, 1);
    await runtime.unloadPreset();
    assert.equal(runtime.getModelState(), 'unloaded');
    await runtime.unloadPreset();
  } finally {
    await runtime.stopProcess();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Tabby runtime rejects a llama preset before lifecycle work', async () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: '.',
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ConfigPath: 'config.yml',
    ModelRoot: '.',
    AdminApiKey: '',
    ShutdownTimeoutMs: 100,
  });

  await assert.rejects(runtime.ensurePresetReady(preset), /cannot be loaded by the EXL3 runtime/u);
  assert.equal(runtime.getProcessState(), 'stopped');
  assert.equal(runtime.getModelState(), 'unloaded');
});

test('managed Tabby launches with preset environment and uses its startup-loaded model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-'));
  const port = await getFreePort();
  const scriptPath = path.join(root, 'fake-tabby.cjs');
  const argsPath = path.join(root, 'args.json');
  const environmentPath = path.join(root, 'environment.json');
  const loadRequestsPath = path.join(root, 'load-requests.txt');
  fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const environment = {
  TABBY_MODEL_MODEL_DIR: process.env.TABBY_MODEL_MODEL_DIR,
  TABBY_MODEL_MODEL_NAME: process.env.TABBY_MODEL_MODEL_NAME,
  TABBY_MODEL_MAX_SEQ_LEN: process.env.TABBY_MODEL_MAX_SEQ_LEN,
  TABBY_MODEL_CACHE_SIZE: process.env.TABBY_MODEL_CACHE_SIZE,
  TABBY_MODEL_CACHE_MODE: process.env.TABBY_MODEL_CACHE_MODE,
  TABBY_MODEL_MAX_BATCH_SIZE: process.env.TABBY_MODEL_MAX_BATCH_SIZE,
  TABBY_MODEL_CHUNK_SIZE: process.env.TABBY_MODEL_CHUNK_SIZE,
  TABBY_DRAFT_MODEL_DRAFT_MODE: process.env.TABBY_DRAFT_MODEL_DRAFT_MODE,
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: process.env.TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS,
};
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify(environment));
const server = http.createServer((request, response) => {
  if (request.url === '/v1/model/load' && request.method === 'POST') {
    fs.appendFileSync(${JSON.stringify(loadRequestsPath)}, 'load\\n');
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.url === '/v1/model' && request.method === 'GET') {
    response.statusCode = environment.TABBY_MODEL_MODEL_NAME ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(environment.TABBY_MODEL_MODEL_NAME
      ? JSON.stringify({ id: environment.TABBY_MODEL_MODEL_NAME })
      : '{}');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[]}');
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const exl3Preset = {
    ...preset,
    Backend: 'exl3' as const,
    BaseUrl: `http://127.0.0.1:${port}`,
    Model: 'model-a',
    ModelPath: path.join(root, 'model-a'),
    NumCtx: 30_000,
    ParallelSlots: 4,
    UBatchSize: 1_024,
    KvCacheQuantization: 'q8_0/q4_0' as const,
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as const,
    SpeculativeDraftMax: 5,
  };
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  });
  try {
    await runtime.ensurePresetReady(exl3Preset);
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(runtime.getModelState(), 'ready');
    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, 'utf8')), ['--config', path.join(root, 'config.yml')]);
    assert.deepEqual(JSON.parse(fs.readFileSync(environmentPath, 'utf8')), {
      TABBY_MODEL_MODEL_DIR: root,
      TABBY_MODEL_MODEL_NAME: 'model-a',
      TABBY_MODEL_MAX_SEQ_LEN: '30000',
      TABBY_MODEL_CACHE_SIZE: '30208',
      TABBY_MODEL_CACHE_MODE: '8,4',
      TABBY_MODEL_MAX_BATCH_SIZE: '4',
      TABBY_MODEL_CHUNK_SIZE: '1024',
      TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
      TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
    });
    assert.equal(fs.existsSync(loadRequestsPath), false);

    await runtime.unloadPreset();
    assert.equal(runtime.getProcessState(), 'stopped');
    assert.equal(runtime.getModelState(), 'unloaded');
    await runtime.ensurePresetReady(exl3Preset);
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(runtime.getModelState(), 'ready');
    assert.equal(fs.existsSync(loadRequestsPath), false);
  } finally {
    await runtime.stopProcess();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed Tabby reuses identical launch settings and restarts when UBatch size changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-restart-'));
  const port = await getFreePort();
  const scriptPath = path.join(root, 'fake-tabby.cjs');
  const startsPath = path.join(root, 'starts.txt');
  fs.writeFileSync(scriptPath, `
const fs = require('node:fs');
const http = require('node:http');
fs.appendFileSync(${JSON.stringify(startsPath)}, process.pid + '\\n');
const modelName = process.env.TABBY_MODEL_MODEL_NAME || '';
const server = http.createServer((request, response) => {
  if (request.url === '/v1/model/load' && request.method === 'POST') {
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.url === '/v1/model' && request.method === 'GET') {
    response.statusCode = modelName ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(modelName ? JSON.stringify({ id: modelName }) : '{}');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[]}');
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const exl3Preset = {
    ...preset,
    Backend: 'exl3' as const,
    BaseUrl: `http://127.0.0.1:${port}`,
    Model: 'model-a',
    ModelPath: path.join(root, 'model-a'),
    UBatchSize: 1_024,
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as const,
  };
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ConfigPath: 'config.yml',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  });
  try {
    await runtime.ensurePresetReady(exl3Preset);
    await runtime.ensurePresetReady(exl3Preset);
    assert.equal(fs.readFileSync(startsPath, 'utf8').trim().split(/\r?\n/u).length, 1);

    await runtime.ensurePresetReady({ ...exl3Preset, UBatchSize: 2_048 });
    assert.equal(fs.readFileSync(startsPath, 'utf8').trim().split(/\r?\n/u).length, 2);
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
      response.statusCode = resident ? 200 : 503;
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
  });
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
