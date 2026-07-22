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
import { FakeTabbyModelState } from './helpers/tabby-fake.js';

test('ManagedTabbyRuntime construction requires only engine configuration', () => {
  assert.equal(ManagedTabbyRuntime.length, 1);
});

test('concurrent Tabby readiness calls perform one model load and unload explicitly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-tabby-model-'));
  const model = new FakeTabbyModelState();
  let loadRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"object":"list","data":[]}');
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/load') {
      loadRequests += 1;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => setTimeout(() => {
        model.applyLoad(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      }, 20));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/unload') {
      model.clear();
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.url === '/v1/model') {
      model.respondCurrentModel(response);
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
    ModelRoot: '.',
    AdminApiKey: '',
    ShutdownTimeoutMs: 100,
  });

  await assert.rejects(runtime.ensurePresetReady(preset), /cannot be loaded by the EXL3 runtime/u);
  assert.equal(runtime.getProcessState(), 'stopped');
  assert.equal(runtime.getModelState(), 'unloaded');
});

interface FakeTabbyFiles {
  scriptPath: string;
  argsPath: string;
  environmentPath: string;
  loadRequestsPath: string;
  startsPath: string;
}

/**
 * Fake TabbyAPI that reports the model card its launch environment produced, so the runtime's
 * resident-parameter verification is exercised end to end. `appliedMaxSeqLen` simulates a server
 * that silently clamps the requested context.
 */
function writeFakeTabby(
  root: string,
  port: number,
  appliedMaxSeqLen: number | null,
  options: { announceDrafting: boolean } = { announceDrafting: true },
): FakeTabbyFiles {
  const files: FakeTabbyFiles = {
    scriptPath: path.join(root, 'fake-tabby.cjs'),
    argsPath: path.join(root, 'args.json'),
    environmentPath: path.join(root, 'environment.json'),
    loadRequestsPath: path.join(root, 'load-requests.txt'),
    startsPath: path.join(root, 'starts.txt'),
  };
  fs.writeFileSync(files.scriptPath, `
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(files.argsPath)}, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(${JSON.stringify(files.startsPath)}, process.pid + '\\n');
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
  TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: process.env.TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE,
  EXL3_QC_ATTN: process.env.EXL3_QC_ATTN,
};
fs.writeFileSync(${JSON.stringify(files.environmentPath)}, JSON.stringify(environment));
if (${JSON.stringify(options.announceDrafting)} && environment.TABBY_DRAFT_MODEL_DRAFT_MODE === 'mtp') {
  console.log('INFO: Using main model MTP component for drafting');
}
const card = environment.TABBY_MODEL_MODEL_NAME ? {
  id: environment.TABBY_MODEL_MODEL_NAME,
  parameters: {
    max_seq_len: ${appliedMaxSeqLen === null ? 'Number(environment.TABBY_MODEL_MAX_SEQ_LEN)' : String(appliedMaxSeqLen)},
    cache_size: Number(environment.TABBY_MODEL_CACHE_SIZE),
    chunk_size: Number(environment.TABBY_MODEL_CHUNK_SIZE),
  },
} : null;
const server = http.createServer((request, response) => {
  if (request.url === '/v1/model/load' && request.method === 'POST') {
    fs.appendFileSync(${JSON.stringify(files.loadRequestsPath)}, 'load\\n');
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.url === '/v1/model' && request.method === 'GET') {
    if (!card) {
      response.statusCode = 503;
      response.end('No models are currently loaded');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(card));
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[]}');
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');
  return files;
}

test('managed Tabby launches with preset environment and uses its startup-loaded model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-'));
  const port = await getFreePort();
  const { scriptPath, argsPath, environmentPath, loadRequestsPath } = writeFakeTabby(root, port, null);
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
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  });
  try {
    await runtime.ensurePresetReady(exl3Preset);
    assert.equal(runtime.getProcessState(), 'ready');
    assert.equal(runtime.getModelState(), 'ready');
    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, 'utf8')), []);
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
      TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8',
      EXL3_QC_ATTN: '0',
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

test('managed Tabby rejects a startup-loaded model whose applied context diverges from the preset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-clamped-'));
  const port = await getFreePort();
  const { scriptPath } = writeFakeTabby(root, port, 84_992);
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  });
  try {
    await assert.rejects(runtime.ensurePresetReady({
      ...preset,
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${port}`,
      Model: 'model-a',
      ModelPath: path.join(root, 'model-a'),
      NumCtx: 150_000,
    }), /max_seq_len expected 150000 but Tabby applied 84992/u);
    assert.equal(runtime.getModelState(), 'failed');
  } finally {
    await runtime.stopProcess();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed Tabby reuses identical launch settings and restarts when UBatch size changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-restart-'));
  const port = await getFreePort();
  const { scriptPath, startsPath } = writeFakeTabby(root, port, null);
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

test('unmanaged EXL3 preset with speculation fails loud instead of silently losing MTP', async () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: '.',
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ModelRoot: '.',
    AdminApiKey: '',
    ShutdownTimeoutMs: 100,
  });

  await assert.rejects(runtime.ensurePresetReady({
    ...preset,
    id: 'external-mtp',
    Backend: 'exl3' as const,
    BaseUrl: 'http://127.0.0.1:1',
    Model: 'model-a',
    ModelPath: path.join('.', 'model-a'),
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as const,
  }), /cannot enable MTP drafting/u);
});

test('managed Tabby rejects a speculative preset when the startup log never reports MTP drafting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-managed-tabby-no-mtp-'));
  const port = await getFreePort();
  const { scriptPath } = writeFakeTabby(root, port, null, { announceDrafting: false });
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  });
  try {
    await assert.rejects(runtime.ensurePresetReady({
      ...preset,
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${port}`,
      Model: 'model-a',
      ModelPath: path.join(root, 'model-a'),
      SpeculativeEnabled: true,
      SpeculativeType: 'draft-mtp' as const,
    }), /startup log never reported the MTP draft component/u);
    assert.equal(runtime.getModelState(), 'failed');
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
  const model = new FakeTabbyModelState();
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":[]}');
      return;
    }
    if (request.url === '/v1/model' && request.method === 'GET') {
      model.respondCurrentModel(response);
      return;
    }
    if (request.url === '/v1/model/load' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        model.applyLoad(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      });
      return;
    }
    if (request.url === '/v1/model/unload' && request.method === 'POST') {
      model.clear();
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
