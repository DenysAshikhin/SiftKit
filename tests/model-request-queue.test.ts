import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultMetrics } from '../src/status-server/metrics.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import {
  DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS,
  acquireModelRequestWithWait,
  clearCompletedStatusRequestIdForDifferentRequest,
  getModelRequestQueueDiagnostics,
  isIdle,
  MAX_COMPLETED_STATUS_PATH_ENTRIES,
  rememberCompletedStatusRequestId,
  releaseModelRequest,
} from '../src/status-server/server-ops.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { BackendSwitchCoordinator, type BackendSelectionStore } from '../src/status-server/backend-switch-coordinator.js';
import { ManagedInferenceRuntime } from '../src/status-server/managed-inference-runtime.js';
import type { InferenceBackendId } from '../src/config/types.js';

type StdoutLine = string;

class QueueSelectionStore implements BackendSelectionStore {
  selected: InferenceBackendId = 'llama';

  getSelectedBackend(): InferenceBackendId {
    return this.selected;
  }

  saveSelectedBackend(backend: InferenceBackendId): void {
    this.selected = backend;
  }
}

class QueueRuntime extends ManagedInferenceRuntime {
  constructor(id: InferenceBackendId, private readonly events: string[]) {
    super(id, `http://127.0.0.1:${id === 'llama' ? '8097' : '8098'}`, `${id}-model`, {
      chatTemplateKwargs: true,
      reasoningContent: true,
      toolCalling: true,
      jsonSchema: true,
      speculativeMode: 'none',
      reusablePrefixCache: 'unknown',
    });
  }

  async start(): Promise<void> {
    this.events.push(`start:${this.id}`);
    this.transitionTo('ready');
  }

  async stop(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.transitionTo('stopped');
  }

  async waitUntilReady(): Promise<void> {}
}

function createQueueContext(): ServerContext & { readonly wakeCount: number } {
  let wakeCount = 0;
  const context: ServerContext & { readonly wakeCount: number } = {
    configPath: 'config.json',
    statusPath: 'status.txt',
    metricsPath: 'metrics.sqlite',
    idleSummarySnapshotsPath: 'idle.sqlite',
    disableManagedLlamaStartup: false,
    engineService: new StatusEngineService(),
    terminalMetadataQueue: [],
    terminalMetadataDrainScheduled: false,
    terminalMetadataDrainRunning: false,
    terminalMetadataLastModelRequestFinishedAtMs: null,
    terminalMetadataIdleDelayMs: 0,
    runtimeHistoryPruneTimer: null,
    server: null,
    getServiceBaseUrl(): string {
      return 'http://127.0.0.1:0';
    },
    metrics: getDefaultMetrics(),
    activeRunsByRequestId: new Map(),
    activeRequestIdByStatusPath: new Map(),
    completedRequestIdByStatusPath: new Map(),
    activeModelRequest: null,
    modelRequestQueue: [],
    deferredArtifactQueue: [],
    deferredArtifactDrainScheduled: false,
    deferredArtifactDrainRunning: false,
    pendingIdleSummaryMetadata: {
      inputCharactersPerContextToken: null,
      chunkThresholdCharacters: null,
    },
    idleSummaryTimer: null,
    idleSummaryPending: false,
    idleSummaryDatabase: null,
    managedLlamaStartupPromise: null,
    managedLlamaShutdownPromise: null,
    managedLlamaHostProcess: null,
    managedLlamaLastStartupLogs: null,
    managedLlamaStarting: false,
    managedLlamaReady: false,
    managedLlamaStartupWarning: null,
    bootstrapManagedLlamaStartup: false,
    managedLlamaLogCleanupTimer: null,
    managedLlamaFlushQueue: new ManagedLlamaFlushQueue(),
    async shutdownManagedLlamaIfNeeded(): Promise<void> {},
    async ensureManagedLlamaReady() {
      wakeCount += 1;
      return getDefaultConfig();
    },
    get wakeCount(): number {
      return wakeCount;
    },
  };
  return context;
}

