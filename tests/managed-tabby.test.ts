import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';

import { acquireChildPortLease, withTempEnv } from './_runtime-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { FakeTabbyModelState, writeFakeEngineHost } from './helpers/tabby-fake.js';
import { launchEngineVariables, NEVER_LAUNCHING_ENGINE_HOST, type FakeTabbyOptions } from './helpers/in-process-tabby.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

const FIXTURE_ENTRYPOINT = 'tabby-main.py';

// The default fake rejects /v1/model/load and announces MTP drafting on stdout at once.
async function createManagedTabbyFixture(
  root: string,
  leaseName: string,
  environment: Record<string, string> = {},
  fakeOptions: Omit<FakeTabbyOptions, 'port'> = { rejectLoads: true, mtpAnnouncement: { stream: 'stdout', delayMs: 0 } },
) {
  const portLease = await acquireChildPortLease(leaseName);
  const fakeTabby = writeFakeEngineHost(root, { port: portLease.port, ...fakeOptions });
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
    SpeculativeDraftMax: 5,
    HealthcheckIntervalMs: 10,
  };
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: fakeTabby.pythonPath,
    Entrypoint: FIXTURE_ENTRYPOINT,
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
    Environment: environment,
  }, flushQueue, fakeTabby.host);

  return {
    ...fakeTabby,
    exl3Preset,
    runtime,
    async [Symbol.asyncDispose]() {
      await runtime.stopProcess();
      await fakeTabby.launcher.stopAll();
      await flushQueue.close();
      await portLease[Symbol.asyncDispose]();
    },
  };
}

test('ManagedTabbyRuntime construction requires engine configuration, a flush queue, and an engine host', () => {
  assert.equal(ManagedTabbyRuntime.length, 3);
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
      Environment: {},
    }, flushQueue, NEVER_LAUNCHING_ENGINE_HOST);
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

test('managed Tabby launches with the complete preset environment', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-launch');

    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    const [launch] = fixture.launcher.launches;
    assert.equal(launch?.command, fixture.pythonPath);
    assert.deepEqual(launch?.args, [FIXTURE_ENTRYPOINT]);
    assert.equal(launch?.workingDirectory, root);
    // Every TABBY_*/EXL3_* variable the child actually received, so a preset knob that never
    // reaches the process is a failure here rather than something only a live run would catch.
    assert.deepEqual(launchEngineVariables(launch), {
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
        TABBY_MODEL_VISION_OFFLOAD: 'false',
        TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
        TABBY_MODEL_NGRAM_RAM: 'false',
        PYTORCH_ALLOC_CONF: 'backend:native,expandable_segments:True',
        PYTORCH_CUDA_ALLOC_CONF: 'backend:native,expandable_segments:True',
        TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'false',
    });
    assert.equal(fixture.launcher.loadRequestCount, 0);
  });
});

test('managed Tabby reuses residency for equivalent profiles and endpoint spellings', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-reuse');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await fixture.runtime.ensurePresetReady({
      ...fixture.exl3Preset,
      id: 'equivalent-profile',
      label: 'Equivalent profile',
      Temperature: 0.125,
      BaseUrl: `${fixture.exl3Preset.BaseUrl}/ignored-path?unused=true`,
    });

    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(fixture.launcher.launches.length, 1);
    assert.equal(fixture.launcher.loadRequestCount, 0);
  });
});

test('managed Tabby restarts for changed settings and after an explicit unload', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-restart');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, UBatchSize: 2_048 });
    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(fixture.launcher.launches.length, 2);

    await fixture.runtime.unloadPreset();
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
    assert.equal(fixture.runtime.getModelState(), 'unloaded');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    assert.equal(fixture.runtime.getProcessState(), 'ready');
    assert.equal(fixture.runtime.getModelState(), 'ready');
    assert.equal(fixture.launcher.launches.length, 3);
    assert.equal(fixture.launcher.loadRequestCount, 0);
  });
});

