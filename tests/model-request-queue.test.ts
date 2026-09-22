import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { getActiveModelPreset } from '../src/config/getters.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import { getDefaultConfig, readConfig } from '../src/status-server/config-store.js';
import {
  DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS,
  DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS,
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  getModelRequestQueueDiagnostics,
  isIdle,
  renewModelRequestActivity,
  releaseModelRequest,
  resumeModelRequestAdmission,
} from '../src/status-server/server-ops.js';
import type { ModelRequestLock, ServerContext } from '../src/status-server/server-types.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { ModelIdleController } from '../src/status-server/model-idle-controller.js';
import type { ModelLifecycleActionResult } from '@siftkit/contracts';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import { RecordingInferenceRuntime as QueueRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import { InferenceClient } from '../src/llm-protocol/inference-client.js';
import type { FullJsonResponse, SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { TEST_THROUGHPUT_AUDIT } from './_test-helpers.js';
import {
  createPresetRoutingConfig,
  PRESET_ROUTING_MODEL_A,
  PRESET_ROUTING_MODEL_B,
  PRESET_ROUTING_MODEL_C,
} from './helpers/preset-routing-config.js';

const queueContextRoot = createManagedTempDir('siftkit-model-queue-contexts-');
let queueContextIndex = 0;

test.after(async () => {
  closeAllRuntimeDatabases();
  fs.rmSync(queueContextRoot, { recursive: true, force: true });
});

type PresetParallelSlots = {
  main: number;
  alt: number;
};

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

class BlockingQueueRuntime extends QueueRuntime {
  readonly transitionStarted = createDeferred();
  private readonly releaseTransitionDeferred = createDeferred();
  private blockEnsure = false;
  private blockUnload = false;

  constructor(
    events: string[],
    private readonly stopProcessOnUnload = false,
  ) {
    super('exl3', events);
  }

  blockNextEnsure(): void {
    this.blockEnsure = true;
  }

  releaseEnsure(): void {
    this.releaseTransitionDeferred.resolve();
  }

  blockNextUnload(): void {
    this.blockUnload = true;
  }

  releaseTransition(): void {
    this.releaseTransitionDeferred.resolve();
  }

  override async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (this.blockEnsure) {
      this.blockEnsure = false;
      this.transitionStarted.resolve();
      await this.releaseTransitionDeferred.promise;
    }
    await super.ensurePresetReady(preset);
  }

  override async unloadPreset(): Promise<void> {
    if (this.blockUnload) {
      this.blockUnload = false;
      this.transitionStarted.resolve();
      await this.releaseTransitionDeferred.promise;
    }
    await super.unloadPreset();
    if (this.stopProcessOnUnload) await this.stopProcess();
  }
}

const DEFAULT_PRESET_PARALLEL_SLOTS = {
  main: 2,
  alt: 1,
} satisfies PresetParallelSlots;

function createQueueContext(configPath?: string): ServerContext {
  const resolvedConfigPath = configPath
    ?? path.join(queueContextRoot, `runtime-${queueContextIndex += 1}.sqlite`);
  const config = configPath === undefined ? getDefaultConfig() : readConfig(resolvedConfigPath);
  if (configPath === undefined) {
    writeConfig(resolvedConfigPath, config);
  }
  return {
    ...createTestServerContext(resolvedConfigPath),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(config)),
  };
}

test('model request queue timeout default is fifteen minutes', () => {
  assert.equal(DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS, 900_000);
});

type PresetQueueHarness = {
  ctx: ServerContext;
  coordinator: PresetRuntimeCoordinator;
  exl3Runtime: BlockingQueueRuntime;
  events: string[];
  root: string;
};

/** `stopProcessOnUnload` models a managed TabbyAPI, whose unload is a full process stop. */
async function createPresetQueueHarness(
  prefix: string,
  activePresetId: string,
  parallelSlots: PresetParallelSlots = DEFAULT_PRESET_PARALLEL_SLOTS,
  stopProcessOnUnload = false,
): Promise<PresetQueueHarness> {
  const root = createManagedTempDir(prefix);
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfig();
  const basePreset = config.Server.ModelPresets.Presets[0];
  if (!basePreset) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: activePresetId,
    Presets: [
      { ...basePreset, id: 'exl3-main', Backend: 'exl3', SleepIdleSeconds: 1, ParallelSlots: parallelSlots.main },
      { ...basePreset, id: 'exl3-alt', Backend: 'exl3', SleepIdleSeconds: 1, ParallelSlots: parallelSlots.alt },
    ],
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  const events: string[] = [];
  const exl3Runtime = new BlockingQueueRuntime(events, stopProcessOnUnload);
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    exl3Runtime,
    ctx.activeModelRequests,
    ctx.appliedModelPresetState,
  );
  ctx.presetRuntimeCoordinator = coordinator;
  ctx.modelRuntime = exl3Runtime;
  ctx.modelIdleController = new ModelIdleController(ctx);
  await coordinator.initialize();
  return { ctx, coordinator, exl3Runtime, events, root };
}

/** A load that fails once for a named preset, then behaves like the blocking runtime. */
class FailingQueueRuntime extends BlockingQueueRuntime {
  private failingEnsure: string | null = null;

  constructor(private readonly recordedEvents: string[]) {
    super(recordedEvents);
  }

  failNextEnsure(presetId: string): void {
    this.failingEnsure = presetId;
  }

  override async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (this.failingEnsure === preset.id) {
      this.failingEnsure = null;
      this.recordedEvents.push(`load-fail:${preset.id}`);
      throw new Error(`load failed: ${preset.id}`);
    }
    await super.ensurePresetReady(preset);
  }
}

