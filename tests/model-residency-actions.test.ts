import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { InferenceModelStateSchema } from '@siftkit/contracts';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import type {
  AssistantInferenceClient, AssistantInferenceRequest, AssistantInferenceResult,
} from '../src/assistant/inference/client.js';
import { DEFAULT_ASSISTANT_CONFIG, getDefaultConfigObject } from '../src/config/defaults.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { StatusServerResidencyGate } from '../src/status-server/assistant-residency-gate.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { ModelIdleController } from '../src/status-server/model-idle-controller.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { TabbyModelClient } from '../src/status-server/tabby-model-client.js';
import type { ModelRequestLock, ServerContext } from '../src/status-server/server-types.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { ALWAYS_IDLE } from './helpers/assistant-gates.js';
import { RecordingInferenceRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createFakeExl3Capabilities, writeFakeExl3Venv } from './helpers/tabby-fake.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

type FixtureOptions = {
  externalServerEnabled?: boolean;
  idleAction?: 'none' | 'freeze' | 'unload';
  sleepIdleSeconds?: number;
  blockedTransition?: BlockedTransition;
};

type BlockedTransition = 'unload' | 'freeze' | 'restore' | 'ensure';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolveDeferred) throw new Error('Deferred promise was not initialized.');
      resolveDeferred();
    },
  };
}

class BlockingRecordingInferenceRuntime extends RecordingInferenceRuntime {
  readonly transitionStarted = createDeferred();
  private readonly releaseTransitionDeferred = createDeferred();

  constructor(
    events: string[],
    private blockedTransition: BlockedTransition | null,
  ) {
    super('exl3', events);
  }

  releaseTransition(): void {
    this.releaseTransitionDeferred.resolve();
  }

  setBlockedTransition(transition: BlockedTransition | null): void {
    this.blockedTransition = transition;
  }

  override async unloadPreset(): Promise<void> {
    await this.waitForRelease('unload');
    await super.unloadPreset();
  }

  override async freezePreset(): Promise<void> {
    await this.waitForRelease('freeze');
    await super.freezePreset();
  }

  override async restorePreset(): Promise<void> {
    await this.waitForRelease('restore');
    await super.restorePreset();
  }

  override async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    await this.waitForRelease('ensure');
    await super.ensurePresetReady(preset);
  }

  private async waitForRelease(transition: BlockedTransition): Promise<void> {
    if (this.blockedTransition !== transition) return;
    this.transitionStarted.resolve();
    await this.releaseTransitionDeferred.promise;
  }
}

/** Blocks its model call until released, so a drain can be caught inside the inference round-trip. */
class BlockingAssistantInference implements AssistantInferenceClient {
  readonly callStarted = createDeferred();
  readonly callAborted = createDeferred();
  private readonly releaseCallDeferred = createDeferred();
  abortSignal: AbortSignal | null = null;

  releaseCall(): void {
    this.releaseCallDeferred.resolve();
  }

  async complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult> {
    this.abortSignal = request.abortSignal;
    request.abortSignal?.addEventListener('abort', () => this.callAborted.resolve(), { once: true });
    if (request.abortSignal?.aborted === true) this.callAborted.resolve();
    this.callStarted.resolve();
    await this.releaseCallDeferred.promise;
    return { text: '{}', backendId: 'fake', modelId: 'fake-model' };
  }
}

function makeLock(): ModelRequestLock {
  return {
    token: 'req-1',
    kind: 'repo_search',
    startedAtUtc: new Date().toISOString(),
    ownerRunId: null,
    holdTimeoutHandle: null,
  };
}