test('completed status request ids are bounded and cleared when a status path is reused', () => {
  const ctx = createQueueContext();

  for (let index = 0; index <= MAX_COMPLETED_STATUS_PATH_ENTRIES; index += 1) {
    rememberCompletedStatusRequestId(ctx, `status-${index}.txt`, `request-${index}`);
  }

  assert.equal(ctx.completedRequestIdByStatusPath.size, MAX_COMPLETED_STATUS_PATH_ENTRIES);
  assert.equal(ctx.completedRequestIdByStatusPath.has('status-0.txt'), false);
  assert.equal(ctx.completedRequestIdByStatusPath.get(`status-${MAX_COMPLETED_STATUS_PATH_ENTRIES}.txt`), `request-${MAX_COMPLETED_STATUS_PATH_ENTRIES}`);

  rememberCompletedStatusRequestId(ctx, 'active-status.txt', 'completed-request');
  clearCompletedStatusRequestIdForDifferentRequest(ctx, 'active-status.txt', 'completed-request');
  assert.equal(ctx.completedRequestIdByStatusPath.get('active-status.txt'), 'completed-request');

  clearCompletedStatusRequestIdForDifferentRequest(ctx, 'active-status.txt', 'next-request');
  assert.equal(ctx.completedRequestIdByStatusPath.has('active-status.txt'), false);
});

test('model request queue timeout default is fifteen minutes', () => {
  assert.equal(DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS, 900_000);
});

test('backend transition pauses queued admission until the new runtime is ready', async () => {
  const ctx = createQueueContext();
  const events: string[] = [];
  const coordinator = new BackendSwitchCoordinator(
    new QueueRuntime('llama', events),
    new QueueRuntime('exl3', events),
    new QueueSelectionStore(),
  );
  ctx.backendSwitchCoordinator = coordinator;
  await coordinator.initialize();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(activeLock);
    assert.equal(await coordinator.select('exl3'), 'queued');
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'repo_search');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;

    assert.ok(queuedLock);
    assert.equal(coordinator.getStatus().active, 'exl3');
    assert.deepEqual(events, ['start:llama', 'stop:llama', 'start:exl3']);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.managedLlamaFlushQueue.close();
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
    assert.ok(lines.some((line) => /request incoming task=summary queue_position=1/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_acquired task=summary wait_ms=0/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_released task=summary held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.managedLlamaFlushQueue.close();
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
        assert.ok(currentLines.some((line) => /request incoming task=dashboard_chat queue_position=2/u.test(line)), currentLines.join('\n'));
      } finally {
        assert.equal(releaseModelRequest(ctx, activeLock.token), true);
        const queuedLock = await queuedLockPromise;
        assert.ok(queuedLock);
        assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
      }
    });

    assert.ok(lines.some((line) => /request incoming task=dashboard_chat queue_position=2/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_acquired task=dashboard_chat wait_ms=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_released task=dashboard_chat held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.managedLlamaFlushQueue.close();
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
    assert.equal(ctx.activeModelRequest?.token, activeLock.token);
    assert.ok(lines.some((line) => /request dropped reason=model_queue_timeout task=summary/u.test(line)), lines.join('\n'));

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.managedLlamaFlushQueue.close();
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
    await ctx.managedLlamaFlushQueue.close();
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
    assert.equal(ctx.activeModelRequest?.token, activeLock.token);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.managedLlamaFlushQueue.close();
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
    assert.equal(diagnostics.active, true);
    assert.equal(diagnostics.activeRequest?.kind, 'repo_search');
    assert.equal(diagnostics.queueLength, 1);
    assert.equal(diagnostics.queuedRequests[0]?.kind, 'summary');
    assert.equal(typeof diagnostics.activeRequest?.heldMs, 'number');
    assert.equal(typeof diagnostics.queuedRequests[0]?.waitMs, 'number');

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.managedLlamaFlushQueue.close();
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
    assert.equal(ctx.activeModelRequest?.kind, 'summary');
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.equal(ctx.activeModelRequest?.token, queuedLock.token);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.managedLlamaFlushQueue.close();
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
    await ctx.managedLlamaFlushQueue.close();
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
    await ctx.managedLlamaFlushQueue.close();
  }
});
