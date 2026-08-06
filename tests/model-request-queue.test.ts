import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getActiveModelPreset } from '../src/config/getters.js';
import { getDefaultConfig, readConfig } from '../src/status-server/config-store.js';
import {
  DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS,
  acquireModelRequestWithWait,
  getModelRequestQueueDiagnostics,
  isIdle,
  releaseModelRequest,
} from '../src/status-server/server-ops.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { ModelIdleController } from '../src/status-server/model-idle-controller.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { RecordingInferenceRuntime as QueueRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';

type StdoutLine = string;

const queueContextRoot = createManagedTempDir('siftkit-model-queue-contexts-');
let queueContextIndex = 0;

test.after(async () => {
  closeRuntimeDatabase();
  fs.rmSync(queueContextRoot, { recursive: true, force: true });
});

type PresetParallelSlots = {
  llama: number;
  exl3: number;
};

const DEFAULT_PRESET_PARALLEL_SLOTS = {
  llama: 1,
  exl3: 2,
} satisfies PresetParallelSlots;

function createQueueContext(configPath?: string): ServerContext & { readonly wakeCount: number } {
  const resolvedConfigPath = configPath
    ?? path.join(queueContextRoot, `runtime-${queueContextIndex += 1}.sqlite`);
  const config = configPath === undefined ? getDefaultConfig() : readConfig(resolvedConfigPath);
  if (configPath === undefined) {
    writeConfig(resolvedConfigPath, config);
  }
  let wakeCount = 0;
  return {
    ...createTestServerContext(resolvedConfigPath),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(config)),
    async ensureManagedLlamaReady() {
      wakeCount += 1;
      return getDefaultConfig();
    },
    get wakeCount(): number {
      return wakeCount;
    },
  };
}

test('model request queue timeout default is fifteen minutes', () => {
  assert.equal(DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS, 900_000);
});

type PresetQueueHarness = {
  ctx: ServerContext & { readonly wakeCount: number };
  coordinator: PresetRuntimeCoordinator;
  events: string[];
  root: string;
};

async function createPresetQueueHarness(
  prefix: string,
  activePresetId: string,
  parallelSlots: PresetParallelSlots = DEFAULT_PRESET_PARALLEL_SLOTS,
): Promise<PresetQueueHarness> {
  const root = createManagedTempDir(prefix);
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfig();
  const basePreset = config.Server.ModelPresets.Presets[0];
  if (!basePreset) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: activePresetId,
    Presets: [
      { ...basePreset, id: 'llama-main', Backend: 'llama', ParallelSlots: parallelSlots.llama },
      { ...basePreset, id: 'exl3-main', Backend: 'exl3', SleepIdleSeconds: 1, ParallelSlots: parallelSlots.exl3 },
    ],
  };
  writeConfig(configPath, config);
  const ctx = createQueueContext(configPath);
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new QueueRuntime('llama', events),
    new QueueRuntime('exl3', events),
    ctx.activeModelRequests,
    ctx.appliedModelPresetState,
  );
  ctx.presetRuntimeCoordinator = coordinator;
  ctx.modelIdleController = new ModelIdleController(ctx);
  await coordinator.initialize();
  return { ctx, coordinator, events, root };
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