test('managed Tabby rejects a startup-loaded model whose applied context diverges from the preset', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-clamp', {}, {
      rejectLoads: true,
      appliedMaxSeqLen: 84_992,
    });
    await assert.rejects(fixture.runtime.ensurePresetReady({
      ...fixture.exl3Preset,
      SpeculativeEnabled: false,
      NumCtx: 150_000,
    }), /max_seq_len expected 150000 but Tabby applied 84992/u);
    assert.equal(fixture.runtime.getModelState(), 'failed');
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
    Environment: {},
  }, flushQueue, NEVER_LAUNCHING_ENGINE_HOST);

  await assert.rejects(runtime.ensurePresetReady({
    ...preset,
    id: 'external-mtp',
    Backend: 'exl3' as const,
    BaseUrl: DEAD_BASE_URL,
    Model: 'model-a',
    ModelPath: path.join('.', 'model-a'),
    SpeculativeEnabled: true,
  }), /cannot enable MTP drafting/u);
});

test('managed Tabby waits for delayed MTP drafting announced on stderr', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-stderr-mtp', {}, {
      rejectLoads: true,
      mtpAnnouncement: { stream: 'stderr', delayMs: 100 },
    });
    await fixture.runtime.ensurePresetReady({
      ...fixture.exl3Preset,
      HealthcheckTimeoutMs: 1_000,
      HealthcheckIntervalMs: 10,
    });
    assert.equal(fixture.runtime.getModelState(), 'ready');
  });
});

test('managed Tabby rejects a speculative preset when the startup log never reports MTP drafting', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-silent-mtp', {}, { rejectLoads: true });
    await assert.rejects(fixture.runtime.ensurePresetReady({
      ...fixture.exl3Preset,
      HealthcheckTimeoutMs: 100,
      HealthcheckIntervalMs: 10,
    }), /startup log never reported the MTP draft component/u);
    assert.equal(fixture.runtime.getModelState(), 'failed');
  });
});

test('external EXL3 preset does not launch the configured managed Tabby process', async () => {
  await withTempEnv(async (root) => {
    const fakeTabby = writeFakeEngineHost(root, { port: 0 });
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
      PythonPath: fakeTabby.pythonPath,
      Entrypoint: 'must-not-launch.py',
      ModelRoot: root,
      AdminApiKey: '',
      ShutdownTimeoutMs: 2_000,
      Environment: {},
    }, flushQueue, fakeTabby.host);
    try {
      await runtime.ensurePresetReady(externalPreset);
      assert.deepEqual(fakeTabby.launcher.launches, []);
    } finally {
      await runtime.unloadPreset();
      await runtime.stopProcess();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await flushQueue.close();
    }
  });
});

/** The three launch values the child must end up with, whatever the parent shell had set. */
const ManagedAllocatorEnvironmentSchema = z.object({
  PYTORCH_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
  PYTORCH_CUDA_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
  TABBY_MEMORY_CUDA_MALLOC_ASYNC: z.literal('false'),
});

test('managed Tabby forwards the engine environment beneath the preset environment', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-engine-env', {
      EXL3_MOE_PINNED_ARENA: '1',
      TABBY_MODEL_CHUNK_SIZE: '4',   // preset-owned: must not override the preset's value
    });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    const recorded = z.object({
      EXL3_MOE_PINNED_ARENA: z.string(),
      TABBY_MODEL_CHUNK_SIZE: z.string(),
    }).parse(launchEngineVariables(fixture.launcher.launches[0]));
    assert.equal(recorded.EXL3_MOE_PINNED_ARENA, '1');
    assert.equal(recorded.TABBY_MODEL_CHUNK_SIZE, '1024');
  });
});

test('managed Tabby overrides conflicting inherited allocator settings', async () => {
  const inherited = {
    PYTORCH_ALLOC_CONF: 'backend:cudaMallocAsync',
    PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:False',
    TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'true',
  };
  const previous = new Map(
    Object.keys(inherited).map((key) => [key, process.env[key]] as const),
  );
  Object.assign(process.env, inherited);
  try {
    await withTempEnv(async (root) => {
      await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-allocator');
      await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

      // Parsed rather than asserted field by field: a missing variable must fail here too,
      // since an allocator setting that never reaches the child is silently ineffective.
      const recorded = ManagedAllocatorEnvironmentSchema.parse(
        launchEngineVariables(fixture.launcher.launches[0]),
      );
      assert.equal(recorded.PYTORCH_ALLOC_CONF, 'backend:native,expandable_segments:True');
      assert.equal(recorded.PYTORCH_CUDA_ALLOC_CONF, 'backend:native,expandable_segments:True');
      assert.equal(recorded.TABBY_MEMORY_CUDA_MALLOC_ASYNC, 'false');
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
