import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';

import { acquireChildPortLease, withTempEnv } from './_runtime-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { FakeTabbyModelState, writeFakeTabby } from './helpers/tabby-fake.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

async function createManagedTabbyFixture(root: string, leaseName: string) {
  const portLease = await acquireChildPortLease(leaseName);
  const fakeTabby = writeFakeTabby(root, portLease.port, null);
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const exl3Preset = {
    ...preset,
    Backend: 'exl3' as const,
    BaseUrl: `http://127.0.0.1:${portLease.port}`,
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
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: fakeTabby.pythonPath,
    Entrypoint: path.basename(fakeTabby.scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  }, flushQueue, fakeTabby.capabilities);

  return {
    ...fakeTabby,
    exl3Preset,
    runtime,
    async [Symbol.asyncDispose]() {
      await runtime.stopProcess();
      await flushQueue.close();
      await portLease[Symbol.asyncDispose]();
    },
  };
}

function countStarts(startsPath: string): number {
  return fs.readFileSync(startsPath, 'utf8').trim().split(/\r?\n/u).length;
}

test('ManagedTabbyRuntime construction requires engine configuration and a flush queue', () => {
  assert.equal(ManagedTabbyRuntime.length, 2);
});

test('concurrent Tabby readiness calls perform one model load and unload explicitly', async () => {
  await withTempEnv(async (root) => {
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
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: false,
      WorkingDirectory: root,
      PythonPath: process.execPath,
      Entrypoint: 'unused',
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 2_000,
    }, flushQueue);
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
      await flushQueue.close();
    }
  });
});

test('Tabby runtime rejects a llama preset before lifecycle work', async () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: '.',
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ModelRoot: '.',
    AdminApiKey: '',
    ShutdownTimeoutMs: 100,
  }, flushQueue);

  await assert.rejects(runtime.ensurePresetReady(preset), /cannot be loaded by the EXL3 runtime/u);
  assert.equal(runtime.getProcessState(), 'stopped');
  assert.equal(runtime.getModelState(), 'unloaded');
});

test('managed Tabby launches with the complete preset environment', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-launch');

    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.argsPath, 'utf8')), []);
    // Every TABBY_*/EXL3_* variable the child actually received, so a preset knob that never
    // reaches the process is a failure here rather than something only a live run would catch.
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.environmentPath, 'utf8')), {
        TABBY_MODEL_MODEL_DIR: root,
        TABBY_MODEL_MODEL_NAME: 'model-a',
        TABBY_MODEL_MAX_SEQ_LEN: '30000',
        TABBY_MODEL_CACHE_SIZE: '30208',
        TABBY_MODEL_CACHE_MODE: '8,4',
        TABBY_MODEL_MAX_BATCH_SIZE: '4',
        TABBY_MODEL_CHUNK_SIZE: '1024',
        TABBY_MEMORY_SYSMEM_KV_CACHE: String(fixture.exl3Preset.CacheRam),
        TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(fixture.exl3Preset.CacheRecurrentRam),
        TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
        TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
        TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8',
        TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: 'true',
        TABBY_MODEL_VISION: 'false',
        EXL3_QC_ATTN: '0',
    });
    assert.equal(fs.existsSync(fixture.loadRequestsPath), false);
  });
});

test('managed Tabby reuses a process when preset settings are unchanged', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-reuse');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(countStarts(fixture.startsPath), 1);
  });
});

test('managed Tabby restarts for changed settings and after an explicit unload', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-restart');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, UBatchSize: 2_048 });
    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(countStarts(fixture.startsPath), 2);

    await fixture.runtime.unloadPreset();
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
    assert.equal(fixture.runtime.getModelState(), 'unloaded');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(countStarts(fixture.startsPath), 3);
    assert.equal(fs.existsSync(fixture.loadRequestsPath), false);
  });
});

