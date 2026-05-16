import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultMetrics } from '../dist/status-server/metrics.js';
import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import {
  acquireModelRequestWithWait,
  clearCompletedStatusRequestIdForDifferentRequest,
  isIdle,
  MAX_COMPLETED_STATUS_PATH_ENTRIES,
  rememberCompletedStatusRequestId,
  releaseModelRequest,
} from '../dist/status-server/server-ops.js';
import type { ServerContext } from '../dist/status-server/server-types.js';

type StdoutLine = string;

function createQueueContext(): ServerContext {
  let wakeCount = 0;
  return {
    configPath: 'config.json',
    statusPath: 'status.txt',
    metricsPath: 'metrics.sqlite',
    idleSummarySnapshotsPath: 'idle.sqlite',
    disableManagedLlamaStartup: false,
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
    activeExecutionLease: null,
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
    async ensureManagedLlamaReady(): Promise<Record<string, never>> {
      wakeCount += 1;
      return {};
    },
    get wakeCount(): number {
      return wakeCount;
    },
  } as ServerContext & { readonly wakeCount: number };
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
    return originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
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

    assert.equal((ctx as ServerContext & { readonly wakeCount: number }).wakeCount, 0);
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
    let capturedLines: StdoutLine[] = [];

    const lines = await captureStdoutLines(async (currentLines) => {
      capturedLines = currentLines;
      queuedLockPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        assert.equal((ctx as ServerContext & { readonly wakeCount: number }).wakeCount, 0);
        assert.ok(capturedLines.some((line) => /request incoming task=dashboard_chat queue_position=2/u.test(line)), capturedLines.join('\n'));
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

test('release grants the next queued model request without waiting for polling timers', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

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
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
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