/** Harness over the validated A/B/C routing config, with per-preset parallel slots. */
async function createRoutingQueueHarness(
  prefix: string,
  activePresetId: string,
  slots: Record<string, number>,
  runtime?: BlockingQueueRuntime,
): Promise<PresetQueueHarness> {
  const root = createManagedTempDir(prefix);
  const configPath = path.join(root, 'runtime.sqlite');
  const config = createPresetRoutingConfig();
  config.Server.ModelPresets = {
    ActivePresetId: activePresetId,
    Presets: config.Server.ModelPresets.Presets.map((preset) => (
      slots[preset.id] === undefined ? preset : { ...preset, ParallelSlots: slots[preset.id] }
    )),
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  const events: string[] = [];
  const exl3Runtime = runtime ?? new BlockingQueueRuntime(events);
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    exl3Runtime,
    ctx.activeModelRequests,
    ctx.appliedModelPresetState,
  );
  ctx.presetRuntimeCoordinator = coordinator;
  ctx.modelRuntime = exl3Runtime;
  ctx.modelIdleController = new ModelIdleController(ctx);
  await coordinator.initialize();
  return { ctx, coordinator, exl3Runtime, events, root };
}

async function closePresetQueueHarness(harness: PresetQueueHarness): Promise<void> {
  harness.ctx.modelIdleController?.cancelForPresetChange();
  await harness.ctx.inferenceRunFlushQueue.close();
  await harness.coordinator.shutdown();
  closeAllRuntimeDatabases();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

async function waitForActivePreset(coordinator: PresetRuntimeCoordinator, presetId: string): Promise<void> {
  while (coordinator.getStatus().activePresetId !== presetId) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForEvent(
  events: readonly string[],
  expected: string,
  timeoutMs = 2_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for event '${expected}'.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForQueuedLock(
  queuedLockPromise: Promise<ModelRequestLock | null>,
): Promise<ModelRequestLock | null> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      queuedLockPromise,
      new Promise<ModelRequestLock | null>((resolve) => {
        const handle = setTimeout(() => resolve(null), 500);
        timeoutHandle = handle;
        handle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

test('a queued request wakes when a blocking manual model load completes', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-queue-residency-wake-', 'exl3-main');
  let loadPromise: Promise<ModelLifecycleActionResult> | null = null;
  try {
    assert.equal((await harness.coordinator.unloadActivePresetNow()).status, 'done');
    harness.exl3Runtime.blockNextEnsure();
    loadPromise = harness.coordinator.loadActivePresetNow();
    await harness.exl3Runtime.transitionStarted.promise;

    assert.equal(harness.ctx.activeModelRequests.size, 0);
    const queuedLockPromise = acquireModelRequestWithWait(harness.ctx, 'repo_search');
    assert.equal(harness.ctx.modelRequestQueue.length, 1);

    harness.exl3Runtime.releaseEnsure();
    await loadPromise;
    const queuedLock = await waitForQueuedLock(queuedLockPromise);
    assert.ok(queuedLock);
    assert.equal(harness.ctx.modelRequestQueue.length, 0);
    assert.equal(releaseModelRequest(harness.ctx, queuedLock.token), true);
  } finally {
    harness.exl3Runtime.releaseEnsure();
    if (loadPromise) await loadPromise;
    await closePresetQueueHarness(harness);
  }
});

test('managed idle unload blocks queued admission once and cold-restores the applied preset', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-managed-idle-',
    'exl3-alt',
    DEFAULT_PRESET_PARALLEL_SLOTS,
    true,
  );
  try {
    const activeLock = await acquireModelRequestWithWait(harness.ctx, 'repo_search');
    assert.ok(activeLock);
    harness.exl3Runtime.blockNextUnload();
    assert.equal(releaseModelRequest(harness.ctx, activeLock.token), true);
    await harness.exl3Runtime.transitionStarted.promise;

    const queuedLockPromise = acquireModelRequestWithWait(harness.ctx, 'summary');
    assert.equal(harness.ctx.modelRequestQueue.length, 1);
    assert.equal(harness.coordinator.canGrantModelRequest(), false);

    harness.exl3Runtime.releaseTransition();
    const queuedLock = await waitForQueuedLock(queuedLockPromise);
    assert.ok(queuedLock);
    assert.equal(harness.ctx.modelRequestQueue.length, 0);
    // The drain cold-restores the applied preset before granting, so the lock is never held mid-switch.
    assert.deepEqual(harness.events, [
      'start:exl3', 'load:exl3-alt', 'unload:exl3', 'stop:exl3', 'start:exl3', 'load:exl3-alt',
    ]);

    await ensureActivePresetReadyForModelRequest(harness.ctx);
    assert.deepEqual(harness.events.slice(-2), ['start:exl3', 'load:exl3-alt']);
    assert.equal(releaseModelRequest(harness.ctx, queuedLock.token), true);
  } finally {
    harness.exl3Runtime.releaseTransition();
    await closePresetQueueHarness(harness);
  }
});

test('preset switch pauses queued admission until the target preset is ready', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-queue-preset-', 'exl3-alt');
  const { ctx, coordinator, events } = harness;
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(activeLock);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'repo_search');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;

    assert.ok(queuedLock);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.deepEqual(events, ['start:exl3', 'load:exl3-alt', 'unload:exl3', 'load:exl3-main']);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('ParallelSlots limits exl3 global admission and grants the FIFO waiter', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-queue-exl3-', 'exl3-main');
  const { ctx } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);

    let thirdResolved = false;
    const thirdPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat').then((lock) => {
      thirdResolved = true;
      return lock;
    });

    // The waiter is enqueued synchronously, so the queued state is observable without waiting.
    assert.equal(thirdResolved, false);
    const waitingDiagnostics = getModelRequestQueueDiagnostics(ctx);
    assert.equal(waitingDiagnostics.activeCount, 2);
    assert.deepEqual(waitingDiagnostics.activeRequests.map((entry) => entry.kind), ['repo_search', 'summary']);
    assert.equal(waitingDiagnostics.queueLength, 1);
    assert.deepEqual(waitingDiagnostics.queuedRequests.map((entry) => entry.kind), ['dashboard_chat']);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(thirdResolved, true);
    assert.equal(releaseModelRequest(ctx, second.token), true);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('ParallelSlots allows two requests on the alternate preset before queueing the third', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-alt-',
    'exl3-alt',
    { main: 2, alt: 2 },
  );
  const { ctx } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);
    const thirdPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
    const waiting = getModelRequestQueueDiagnostics(ctx);
    assert.equal(waiting.activeCount, 2);
    assert.equal(waiting.queueLength, 1);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(getModelRequestQueueDiagnostics(ctx).queueLength, 0);
    assert.equal(releaseModelRequest(ctx, second.token), true);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('releasing the last request arms exl3 idle unload from the applied preset after config drift', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-queue-idle-drift-', 'exl3-main');
  const { ctx, coordinator, events } = harness;
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);

    // The running preset is the applied one, and config can drift from it: renaming the
    // preset leaves no row to find by id. Arming must come from the applied state instead,
    // or the EXL3 model silently stays resident in VRAM with no countdown at all.
    const drifted = readConfig(ctx.configPath);
    drifted.Server.ModelPresets = {
      ActivePresetId: 'exl3-renamed',
      Presets: drifted.Server.ModelPresets.Presets.map((preset) => (
        preset.id === 'exl3-main' ? { ...preset, id: 'exl3-renamed' } : preset
      )),
    };
    writeConfig(ctx.configPath, drifted);

    assert.equal(releaseModelRequest(ctx, lock.token), true);
    assert.equal(typeof coordinator.getStatus().idleDeadlineUtc, 'string');
    await waitForEvent(events, 'unload:exl3');
    assert.equal(coordinator.getStatus().modelState, 'unloaded');
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('ParallelSlots limits coordinator-free capacity to configured value', async () => {
  const root = createManagedTempDir('siftkit-model-queue-config-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfig();
  const basePreset = config.Server.ModelPresets.Presets[0];
  if (!basePreset) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: 'exl3-main',
    Presets: [
      { ...basePreset, id: 'exl3-main', Backend: 'exl3', ParallelSlots: 2 },
    ],
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);
    const thirdPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
    const waiting = getModelRequestQueueDiagnostics(ctx);
    assert.equal(waiting.activeCount, 2);
    assert.equal(waiting.queueLength, 1);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(getModelRequestQueueDiagnostics(ctx).queueLength, 0);
    assert.equal(releaseModelRequest(ctx, second.token), true);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    closeAllRuntimeDatabases();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('switching to a single-slot preset drains all concurrent requests first', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-drain-',
    'exl3-main',
    { main: 2, alt: 1 },
  );
  const { ctx, coordinator } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    assert.equal(releaseModelRequest(ctx, first.token), true);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(releaseModelRequest(ctx, second.token), true);
    await waitForActivePreset(coordinator, 'exl3-alt');

    // Under the single-slot preset the very next pair must serialize again.
    const third = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(third);
    assert.equal(getModelRequestQueueDiagnostics(ctx).activeCount, 1);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('preset switch arms idle for the preset that becomes active', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-idle-switch-', 'exl3-alt');
  const { ctx, coordinator } = harness;
  try {
    const altLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(altLock);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    assert.equal(releaseModelRequest(ctx, altLock.token), true);
    await waitForActivePreset(coordinator, 'exl3-main');
    assert.notEqual(ctx.modelIdleController?.getIdleDeadlineUtc(), null);

    const mainLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(mainLock);
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    assert.equal(releaseModelRequest(ctx, mainLock.token), true);
    await waitForActivePreset(coordinator, 'exl3-alt');
    assert.notEqual(ctx.modelIdleController?.getIdleDeadlineUtc(), null);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('model request admission logs queue position without waking the engine', async () => {
  const ctx = createQueueContext();
  try {
    const capture = OutputCapture.start(process.stdout);
    try {
      const lock = await acquireModelRequestWithWait(ctx, 'summary');
      assert.ok(lock);
      assert.equal(releaseModelRequest(ctx, lock.token), true);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.ok(lines.some((line) => /st -{8}  incoming  task=summary queue_position=1/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_acquired  task=summary wait_ms=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_released  task=summary held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued model request logs its FIFO position while waiting', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    let queuedLockPromise: Promise<Awaited<ReturnType<typeof acquireModelRequestWithWait>>> | null = null;

    const capture = OutputCapture.start(process.stdout);
    try {
      // Enqueueing is synchronous: the FIFO position is logged the moment the queued
      // acquire is called, before it awaits — no wall-clock wait is needed to observe it.
      queuedLockPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
      try {
        assert.ok(capture.lines.some((line) => /st -{8}  incoming  task=dashboard_chat queue_position=2/u.test(line)), capture.lines.join('\n'));
      } finally {
        assert.equal(releaseModelRequest(ctx, activeLock.token), true);
        const queuedLock = await queuedLockPromise;
        assert.ok(queuedLock);
        assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
      }
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.ok(lines.some((line) => /st -{8}  incoming  task=dashboard_chat queue_position=2/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_acquired  task=dashboard_chat wait_ms=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_released  task=dashboard_chat held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued model request times out, cancels, and logs the dropped request', async (t) => {
  // Virtual time: the queue timeout is driven by tick(), so the relative ordering is
  // exact and load-independent — no real ~25ms window that event-loop jitter can break.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const capture = OutputCapture.start(process.stdout);
    try {
      const queuedPromise = acquireModelRequestWithWait(ctx, 'summary', undefined, undefined, { timeoutMs: 25 });
      assert.equal(ctx.modelRequestQueue.length, 1);
      t.mock.timers.tick(25);
      assert.equal(await queuedPromise, null);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.deepEqual([...ctx.activeModelRequests.keys()], [activeLock.token]);
    assert.ok(lines.some((line) => /st [\w-]{8}  dropped  reason=model_queue_timeout task=summary/u.test(line)), lines.join('\n'));

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued model request timeout resets when an earlier queued request drops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const firstQueuedLockPromise = acquireModelRequestWithWait(ctx, 'summary', undefined, undefined, { timeoutMs: 30 });
    const secondQueuedLockPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat', undefined, undefined, { timeoutMs: 60 });
    assert.equal(ctx.modelRequestQueue.length, 2);

    // At t=30 the summary waiter times out; dashboard_chat's position improves (3 -> 2),
    // which restarts its 60ms window from t=30 (so it would now fire at t=90).
    t.mock.timers.tick(30);
    assert.equal(await firstQueuedLockPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 1);
    assert.equal(ctx.modelRequestQueue[0]?.kind, 'dashboard_chat');

    // Advance to t=70. Without the reset, dashboard_chat's original window would have
    // fired at t=60 and dropped it; because the window reset, it is still queued.
    t.mock.timers.tick(40);
    assert.equal(ctx.modelRequestQueue.length, 1);
    assert.equal(ctx.modelRequestQueue[0]?.kind, 'dashboard_chat');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const secondQueuedLock = await secondQueuedLockPromise;
    assert.ok(secondQueuedLock);
    assert.equal(secondQueuedLock.kind, 'dashboard_chat');
    assert.equal(releaseModelRequest(ctx, secondQueuedLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued model request still times out after its reset window expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const firstQueuedLockPromise = acquireModelRequestWithWait(ctx, 'summary', undefined, undefined, { timeoutMs: 25 });
    const secondQueuedLockPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat', undefined, undefined, { timeoutMs: 35 });

    // summary drops at t=25, resetting dashboard_chat's 35ms window from t=25 (fires at t=60).
    t.mock.timers.tick(25);
    assert.equal(await firstQueuedLockPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 1);

    // Advance past the reset window to t=60: dashboard_chat times out even after the reset.
    t.mock.timers.tick(35);
    assert.equal(await secondQueuedLockPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.deepEqual([...ctx.activeModelRequests.keys()], [activeLock.token]);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('model request hold ceiling default is one hour', () => {
  assert.equal(DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS, 3_600_000);
});

function useInactivityTimeout(t: TestContext, timeoutMs: number): void {
  process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS = String(timeoutMs);
  t.after(() => {
    delete process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS;
  });
}

/**
 * Expiry compares `Date.now()` against the lock's last activity, so a mocked `setTimeout` with a
 * real clock would read zero elapsed time and re-arm forever. Both must advance together.
 */
function useLockClock(t: TestContext, timeoutMs: number): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  useInactivityTimeout(t, timeoutMs);
}

// Without a timeout a holder that never releases wedges the server for every later request:
// one stuck operation held the lock for 943s with a queue behind it and no way out.
test('a model request silent past the inactivity timeout is force-released and the queue drains', async (t) => {
  useLockClock(t, 25);
  const ctx = createQueueContext();
  try {
    const stuckLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(stuckLock);
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');
    assert.equal(ctx.modelRequestQueue.length, 1);

    const capture = OutputCapture.start(process.stdout);
    try {
      t.mock.timers.tick(25);
      const queuedLock = await queuedLockPromise;
      assert.ok(queuedLock);
      assert.deepEqual([...ctx.activeModelRequests.keys()], [queuedLock.token]);
      assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.ok(
      lines.some((line) => /st [\w-]{8}  expired  reason=model_inactivity_timeout task=repo_search/u.test(line)),
      lines.join('\n'),
    );
    // The holder's own release finds nothing left to release, which is how it learns it lost the lock.
    assert.equal(releaseModelRequest(ctx, stuckLock.token), false);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('releasing a model request cancels its inactivity timeout', async (t) => {
  useLockClock(t, 25);
  const ctx = createQueueContext();
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);
    assert.equal(releaseModelRequest(ctx, lock.token), true);

    const capture = OutputCapture.start(process.stdout);
    try {
      t.mock.timers.tick(100);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(lines.some((line) => line.includes('model_inactivity_timeout')), false, lines.join('\n'));
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

// The one-hour timeout is an inactivity timeout for run-owned holders: a run that keeps
// reporting activity keeps the model, and only silence takes it back.
test('a renewed model request survives past the original timeout and keeps its start time', async (t) => {
  useLockClock(t, 100);
  const ctx = createQueueContext();
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);
    const startedAtUtc = lock.startedAtUtc;

    const capture = OutputCapture.start(process.stdout);
    try {
      for (let tick = 0; tick < 5; tick += 1) {
        t.mock.timers.tick(80);
        assert.equal(renewModelRequestActivity(ctx, lock.token), true);
      }
      t.mock.timers.tick(80);
    } finally {
      capture.restore();
    }

    assert.equal(capture.lines.some((line) => line.includes('model_inactivity_timeout')), false, capture.lines.join('\n'));
    assert.deepEqual([...ctx.activeModelRequests.keys()], [lock.token]);
    assert.equal(getModelRequestQueueDiagnostics(ctx).activeRequests[0]?.startedAtUtc, startedAtUtc);
    assert.equal(releaseModelRequest(ctx, lock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

// Renewal only moves the deadline forward; it must not buy a holder extra silent time.
test('a renewed model request still expires after a full window of silence', async (t) => {
  useLockClock(t, 100);
  const ctx = createQueueContext();
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);
    t.mock.timers.tick(80);
    assert.equal(renewModelRequestActivity(ctx, lock.token), true);

    const capture = OutputCapture.start(process.stdout);
    try {
      // The timer armed at grant fires at 100 and finds activity at 80, so it re-arms for the
      // remaining 80 instead of expiring: silence is measured from the renewal, not the grant.
      t.mock.timers.tick(99);
      assert.equal(ctx.activeModelRequests.size, 1, 'still held 99ms after the last renewal');
      t.mock.timers.tick(1);
    } finally {
      capture.restore();
    }

    assert.equal(capture.lines.some((line) => line.includes('model_inactivity_timeout')), true, capture.lines.join('\n'));
    assert.equal(ctx.activeModelRequests.size, 0);
    // An expired token cannot be revived: renewal reports that it lost the lock.
    assert.equal(renewModelRequestActivity(ctx, lock.token), false);
    assert.equal(ctx.activeModelRequests.size, 0);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('model request renewal is token-scoped and cannot renew another holder', async (t) => {
  useLockClock(t, 100);
  const ctx = createQueueContext();
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(first);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(second);
    // The previous holder's token names no active lock, so it renews nothing for the new one.
    assert.equal(renewModelRequestActivity(ctx, first.token), false);

    const capture = OutputCapture.start(process.stdout);
    try {
      t.mock.timers.tick(100);
    } finally {
      capture.restore();
    }

    assert.equal(capture.lines.some((line) => line.includes('model_inactivity_timeout')), true, capture.lines.join('\n'));
    assert.equal(ctx.activeModelRequests.size, 0);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

// Renewal must cost a timestamp write, not a timer swap: it runs on every streamed token.
test('renewing a model request does not churn timers', async (t) => {
  useLockClock(t, 100);
  const ctx = createQueueContext();
  const clearTimeoutCalls = t.mock.method(globalThis, 'clearTimeout');
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);
    const clearsAfterAcquire = clearTimeoutCalls.mock.callCount();

    for (let renewal = 0; renewal < 50; renewal += 1) {
      assert.equal(renewModelRequestActivity(ctx, lock.token), true);
    }

    assert.equal(clearTimeoutCalls.mock.callCount(), clearsAfterAcquire, '50 renewals cleared a timer');
    assert.equal(releaseModelRequest(ctx, lock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('model request diagnostics expose the active lock and queued requests', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    // Enqueueing is synchronous, so the diagnostics reflect the queued request immediately.
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');

    const diagnostics = getModelRequestQueueDiagnostics(ctx);
    assert.equal(diagnostics.activeCount, 1);
    assert.equal(diagnostics.activeRequests[0]?.kind, 'repo_search');
    assert.equal(diagnostics.queueLength, 1);
    assert.equal(diagnostics.queuedRequests[0]?.kind, 'summary');
    assert.equal(typeof diagnostics.activeRequests[0]?.heldMs, 'number');
    assert.equal(typeof diagnostics.queuedRequests[0]?.waitMs, 'number');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('release grants the next queued model request without waiting for polling timers', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    // Enqueueing is synchronous; releasing the active lock grants the queued request on the
    // next drain pass, without waiting on any polling timer.
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.deepEqual([...ctx.activeModelRequests.values()].map((lock) => lock.kind), ['summary']);
    assert.deepEqual([...ctx.activeModelRequests.keys()], [queuedLock.token]);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('active and queued model requests keep the server out of idle state', async () => {
  const ctx = createQueueContext();
  try {
    assert.equal(isIdle(ctx), true);

    const activeLock = await acquireModelRequestWithWait(ctx, 'passthrough');
    assert.ok(activeLock);
    assert.equal(isIdle(ctx), false);

    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');
    assert.equal(isIdle(ctx), false);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.equal(isIdle(ctx), false);

    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
    assert.equal(isIdle(ctx), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('model request acquire clears pending idle unload timer and release reschedules it', async () => {
  const ctx = createQueueContext();
  try {
    ctx.idleSummary.pending = true;
    ctx.idleSummary.timer = setTimeout(() => {}, 10_000);

    const lock = await acquireModelRequestWithWait(ctx, 'passthrough');
    assert.ok(lock);
    assert.equal(ctx.idleSummary.timer, null);

    assert.equal(releaseModelRequest(ctx, lock.token), true);
    assert.notEqual(ctx.idleSummary.timer, null);
  } finally {
    if (ctx.idleSummary.timer) {
      clearTimeout(ctx.idleSummary.timer);
      ctx.idleSummary.timer = null;
    }
    await ctx.inferenceRunFlushQueue.close();
  }
});

// The real renewal path: a headless provider stream whose frames arrive slower than the
// original deadline would allow. Each validated frame is activity, so the same reservation
// survives several windows; a full window of silence after the stream still expires it.
test('a headless provider stream renews the model request past its original hold ceiling', async (t) => {
  useLockClock(t, 100);
  const ctx = createQueueContext();
  class SlowStreamingClient {
    async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
      throw new Error('not used');
    }
    async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
      for (let frame = 0; frame < 5; frame += 1) {
        t.mock.timers.tick(80);
        yield { event: 'message', data: JSON.stringify({ choices: [{ delta: { content: `t${frame} ` } }] }) };
      }
      yield { event: 'message', data: '[DONE]' };
    }
  }
  try {
    const lock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(lock);
    const config = readConfig(ctx.configPath);
    const response = await new InferenceClient(new SlowStreamingClient()).chat({
      throughputAudit: TEST_THROUGHPUT_AUDIT,
      config,
      baseUrl: DEAD_BASE_URL,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      retry: false,
      activityObserver: { recordActivity: () => { renewModelRequestActivity(ctx, lock.token); } },
    });
    assert.equal(response.text, 't0 t1 t2 t3 t4 ');
    // 400ms of streaming against a 100ms window, and the reservation is untouched.
    assert.deepEqual([...ctx.activeModelRequests.keys()], [lock.token]);
    assert.equal(getModelRequestQueueDiagnostics(ctx).activeRequests[0]?.startedAtUtc, lock.startedAtUtc);

    t.mock.timers.tick(100);
    assert.equal(ctx.activeModelRequests.size, 0, 'a full silent window after the stream expires the lock');
    assert.equal(releaseModelRequest(ctx, lock.token), false);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

const ROUTING_SLOTS_ONE = {
  [PRESET_ROUTING_MODEL_A]: 1,
  [PRESET_ROUTING_MODEL_B]: 1,
  [PRESET_ROUTING_MODEL_C]: 1,
} satisfies Record<string, number>;

test('resident A requests overtake an older B request in the observed grant order', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-aba-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx, coordinator } = harness;
  try {
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const bPromise = acquireModelRequestWithWait(ctx, 'b1', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    const a1Promise = acquireModelRequestWithWait(ctx, 'a1');
    const a2Promise = acquireModelRequestWithWait(ctx, 'a2');
    const grantOrder: string[] = [];
    for (const [label, promise] of [['b1', bPromise], ['a1', a1Promise], ['a2', a2Promise]] as const) {
      void promise.then((lock) => {
        assert.ok(lock);
        grantOrder.push(label);
      });
    }

    assert.equal(releaseModelRequest(ctx, seed.token), true);
    const a1 = await a1Promise;
    assert.ok(a1);
    assert.deepEqual(grantOrder, ['a1']);
    assert.equal(a1.context.modelPreset.id, PRESET_ROUTING_MODEL_A);
    assert.equal(a1.residencyKey, ctx.modelRuntime.getPresetResidencyKey(a1.context.modelPreset));
    assert.equal(ctx.modelRequestQueue.length, 2);
    assert.equal(releaseModelRequest(ctx, a1.token), true);

    const a2 = await a2Promise;
    assert.ok(a2);
    assert.deepEqual(grantOrder, ['a1', 'a2']);
    assert.equal(releaseModelRequest(ctx, a2.token), true);

    const b1 = await bPromise;
    assert.ok(b1);
    assert.deepEqual(grantOrder, ['a1', 'a2', 'b1']);
    assert.equal(b1.context.modelPreset.id, PRESET_ROUTING_MODEL_B);
    assert.equal(coordinator.getStatus().activePresetId, PRESET_ROUTING_MODEL_B);
    assert.equal(releaseModelRequest(ctx, b1.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('two active A requests are admitted before the older B request', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-two-a-', PRESET_ROUTING_MODEL_A, {
    [PRESET_ROUTING_MODEL_A]: 2,
    [PRESET_ROUTING_MODEL_B]: 1,
    [PRESET_ROUTING_MODEL_C]: 1,
  });
  const { ctx } = harness;
  try {
    // The seed holds one A slot so the lone B request cannot start a transition on its own.
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const bPromise = acquireModelRequestWithWait(ctx, 'b1', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    const a1Promise = acquireModelRequestWithWait(ctx, 'a1');
    const a2Promise = acquireModelRequestWithWait(ctx, 'a2');

    const a1 = await a1Promise;
    assert.ok(a1);
    assert.equal(releaseModelRequest(ctx, seed.token), true);
    const a2 = await a2Promise;
    assert.ok(a2);
    assert.equal(ctx.activeModelRequests.size, 2);
    assert.equal(ctx.modelRequestQueue.length, 1);
    assert.equal(ctx.modelRequestQueue[0]?.kind, 'b1');

    assert.equal(releaseModelRequest(ctx, a1.token), true);
    assert.equal(releaseModelRequest(ctx, a2.token), true);
    const b1 = await bPromise;
    assert.ok(b1);
    assert.equal(b1.context.modelPreset.id, PRESET_ROUTING_MODEL_B);
    assert.equal(releaseModelRequest(ctx, b1.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('same-residency profiles with different sampling admit without a model transition', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-sampling-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx, coordinator, events } = harness;
  try {
    const warm = readConfig(ctx.configPath);
    const base = warm.Server.ModelPresets.Presets.find((preset) => preset.id === PRESET_ROUTING_MODEL_A);
    if (!base) throw new Error('Model A preset is missing');
    warm.Server.ModelPresets.Presets = [
      ...warm.Server.ModelPresets.Presets,
      { ...base, id: 'model-a-warm', label: 'model-a-warm', Temperature: 0.9 },
    ];
    warm.Presets = warm.Presets.map((preset) => (
      preset.id === 'repo-search' ? { ...preset, modelPresetId: 'model-a-warm' } : preset
    ));
    writeConfig(ctx.configPath, warm);

    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const warmPromise = acquireModelRequestWithWait(ctx, 'warm', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    assert.equal(releaseModelRequest(ctx, seed.token), true);
    const warmLock = await warmPromise;
    assert.ok(warmLock);
    assert.equal(warmLock.context.modelPreset.id, 'model-a-warm');
    assert.equal(warmLock.residencyKey, ctx.modelRuntime.getPresetResidencyKey(seed.context.modelPreset));
    assert.equal(coordinator.getStatus().activePresetId, 'model-a-warm');
    assert.deepEqual(events, ['start:exl3', `load:${PRESET_ROUTING_MODEL_A}`]);
    assert.equal(readConfig(ctx.configPath).Server.ModelPresets.ActivePresetId, 'model-a-warm');
    assert.equal(releaseModelRequest(ctx, warmLock.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('a capacity-only profile change re-admits queued requests without a coordinator', async () => {
  const root = createManagedTempDir('siftkit-model-queue-nocoord-capacity-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = createPresetRoutingConfig();
  config.Server.ModelPresets = {
    ActivePresetId: PRESET_ROUTING_MODEL_A,
    Presets: config.Server.ModelPresets.Presets.map((preset) => ({ ...preset, ParallelSlots: 1 })),
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  try {
    const first = await acquireModelRequestWithWait(ctx, 'a1');
    assert.ok(first);
    const secondPromise = acquireModelRequestWithWait(ctx, 'a2');
    const thirdPromise = acquireModelRequestWithWait(ctx, 'a3');
    assert.equal(ctx.modelRequestQueue.length, 2);

    const updated = readConfig(ctx.configPath);
    updated.Server.ModelPresets.Presets = updated.Server.ModelPresets.Presets.map((preset) => (
      preset.id === PRESET_ROUTING_MODEL_A ? { ...preset, ParallelSlots: 3 } : preset
    ));
    writeConfig(ctx.configPath, updated);
    ctx.appliedModelPresetState.applyPreset(getActiveModelPreset(updated));
    resumeModelRequestAdmission(ctx);

    const second = await secondPromise;
    const third = await thirdPromise;
    assert.ok(second);
    assert.ok(third);
    assert.equal(ctx.activeModelRequests.size, 3);
    assert.equal(second.context.modelPreset.ParallelSlots, 3);
    assert.equal(ctx.modelRuntime.getModelState(), 'unloaded');
    for (const lock of [first, second, third]) {
      assert.equal(releaseModelRequest(ctx, lock.token), true);
    }
  } finally {
    closeAllRuntimeDatabases();
    fs.rmSync(root, { recursive: true, force: true });
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued intents resolve against the current saved config on each scheduling pass', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-frozen-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx, coordinator, events } = harness;
  try {
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const pending = acquireModelRequestWithWait(ctx, 'inherited', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });

    // Saved while the waiter is queued: repo-search now references the resident model A.
    const updated = readConfig(ctx.configPath);
    updated.Presets = updated.Presets.map((preset) => (
      preset.id === 'repo-search' ? { ...preset, modelPresetId: PRESET_ROUTING_MODEL_A } : preset
    ));
    writeConfig(ctx.configPath, updated);

    assert.equal(releaseModelRequest(ctx, seed.token), true);
    const lock = await pending;
    assert.ok(lock);
    assert.equal(lock.context.modelPreset.id, PRESET_ROUTING_MODEL_A);
    assert.equal(coordinator.getStatus().activePresetId, PRESET_ROUTING_MODEL_A);
    assert.deepEqual(events, ['start:exl3', `load:${PRESET_ROUTING_MODEL_A}`]);
    assert.equal(releaseModelRequest(ctx, lock.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('an invalid intent rejects only its waiter and does not poison other waiters', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-invalid-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx } = harness;
  try {
    // The seed holds the single A slot so both waiters stay queued for one scheduling pass.
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const validPromise = acquireModelRequestWithWait(ctx, 'valid');
    const invalidPromise = acquireModelRequestWithWait(ctx, 'invalid', undefined, undefined, {
      intent: { presetId: null, model: 'no-such-model' },
    });
    assert.equal(ctx.modelRequestQueue.length, 2);

    assert.equal(releaseModelRequest(ctx, seed.token), true);
    await assert.rejects(invalidPromise, /does not match any configured model preset/u);
    const valid = await validPromise;
    assert.ok(valid);
    assert.equal(valid.context.modelPreset.id, PRESET_ROUTING_MODEL_A);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.equal(ctx.activeModelRequests.size, 1);
    assert.equal(releaseModelRequest(ctx, valid.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('a coordinator-free server fails an incompatible target and admits a compatible profile change', async () => {
  const root = createManagedTempDir('siftkit-model-queue-nocoord-boundary-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = createPresetRoutingConfig();
  config.Server.ModelPresets = {
    ActivePresetId: PRESET_ROUTING_MODEL_A,
    Presets: config.Server.ModelPresets.Presets.map((preset) => ({ ...preset, ParallelSlots: 1 })),
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  try {
    const cross = acquireModelRequestWithWait(ctx, 'cross', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    await assert.rejects(cross, /cannot switch/u);
    assert.equal(ctx.activeModelRequests.size, 0);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.equal(ctx.appliedModelPresetState.getPreset().id, PRESET_ROUTING_MODEL_A);
    assert.equal(ctx.modelRuntime.getModelState(), 'unloaded');

    // A same-residency profile edit is compatible: applied state updates, no engine activity.
    const updated = readConfig(ctx.configPath);
    updated.Server.ModelPresets.Presets = updated.Server.ModelPresets.Presets.map((preset) => (
      preset.id === PRESET_ROUTING_MODEL_A ? { ...preset, Temperature: 0.9 } : preset
    ));
    writeConfig(ctx.configPath, updated);
    ctx.appliedModelPresetState.applyPreset(getActiveModelPreset(updated));
    resumeModelRequestAdmission(ctx);

    const same = await acquireModelRequestWithWait(ctx, 'same');
    assert.ok(same);
    assert.equal(same.context.modelPreset.id, PRESET_ROUTING_MODEL_A);
    assert.equal(same.context.modelPreset.Temperature, 0.9);
    assert.equal(ctx.modelRuntime.getModelState(), 'unloaded');
    assert.equal(releaseModelRequest(ctx, same.token), true);
  } finally {
    closeAllRuntimeDatabases();
    fs.rmSync(root, { recursive: true, force: true });
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('cancelling a selected waiter lets its irreversible load complete without granting the lock', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-cancel-ready-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx, coordinator, exl3Runtime, events } = harness;
  try {
    exl3Runtime.blockNextEnsure();
    const controller = new AbortController();
    const promise = acquireModelRequestWithWait(ctx, 'cancel-me', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
      abortSignal: controller.signal,
    });
    await exl3Runtime.transitionStarted.promise;
    controller.abort();

    assert.equal(await promise, null);
    assert.equal(ctx.activeModelRequests.size, 0);
    assert.equal(ctx.modelRequestQueue.length, 0);

    exl3Runtime.releaseEnsure();
    await waitForActivePreset(coordinator, PRESET_ROUTING_MODEL_B);
    assert.deepEqual(events.filter((event) => event.startsWith('load:')), [
      `load:${PRESET_ROUTING_MODEL_A}`,
      `load:${PRESET_ROUTING_MODEL_B}`,
    ]);

    const next = await acquireModelRequestWithWait(ctx, 'after');
    assert.ok(next);
    assert.equal(next.context.modelPreset.id, PRESET_ROUTING_MODEL_B);
    assert.equal(releaseModelRequest(ctx, next.token), true);
  } finally {
    exl3Runtime.releaseEnsure();
    await closePresetQueueHarness(harness);
  }
});

test('a readiness failure rejects the waiter and the next admission of the same target succeeds', async () => {
  const events: string[] = [];
  const failing = new FailingQueueRuntime(events);
  failing.failNextEnsure(PRESET_ROUTING_MODEL_B);
  const harness = await createRoutingQueueHarness('siftkit-model-queue-fail-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE, failing);
  const { ctx, coordinator } = harness;
  try {
    const first = acquireModelRequestWithWait(ctx, 'first', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    await assert.rejects(first, /load failed: model-b/u);
    assert.equal(coordinator.getStatus().activePresetId, PRESET_ROUTING_MODEL_A);
    assert.equal(ctx.activeModelRequests.size, 0);
    assert.equal(ctx.modelRequestQueue.length, 0);

    const second = await acquireModelRequestWithWait(ctx, 'second', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
    });
    assert.ok(second);
    assert.equal(second.context.modelPreset.id, PRESET_ROUTING_MODEL_B);
    assert.equal(coordinator.getStatus().activePresetId, PRESET_ROUTING_MODEL_B);
    assert.equal(releaseModelRequest(ctx, second.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('repeated affinity bypass does not extend an older waiter\u0027s timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = await createRoutingQueueHarness('siftkit-model-queue-bypass-timeout-', PRESET_ROUTING_MODEL_A, {
    [PRESET_ROUTING_MODEL_A]: 2,
    [PRESET_ROUTING_MODEL_B]: 1,
    [PRESET_ROUTING_MODEL_C]: 1,
  });
  const { ctx } = harness;
  try {
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const bPromise = acquireModelRequestWithWait(ctx, 'older-b', undefined, undefined, {
      intent: { presetId: 'repo-search', model: null },
      timeoutMs: 100,
    });
    for (let bypass = 0; bypass < 3; bypass += 1) {
      const bypassLock = await acquireModelRequestWithWait(ctx, `bypass-${bypass}`);
      assert.ok(bypassLock);
      assert.equal(releaseModelRequest(ctx, bypassLock.token), true);
    }

    t.mock.timers.tick(100);
    assert.equal(await bPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.equal(releaseModelRequest(ctx, seed.token), true);
  } finally {
    t.mock.timers.reset();
    await closePresetQueueHarness(harness);
  }
});

test('an inherited-current waiter resolves to the model applied after a switch', async () => {
  const harness = await createRoutingQueueHarness('siftkit-model-queue-inherited-', PRESET_ROUTING_MODEL_A, ROUTING_SLOTS_ONE);
  const { ctx, coordinator, events } = harness;
  try {
    const seed = await acquireModelRequestWithWait(ctx, 'seed');
    assert.ok(seed);
    const pending = acquireModelRequestWithWait(ctx, 'inherited');
    assert.equal(await coordinator.applyPreset(PRESET_ROUTING_MODEL_B), 'queued');

    assert.equal(releaseModelRequest(ctx, seed.token), true);
    const lock = await pending;
    assert.ok(lock);
    assert.equal(lock.context.modelPreset.id, PRESET_ROUTING_MODEL_B);
    assert.equal(coordinator.getStatus().activePresetId, PRESET_ROUTING_MODEL_B);
    assert.deepEqual(events, [
      'start:exl3',
      `load:${PRESET_ROUTING_MODEL_A}`,
      'unload:exl3',
      `load:${PRESET_ROUTING_MODEL_B}`,
    ]);
    assert.equal(releaseModelRequest(ctx, lock.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});
