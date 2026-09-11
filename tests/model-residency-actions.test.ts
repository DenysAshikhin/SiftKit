import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

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
import { ModelIdleController } from '../src/status-server/model-idle-controller.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import type { ModelRequestLock, ServerContext } from '../src/status-server/server-types.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { ALWAYS_IDLE } from './helpers/assistant-gates.js';
import { RecordingInferenceRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

type FixtureOptions = {
  externalServerEnabled?: boolean;
  idleAction?: 'none' | 'unload';
  sleepIdleSeconds?: number;
  blockedTransition?: BlockedTransition;
};

type BlockedTransition = 'unload' | 'ensure';

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
      closeAllRuntimeDatabases();
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
  const fixture = createCoordinatorFixture({ blockedTransition: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const idlePromise = fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'unload');
    await fixture.exl3Runtime.transitionStarted.promise;

    assert.equal(fixture.coordinator.canGrantModelRequest(), false);
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'busy');
    assert.equal((await fixture.coordinator.loadActivePresetNow()).status, 'busy');
    assert.deepEqual(fixture.events, []);

    fixture.exl3Runtime.releaseTransition();
    assert.equal(await idlePromise, true);
    assert.deepEqual(fixture.events, ['unload:exl3']);
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

test('request-triggered cold reload blocks competing residency actions', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    fixture.exl3Runtime.setBlockedTransition('ensure');
    const ensurePromise = fixture.coordinator.ensureActivePresetReady();
    await fixture.exl3Runtime.transitionStarted.promise;

    assert.equal(fixture.coordinator.canGrantModelRequest(), false);
    const manualPromise = fixture.coordinator.unloadActivePresetNow();
    const idlePromise = fixture.coordinator.applyIdleResidencyAction(fixture.preset.id, 'unload');
    fixture.exl3Runtime.releaseTransition();

    assert.equal((await manualPromise).status, 'busy');
    assert.equal(await idlePromise, false);
    await ensurePromise;
    assert.deepEqual(fixture.events, ['load:exl3-main']);
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

test('manual load cold loads after a manual unload', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.loadActivePresetNow()).status, 'done');
    assert.deepEqual(fixture.events, ['load:exl3-main']);
  } finally {
    await fixture.cleanup();
  }
});
test('model request readiness cold loads after a manual unload', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    await fixture.coordinator.ensureActivePresetReady();
    assert.deepEqual(fixture.events, ['load:exl3-main']);
  } finally {
    await fixture.cleanup();
  }
});
test('manual unload blocks preset apply without creating a pending switch', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    const config = readConfig(fixture.configPath);
    config.Server.ModelPresets.ActivePresetId = 'exl3-alt';
    writeConfig(fixture.configPath, config);
    fixture.events.length = 0;
    const unloadPromise = fixture.coordinator.unloadActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    await assert.rejects(
      fixture.coordinator.applyPreset('exl3-alt'),
      /model residency transition is in progress; retry once it completes/u,
    );
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(fixture.coordinator.canGrantModelRequest(), false);

    fixture.exl3Runtime.releaseTransition();
    assert.equal((await unloadPromise).status, 'done');
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

test('shutdown unloads a ready external EXL3 model before stopping its process', async () => {
  const fixture = createCoordinatorFixture({ externalServerEnabled: true });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;

    await fixture.coordinator.shutdown();

    assert.deepEqual([...fixture.events], ['unload:exl3', 'stop:exl3']);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});
test('shutdown waits for an active EXL3 unload before stopping', async () => {
  const fixture = createCoordinatorFixture({ blockedTransition: 'unload' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const unloadPromise = fixture.coordinator.unloadActivePresetNow();
    await fixture.exl3Runtime.transitionStarted.promise;

    const shutdownPromise = fixture.coordinator.shutdown();
    const observed = await Promise.race([
      shutdownPromise.then(() => 'completed' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    assert.equal(observed, 'pending');
    assert.deepEqual(fixture.events, []);

    fixture.exl3Runtime.releaseTransition();
    assert.equal((await unloadPromise).status, 'done');
    await shutdownPromise;
    assert.deepEqual([...fixture.events], ['unload:exl3', 'stop:exl3']);
  } finally {
    fixture.exl3Runtime.releaseTransition();
    await fixture.cleanup();
  }
});
test('idle unload preempts a blocked assistant drain and waits for it before unloading', async () => {
  const fixture = createCoordinatorFixture({ idleAction: 'unload', blockedTransition: 'unload' });
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

    let unloadStarted = false;
    void fixture.exl3Runtime.transitionStarted.promise.then(() => { unloadStarted = true; });
    fixture.controller.armAfterRequest({ ...fixture.preset, SleepIdleSeconds: 0.001 }, Date.now());
    await inference.callAborted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unloadStarted, false, 'unload must not start while the assistant drain is still blocked');
    assert.equal(inference.abortSignal?.aborted, true, 'the preemption must abort the blocked model call');

    inference.releaseCall();
    await drain;
    await fixture.exl3Runtime.transitionStarted.promise.then(() => order.push('unload'));
    assert.deepEqual(order, ['drain', 'unload']);

    fixture.exl3Runtime.releaseTransition();
    await waitForEvent(fixture.events, 'unload:exl3');
    assert.deepEqual(fixture.events, ['unload:exl3']);
  } finally {
    inference.releaseCall();
    fixture.exl3Runtime.releaseTransition();
    if (drain) await drain;
    await fixture.cleanup();
  }
});