function createCoordinatorFixture(options: FixtureOptions = {}) {
  const root = createManagedTempDir('model-residency-');
  const configPath = join(root, 'runtime.sqlite');
  const config = getDefaultConfigObject();
  const base = config.Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: 'exl3-main',
    Presets: [
      { ...base, id: 'exl3-alt', label: 'EXL3 alt', Backend: 'exl3' },
      {
        ...base,
        id: 'exl3-main',
        label: 'EXL3 main',
        Backend: 'exl3',
        ExternalServerEnabled: options.externalServerEnabled ?? false,
        IdleAction: options.idleAction ?? 'unload',
        SleepIdleSeconds: options.sleepIdleSeconds ?? 1,
      },
    ],
  };
  writeConfig(configPath, config);
  const events: string[] = [];
  const activeModelRequests = new Map<string, ModelRequestLock>();
  const appliedState = new AppliedModelPresetState(getActiveModelPreset(readConfig(configPath)));
  const exl3Runtime = new BlockingRecordingInferenceRuntime(events, options.blockedTransition ?? null);
  const coordinator = new PresetRuntimeCoordinator(configPath, exl3Runtime, activeModelRequests, appliedState);
  const ctx: ServerContext = {
    ...createTestServerContext(configPath, root),
    activeModelRequests,
    appliedModelPresetState: appliedState,
    presetRuntimeCoordinator: coordinator,
  };
  const controller = new ModelIdleController(ctx);
  return {
    activeModelRequests,
    controller,
    coordinator,
    ctx,
    events,
    exl3Runtime,
    configPath,
    preset: appliedState.getPreset(),
    async cleanup(): Promise<void> {
      controller.cancelForPresetChange();
      await coordinator.shutdown();
      closeRuntimeDatabase();
      rmSync(dirname(configPath), { recursive: true, force: true });
    },
  };
}

async function waitForEvent(events: readonly string[], expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!events.includes(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events.includes(expected), true, `expected event ${expected}`);
}

