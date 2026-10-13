import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.ts';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.ts';
import { serverLogger } from '../src/status-server/server-logger.ts';

import { acquireChildPortLease, withTempEnv } from './_runtime-helpers.ts';
import { getAddressInfo } from './helpers/dashboard-http.ts';
import { FakeTabbyModelState, writeFakeEngineHost } from './helpers/tabby-fake.ts';
import { launchEngineVariables, NEVER_LAUNCHING_ENGINE_HOST, type FakeTabbyOptions } from './helpers/in-process-tabby.ts';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';
import type { GpuMemory, GpuMemoryProbe } from '../src/status-server/gpu-memory.ts';

const FIXTURE_ENTRYPOINT = 'tabby-main.py';
// The default fake rejects /v1/model/load and announces MTP drafting on stdout at once.
const DEFAULT_FAKE_OPTIONS: Omit<FakeTabbyOptions, 'port'> = { rejectLoads: true, mtpAnnouncement: { stream: 'stdout', delayMs: 0 } };

async function createManagedTabbyFixture(
  root: string,
  leaseName: string,
  environment: Record<string, string> = {},
  fakeOptions: Omit<FakeTabbyOptions, 'port'> = DEFAULT_FAKE_OPTIONS,
  hostOptions: { gpuMemory?: GpuMemoryProbe; shutdownTimeoutMs?: number } = {},
) {
  const portLease = await acquireChildPortLease(leaseName);
  const fakeTabby = writeFakeEngineHost(root, { port: portLease.port, ...fakeOptions }, hostOptions.gpuMemory);
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
    ShutdownTimeoutMs: hostOptions.shutdownTimeoutMs ?? 5_000,
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

const MIB = 1_048_576;

/** Reports scripted used-VRAM readings in MiB (null: unreadable); the last repeats until `settle` fixes every later one. */
class ScriptedGpuMemory implements GpuMemoryProbe {
  reads = 0;
  private settled: number | null = null;
  private readonly usedMiB: readonly (number | null)[];
  constructor(usedMiB: readonly (number | null)[]) {
    this.usedMiB = usedMiB;
  }
  settle(usedMiB: number): void {
    this.settled = usedMiB;
  }
  async read(): Promise<GpuMemory | null> {
    const scripted = this.usedMiB[Math.min(this.reads, this.usedMiB.length - 1)];
    if (scripted === undefined) throw new Error('ScriptedGpuMemory needs at least one reading.');
    const used = this.settled ?? scripted;
    this.reads += 1;
    if (used === null) return null;
    return { totalBytes: 24_000 * MIB, usedBytes: used * MIB, freeBytes: (24_000 - used) * MIB };
  }
}

test('managed Tabby stops only once the engine has released its VRAM', async () => {
  await withTempEnv(async (root) => {
    // baseline before launch, two readings still holding the model, then released
    const gpu = new ScriptedGpuMemory([2_000, 20_000, 20_000, 2_100]);
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-vram-release', {}, DEFAULT_FAKE_OPTIONS, { gpuMemory: gpu });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    assert.equal(gpu.reads, 1, 'the baseline is read once before launch');

    await fixture.runtime.unloadPreset();

    assert.equal(gpu.reads, 4, 'stop polled until usage returned to the baseline');
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
});

test('managed Tabby fails the stop loudly when VRAM is never released', async () => {
  await withTempEnv(async (root) => {
    const gpu = new ScriptedGpuMemory([2_000, 20_000]);
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-vram-held', {}, DEFAULT_FAKE_OPTIONS,
      { gpuMemory: gpu, shutdownTimeoutMs: 600 });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await assert.rejects(fixture.runtime.unloadPreset(), /GPU memory was not released within 600 ms \(20000 MiB used; 2000 MiB before launch\)/u);
    assert.equal(fixture.runtime.getProcessState(), 'failed');
    gpu.settle(2_000); // lets the fixture's disposal stop cleanly
  });
});

test('managed Tabby fails the stop loudly when GPU memory measured at launch becomes unreadable', async () => {
  await withTempEnv(async (root) => {
    const gpu = new ScriptedGpuMemory([2_000, null]);
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-vram-unreadable', {}, DEFAULT_FAKE_OPTIONS, { gpuMemory: gpu });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await assert.rejects(fixture.runtime.unloadPreset(), /GPU memory could not be read after stopping TabbyAPI \(2000 MiB before launch\)/u);
    assert.equal(fixture.runtime.getProcessState(), 'failed');
    gpu.settle(2_000);
  });
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

test('unmanaged EXL3 preset with a disk cache fails loud instead of silently dropping the disk tier', async () => {
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
    id: 'external-disk-cache',
    Backend: 'exl3' as const,
    BaseUrl: DEAD_BASE_URL,
    Model: 'model-a',
    ModelPath: path.join('.', 'model-a'),
    DiskCacheDir: 'D:\\AI\\exl3-disk-cache',
    CacheRam: 4096,
    SpeculativeEnabled: false,
  }), /sets DiskCacheDir, but the disk cache is a launch setting/u);
});

test('managed engine rejects an external-server EXL3 preset with a disk cache', async () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
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
    id: 'external-disk-cache',
    Backend: 'exl3' as const,
    BaseUrl: DEAD_BASE_URL,
    Model: 'model-a',
    ModelPath: path.join('.', 'model-a'),
    ExternalServerEnabled: true,
    DiskCacheDir: 'D:\\AI\\exl3-disk-cache',
    CacheRam: 4096,
    SpeculativeEnabled: false,
  }), /sets DiskCacheDir, but the disk cache is a launch setting/u);
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