test('backend transition pauses queued admission until the new runtime is ready', async () => {
  const { ctx, coordinator, events, root } = await createPresetQueueHarness('siftkit-model-queue-preset-', 'llama-main');
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(activeLock);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'repo_search');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;

    assert.ok(queuedLock);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.deepEqual(events, ['start:llama', 'load:llama-main', 'stop:llama', 'start:exl3', 'load:exl3-main']);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await closePresetQueueHarness({ ctx, coordinator, events, root });
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

test('ParallelSlots allows two llama requests before queueing the third', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-llama-',
    'llama-main',
    { llama: 2, exl3: 2 },
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

test('ParallelSlots limits coordinator-free capacity to configured value', async () => {
  const root = createManagedTempDir('siftkit-model-queue-config-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfig();
  const basePreset = config.Server.ModelPresets.Presets[0];
  if (!basePreset) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: 'llama-main',
    Presets: [
      { ...basePreset, id: 'llama-main', Backend: 'llama', ParallelSlots: 2 },
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

test('switching exl3 to llama drains all concurrent requests first', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-drain-',
    'exl3-main',
    { llama: 1, exl3: 2 },
  );
  const { ctx, coordinator } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);
    assert.equal(await coordinator.applyPreset('llama-main'), 'queued');
    assert.equal(releaseModelRequest(ctx, first.token), true);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(releaseModelRequest(ctx, second.token), true);
    await waitForActivePreset(coordinator, 'llama-main');

    // Under llama the very next pair must serialize again.
    const third = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(third);
    assert.equal(getModelRequestQueueDiagnostics(ctx).activeCount, 1);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('preset switch arms idle only for the runtime that becomes active', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-idle-switch-', 'llama-main');
  const { ctx, coordinator } = harness;
  try {
    const llamaLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(llamaLock);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    assert.equal(releaseModelRequest(ctx, llamaLock.token), true);
    await waitForActivePreset(coordinator, 'exl3-main');
    assert.notEqual(ctx.modelIdleController?.getIdleDeadlineUtc(), null);

    const exl3Lock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(exl3Lock);
    assert.equal(await coordinator.applyPreset('llama-main'), 'queued');
    assert.equal(releaseModelRequest(ctx, exl3Lock.token), true);
    await waitForActivePreset(coordinator, 'llama-main');
    assert.equal(ctx.modelIdleController?.getIdleDeadlineUtc(), null);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

async function captureStdoutLines(fn: (lines: StdoutLine[]) => Promise<void>): Promise<StdoutLine[]> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: StdoutLine[] = [];
  let buffer = '';
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) {
        lines.push(line);
      }
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  try {
    await fn(lines);
  } finally {
    process.stdout.write = originalWrite;
  }
  if (buffer.trim()) {
    lines.push(buffer.trim());
  }
  return lines;
}

test('model request admission logs queue position without probing llama', async () => {
  const ctx = createQueueContext();
  try {
    const lines = await captureStdoutLines(async () => {
      const lock = await acquireModelRequestWithWait(ctx, 'summary');
      assert.ok(lock);
      assert.equal(releaseModelRequest(ctx, lock.token), true);
    });

    assert.equal(ctx.wakeCount, 0);
    assert.ok(lines.some((line) => /st -{8}  incoming  task=summary queue_position=1/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_acquired  task=summary wait_ms=0/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /st [\w-]{8}  lock_released  task=summary held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('queued model request logs its FIFO position without probing llama while waiting', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    let queuedLockPromise: Promise<Awaited<ReturnType<typeof acquireModelRequestWithWait>>> | null = null;

    const lines = await captureStdoutLines(async (currentLines) => {
      // Enqueueing is synchronous: the FIFO position is logged the moment the queued
      // acquire is called, before it awaits — no wall-clock wait is needed to observe it.
      queuedLockPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
      try {
        assert.equal(ctx.wakeCount, 0);
        assert.ok(currentLines.some((line) => /st -{8}  incoming  task=dashboard_chat queue_position=2/u.test(line)), currentLines.join('\n'));
      } finally {
        assert.equal(releaseModelRequest(ctx, activeLock.token), true);
        const queuedLock = await queuedLockPromise;
        assert.ok(queuedLock);
        assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
      }
    });

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

    const lines = await captureStdoutLines(async () => {
      const queuedPromise = acquireModelRequestWithWait(ctx, 'summary', undefined, undefined, { timeoutMs: 25 });
      assert.equal(ctx.modelRequestQueue.length, 1);
      t.mock.timers.tick(25);
      assert.equal(await queuedPromise, null);
    });

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
    ctx.idleSummaryPending = true;
    ctx.idleSummaryTimer = setTimeout(() => {}, 10_000);

    const lock = await acquireModelRequestWithWait(ctx, 'passthrough');
    assert.ok(lock);
    assert.equal(ctx.idleSummaryTimer, null);

    assert.equal(releaseModelRequest(ctx, lock.token), true);
    assert.notEqual(ctx.idleSummaryTimer, null);
  } finally {
    if (ctx.idleSummaryTimer) {
      clearTimeout(ctx.idleSummaryTimer);
      ctx.idleSummaryTimer = null;
    }
    await ctx.inferenceRunFlushQueue.close();
  }
});