async function startStubTabby(status: number, body: string, seen: string[]) {
  const server = createServer((request, response) => {
    seen.push(new URL(request.url ?? '/', 'http://localhost').pathname);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Stub Tabby server did not bind to TCP.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test('model state schema covers the freeze lifecycle', () => {
  for (const state of ['unloaded', 'loading', 'ready', 'unloading', 'freezing', 'frozen', 'failed']) {
    assert.equal(InferenceModelStateSchema.safeParse(state).success, true, state);
  }
  assert.equal(InferenceModelStateSchema.safeParse('restoring').success, false);
});

test('idle controller never arms a timer when IdleAction is none', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'none' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    assert.equal(fixture.controller.getIdleDeadlineUtc(), null);
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('idle controller freezes when IdleAction is freeze', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'freeze' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    assert.equal(typeof fixture.controller.getIdleDeadlineUtc(), 'string');
    await waitForEvent(fixture.events, 'freeze:exl3');
    assert.deepEqual(fixture.events, ['freeze:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('idle controller fully unloads when IdleAction is unload', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    await waitForEvent(fixture.events, 'unload:exl3');
    assert.deepEqual(fixture.events, ['unload:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('manual unload refuses while a model request is active', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.activeModelRequests.set('req-1', makeLock());
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'busy');
    assert.deepEqual(fixture.events, []);
  } finally {
    fixture.activeModelRequests.clear();
    await fixture.cleanup();
  }
});

test('idle residency transition blocks all manual residency actions', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'freeze' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const idlePromise = fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'freeze');
    await fixture.exl3Runtime.transitionStarted.promise;

    assert.equal(fixture.coordinator.canGrantModelRequest(), false);
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'busy');
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'busy');
    assert.equal((await fixture.coordinator.loadActivePresetNow()).status, 'busy');
    assert.deepEqual(fixture.events, []);

    fixture.exl3Runtime.releaseTransition();
    assert.equal(await idlePromise, true);
    assert.deepEqual(fixture.events, ['freeze:exl3']);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('manual residency transition blocks idle actions and model requests', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const manualPromise = fixture.coordinator.unloadActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    assert.equal(fixture.coordinator.canGrantModelRequest(), false);
    const idlePromise = fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'unload');
    fixture.exl3Runtime.releaseTransition();

    assert.equal((await manualPromise).status, 'done');
    assert.equal(await idlePromise, false);
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('request-triggered frozen restoration blocks competing residency actions', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'restore' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    const ensurePromise = fixture.coordinator.ensureActivePresetReady();
    await fixture.exl3Runtime.transitionStarted.promise;

    assert.equal(fixture.coordinator.canGrantModelRequest(), false);
    const manualPromise = fixture.coordinator.unloadActivePresetNow();
    const idlePromise = fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'freeze');
    fixture.exl3Runtime.releaseTransition();

    assert.equal((await manualPromise).status, 'busy');
    assert.equal(await idlePromise, false);
    await ensurePromise;
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('ready-state request readiness does not open a residency transition', async () => {
  const fixture = createCoordinatorFixture();
  let ensurePromise: Promise<void> | null = null;
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.exl3Runtime.setBlockedTransition('ensure');
    ensurePromise = fixture.coordinator.ensureActivePresetReady();
    const outcome = await Promise.race([
      ensurePromise.then(() => 'completed' as const),
      fixture.exl3Runtime.transitionStarted.promise.then(() => 'blocked' as const),
    ]);

    assert.equal(outcome, 'completed');
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
    await ensurePromise;
  } finally {
    fixture.exl3Runtime.releaseTransition();
    if (ensurePromise) await ensurePromise;
    await fixture.cleanup();
  }
});

test('manual freeze refuses when the installed exllamav3 has no freeze patch', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.exl3Runtime.freezeSupported = false;
    fixture.events.length = 0;
    const result = await fixture.coordinator.freezeActivePresetNow();
    assert.equal(result.status, 'unsupported');
    assert.match(result.reason ?? '', /exllamav3/u);
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('idle freeze fails loudly when the installed exllamav3 has no freeze patch', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'freeze' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.exl3Runtime.freezeSupported = false;
    fixture.events.length = 0;
    await assert.rejects(
      fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'freeze'),
      /exllamav3/u,
    );
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('runtime status reports whether freeze is installable on the active backend', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal(fixture.coordinator.getStatus().freezeSupported, true);
    fixture.exl3Runtime.freezeSupported = false;
    assert.equal(fixture.coordinator.getStatus().freezeSupported, false);
  } finally {
    await fixture.cleanup();
  }
});

test('manual unload is a no-op when the model is already unloaded', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'noop');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('manual load restores from frozen state rather than cold loading', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.loadActivePresetNow()).status, 'done');
    assert.deepEqual(fixture.events, ['restore:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('model request readiness restores from frozen state rather than cold loading', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    await fixture.coordinator.ensureActivePresetReady();
    assert.deepEqual(fixture.events, ['restore:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('manual freeze is a no-op when already frozen', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    await fixture.coordinator.freezeActivePresetNow();
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'noop');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('manual freeze blocks preset apply without creating a pending switch', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'freeze' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    const config = readConfig(fixture.configPath);
    config.Server.ModelPresets.ActivePresetId = 'exl3-alt';
    writeConfig(fixture.configPath, config);
    fixture.events.length = 0;
    const freezePromise = fixture.coordinator.freezeActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    await assert.rejects(
      fixture.coordinator.applyPreset('exl3-alt'),
      /model residency transition is in progress; retry once it completes/u,
    );
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(fixture.coordinator.canGrantModelRequest(), false);

    fixture.exl3Runtime.releaseTransition();
    assert.equal((await freezePromise).status, 'done');
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('manual unload blocks configured restart without creating a pending switch', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const unloadPromise = fixture.coordinator.unloadActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    let restartErrorMessage = '';
    const restartOutcome = fixture.coordinator.restartConfiguredPreset().then(
      () => 'completed' as const,
      (error) => {
        restartErrorMessage = error instanceof Error ? error.message : String(error);
        return 'rejected' as const;
      },
    );
    const observed = await Promise.race([
      restartOutcome,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    assert.equal(observed, 'rejected');
    assert.match(restartErrorMessage, /model residency transition is in progress; retry once it completes/u);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.coordinator.canGrantModelRequest(), false);

    fixture.exl3Runtime.releaseTransition();
    assert.equal((await unloadPromise).status, 'done');
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('shutdown unloads a frozen external EXL3 model before stopping its process', async () => {
  const fixture = createCoordinatorFixture({ externalServerEnabled: true });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.freezeActivePresetNow()).status, 'done');
    fixture.events.length = 0;

    await fixture.coordinator.shutdown();

    assert.deepEqual([...fixture.events], ['unload:exl3', 'stop:exl3']);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('shutdown waits for an active EXL3 freeze before unloading and stopping', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'freeze' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const freezePromise = fixture.coordinator.freezeActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    const shutdownPromise = fixture.coordinator.shutdown();
    const observed = await Promise.race([
      shutdownPromise.then(() => 'completed' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    assert.equal(observed, 'pending');
    assert.deepEqual(fixture.events, []);

    fixture.exl3Runtime.releaseTransition();
    assert.equal((await freezePromise).status, 'done');
    await shutdownPromise;
    assert.deepEqual([...fixture.events], ['freeze:exl3', 'unload:exl3', 'stop:exl3']);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});

test('tabby client posts to the freeze and restore endpoints', async () => {
  const seen: string[] = [];
  const server = await startStubTabby(200, '{}', seen);
  try {
    const client = new TabbyModelClient('test-key');
    await client.freeze(server.baseUrl, 2_000);
    await client.restore(server.baseUrl, 2_000);
    assert.deepEqual(seen, ['/v1/model/freeze', '/v1/model/restore']);
  } finally {
    await server.close();
  }
});

test('tabby client surfaces a freeze failure with its status code', async () => {
  const server = await startStubTabby(500, 'boom', []);
  try {
    const client = new TabbyModelClient('test-key');
    await assert.rejects(() => client.freeze(server.baseUrl, 2_000), /HTTP 500.*boom/su);
  } finally {
    await server.close();
  }
});

test('Tabby freeze uses the startup timeout for the host transfer', async () => {
  const root = createManagedTempDir('tabby-freeze-timeout-');
  const basePreset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!basePreset) throw new Error('Default model preset is missing');
  let loaded = false;
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"object":"list","data":[]}');
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/load') {
      loaded = true;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      return;
    }
    if (request.url === '/v1/model') {
      if (!loaded) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'model-a',
        parameters: {
          max_seq_len: basePreset.NumCtx,
          cache_size: Math.ceil(basePreset.NumCtx / 256) * 256,
          chunk_size: basePreset.UBatchSize,
        },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/freeze') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 250);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Stub Tabby server did not bind to TCP.');
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const fakeExl3 = writeFakeExl3Venv(root, true);
  const runtime = new ManagedTabbyRuntime({
    Managed: false,
    WorkingDirectory: root,
    PythonPath: fakeExl3.pythonPath,
    Entrypoint: 'unused',
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 1_000,
  }, flushQueue, createFakeExl3Capabilities(fakeExl3.pythonPath));
  const preset = {
    ...basePreset,
    id: 'exl3-main',
    Backend: 'exl3' as const,
    BaseUrl: `http://127.0.0.1:${address.port}`,
    ExternalServerEnabled: true,
    Model: 'model-a',
    ModelPath: join(root, 'model-a'),
    SpeculativeEnabled: false,
    HealthcheckTimeoutMs: 100,
    StartupTimeoutMs: 1_000,
  };
  try {
    await runtime.ensurePresetReady(preset);
    await runtime.freezePreset();
    assert.equal(runtime.getModelState(), 'frozen');
  } finally {
    await runtime.stopProcess();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await flushQueue.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('idle freeze preempts a blocked assistant drain and waits for it before freezing', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'freeze', blockedTransition: 'freeze' });
  const inference = new BlockingAssistantInference();
  let drain: Promise<void> | null = null;
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;

    const service = AssistantService.create({
      database: getRuntimeDatabase(fixture.configPath),
      runtimeRoot: dirname(fixture.configPath),
      clock: new FixedClock('2026-08-05T09:00:00.000Z'),
      ids: new SequentialIdGenerator(),
      configWriter: new MemoryAssistantConfigWriter({ ...DEFAULT_ASSISTANT_CONFIG, Enabled: true }),
      inference,
      tokens: new EstimateTokenCounter(4),
      idleGate: ALWAYS_IDLE,
      residencyGate: new StatusServerResidencyGate(fixture.coordinator),
      config: { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true },
    });
    fixture.ctx.assistant = service;
    fixture.ctx.assistantControl = service;
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_residency',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });

    const order: string[] = [];
    drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    await inference.callStarted.promise;

    let freezeStarted = false;
    void fixture.exl3Runtime.transitionStarted.promise.then(() => { freezeStarted = true; });
    fixture.controller.armAfterRequest({ ...fixture.preset, SleepIdleSeconds: 0.001 }, Date.now());
    await inference.callAborted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(freezeStarted, false, 'freeze must not start while the assistant drain is still blocked');
    assert.equal(inference.abortSignal?.aborted, true, 'the preemption must abort the blocked model call');

    inference.releaseCall();
    await drain;
    await fixture.exl3Runtime.transitionStarted.promise.then(() => order.push('freeze'));
    assert.deepEqual(order, ['drain', 'freeze']);

    fixture.exl3Runtime.releaseTransition();
    await waitForEvent(fixture.events, 'freeze:exl3');
    assert.deepEqual(fixture.events, ['freeze:exl3']);
  } finally {
    inference.releaseCall();
    fixture.exl3Runtime.releaseTransition();
    if (drain) await drain;
    await fixture.cleanup();
  }
});