test('managed Tabby names the engine exception when the process exits during startup', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-exit-error', {}, {
      exitAfterLog: true,
      exitStderrLine: 'RuntimeError: Insufficient VRAM in split for model and cache',
      exitCode: 1,
    });
    await assert.rejects(fixture.runtime.ensurePresetReady(fixture.exl3Preset), {
      message: 'TabbyAPI exited unexpectedly (code=1, signal=null): RuntimeError: Insufficient VRAM in split for model and cache',
    });
  });
});

test('managed Tabby names the engine exception even when stderr drains after the exit', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-exit-error-late-stderr', {}, {
      exitAfterLog: true,
      exitStderrLine: 'RuntimeError: Insufficient VRAM in split for model and cache',
      stderrAfterExit: true,
      exitCode: 1,
    });
    await assert.rejects(fixture.runtime.ensurePresetReady(fixture.exl3Preset), {
      message: 'TabbyAPI exited unexpectedly (code=1, signal=null): RuntimeError: Insufficient VRAM in split for model and cache',
    });
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

const DISK_CACHE = { DiskCacheDir: 'D:\\AI\\exl3-disk-cache', CacheRam: 1024 };

test('managed Tabby drains a disk-cache preset through unload before terminating it', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-disk-drain');
    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...DISK_CACHE });
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['unload', 'terminate']);
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
});

test('a disk-cache drain runs while the process reports stopping', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-disk-drain-stopping', {},
      { ...DEFAULT_FAKE_OPTIONS, unloadDelayMs: 300 });
    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...DISK_CACHE });
    const stop = fixture.runtime.unloadPreset();
    const pollDeadline = Date.now() + 2_000;
    while (!fixture.launcher.events.includes('unload') && Date.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fixture.runtime.getProcessState(), 'stopping');
    await stop;
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
    assert.deepEqual(fixture.launcher.events, ['unload', 'terminate']);
  });
});

test('a failed disk-cache drain is logged and the engine still stops', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-disk-drain-fail', {},
      { ...DEFAULT_FAKE_OPTIONS, rejectUnloads: true });
    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...DISK_CACHE });
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['unload', 'terminate']);
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
  const drainWarnings = warnings.mock.calls
    .map((call) => call.arguments[0])
    .filter((event) => event?.scope === 'exl3' && event.event === 'disk_cache_flush_failed');
  assert.equal(drainWarnings.length, 1);
  assert.equal(typeof drainWarnings[0]?.alert, 'string');
  assert.notEqual(drainWarnings[0]?.alert, '');
});

test('a preset without a disk cache is terminated without an unload', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-no-disk');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['terminate']);
  });
});
