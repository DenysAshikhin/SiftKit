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
  releaseModelRequest,
} from '../src/status-server/server-ops.js';
import type { ModelRequestLock, ServerContext } from '../src/status-server/server-types.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { ModelIdleController } from '../src/status-server/model-idle-controller.js';
import type { ModelLifecycleActionResult } from '@siftkit/contracts';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { RecordingInferenceRuntime as QueueRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { OutputCapture } from './helpers/stdout-capture.js';

const queueContextRoot = createManagedTempDir('siftkit-model-queue-contexts-');
let queueContextIndex = 0;

test.after(async () => {
  closeRuntimeDatabase();
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
  ctx.modelIdleController = new ModelIdleController(ctx);
  await coordinator.initialize();
  return { ctx, coordinator, exl3Runtime, events, root };
}

async function closePresetQueueHarness(harness: PresetQueueHarness): Promise<void> {
  harness.ctx.modelIdleController?.cancelForPresetChange();
  await harness.ctx.inferenceRunFlushQueue.close();
  await harness.coordinator.shutdown();
  closeRuntimeDatabase();
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
    assert.deepEqual(harness.events.slice(-2), ['unload:exl3', 'stop:exl3']);

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
    closeRuntimeDatabase();
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
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_acquired  task=summary wait_ms=0/u.test(line)), lines.join('\n'));
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

function useHoldCeiling(t: TestContext, ceilingMs: number): void {
  process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS = String(ceilingMs);
  t.after(() => {
    delete process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS;
  });
}

// Without a ceiling a holder that never releases wedges the server for every later request:
// one stuck operation held the lock for 943s with a queue behind it and no way out.
test('a model request held past the ceiling is force-released and the queue drains', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  useHoldCeiling(t, 25);
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
      lines.some((line) => /st [\w-]{8}  expired  reason=model_hold_ceiling task=repo_search/u.test(line)),
      lines.join('\n'),
    );
    // The holder's own release finds nothing left to release, which is how it learns it lost the lock.
    assert.equal(releaseModelRequest(ctx, stuckLock.token), false);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('releasing a model request cancels its hold ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  useHoldCeiling(t, 25);
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

    assert.equal(lines.some((line) => line.includes('model_hold_ceiling')), false, lines.join('\n'));
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
    // Enqueueing is synchronous; releasing the active lock grants the queued request
    // immediately, without waiting on any polling timer.
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.deepEqual([...ctx.activeModelRequests.values()].map((lock) => lock.kind), ['summary']);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
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