test('managed Tabby rejects a startup-loaded model whose applied context diverges from the preset', async () => {
  await withTempEnv(async (root) => {
    await using portLease = await acquireChildPortLease('managed-tabby');
    const port = portLease.port;
    const { scriptPath, pythonPath, capabilities } = writeFakeTabby(root, port, 84_992);
    const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
    if (!preset) throw new Error('Default model preset is missing');
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: true,
      WorkingDirectory: root,
      PythonPath: pythonPath,
      Entrypoint: path.basename(scriptPath),
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 5_000,
    }, flushQueue, capabilities);
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
      await flushQueue.close();
    }
  });
});

test('unmanaged EXL3 preset with speculation fails loud instead of silently losing MTP', async () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: '.',
    PythonPath: process.execPath,
    Entrypoint: 'unused',
    ModelRoot: '.',
    AdminApiKey: '',
    ShutdownTimeoutMs: 100,
  }, flushQueue);

  await assert.rejects(runtime.ensurePresetReady({
    ...preset,
    id: 'external-mtp',
    Backend: 'exl3' as const,
    BaseUrl: DEAD_BASE_URL,
    Model: 'model-a',
    ModelPath: path.join('.', 'model-a'),
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as const,
  }), /cannot enable MTP drafting/u);
});

test('managed Tabby waits for delayed MTP drafting announced on stderr', async () => {
  await withTempEnv(async (root) => {
    await using portLease = await acquireChildPortLease('managed-tabby');
    const port = portLease.port;
    const { scriptPath, pythonPath, capabilities } = writeFakeTabby(root, port, null, {
      draftingStream: 'stderr',
      draftingDelayMs: 100,
    });
    const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
    if (!preset) throw new Error('Default model preset is missing');
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: true,
      WorkingDirectory: root,
      PythonPath: pythonPath,
      Entrypoint: path.basename(scriptPath),
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 5_000,
    }, flushQueue, capabilities);
    try {
      await runtime.ensurePresetReady({
        ...preset,
        Backend: 'exl3' as const,
        BaseUrl: `http://127.0.0.1:${port}`,
        Model: 'model-a',
        ModelPath: path.join(root, 'model-a'),
        SpeculativeEnabled: true,
        SpeculativeType: 'draft-mtp' as const,
        HealthcheckTimeoutMs: 1_000,
        HealthcheckIntervalMs: 10,
      });
      assert.equal(runtime.getModelState(), 'ready');
    } finally {
      await runtime.stopProcess();
      await flushQueue.close();
    }
  });
});

test('managed Tabby rejects a speculative preset when the startup log never reports MTP drafting', async () => {
  await withTempEnv(async (root) => {
    await using portLease = await acquireChildPortLease('managed-tabby');
    const port = portLease.port;
    const { scriptPath, pythonPath, capabilities } = writeFakeTabby(root, port, null, { announceDrafting: false });
    const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
    if (!preset) throw new Error('Default model preset is missing');
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: true,
      WorkingDirectory: root,
      PythonPath: pythonPath,
      Entrypoint: path.basename(scriptPath),
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 5_000,
    }, flushQueue, capabilities);
    try {
      await assert.rejects(runtime.ensurePresetReady({
        ...preset,
        Backend: 'exl3' as const,
        BaseUrl: `http://127.0.0.1:${port}`,
        Model: 'model-a',
        ModelPath: path.join(root, 'model-a'),
        SpeculativeEnabled: true,
        SpeculativeType: 'draft-mtp' as const,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      }), /startup log never reported the MTP draft component/u);
      assert.equal(runtime.getModelState(), 'failed');
    } finally {
      await runtime.stopProcess();
      await flushQueue.close();
    }
  });
});

test('external EXL3 preset does not launch the configured managed Tabby process', async () => {
  await withTempEnv(async (root) => {
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
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: true,
      WorkingDirectory: root,
      PythonPath: process.execPath,
      Entrypoint: path.basename(scriptPath),
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 2_000,
    }, flushQueue);
    try {
      await runtime.ensurePresetReady(externalPreset);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.existsSync(launchedPath), false);
    } finally {
      await runtime.unloadPreset();
      await runtime.stopProcess();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await flushQueue.close();
    }
  });
});
