import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultMetrics } from '../dist/status-server/metrics.js';
import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequestAfterDelay,
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

test('model request admission logs queue position and wakes llama for immediate requests', async () => {
  const ctx = createQueueContext();
  try {
    const lines = await captureStdoutLines(async () => {
      const lock = await acquireModelRequestWithWait(ctx, 'summary');
      assert.ok(lock);
      assert.equal(releaseModelRequest(ctx, lock.token), true);
    });

    assert.equal((ctx as ServerContext & { readonly wakeCount: number }).wakeCount, 1);
    assert.ok(lines.some((line) => /request incoming task=summary queue_position=1/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_acquired task=summary wait_ms=0/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /request lock_released task=summary held_ms=/u.test(line)), lines.join('\n'));
  } finally {
    await ctx.managedLlamaFlushQueue.close();
  }
});

test('queued model request logs its FIFO position and wakes llama while waiting', async () => {
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
        assert.equal((ctx as ServerContext & { readonly wakeCount: number }).wakeCount, 2);
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

test('delayed release holds queued model request for terminal status grace window', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(activeLock);
    let queuedResolvedAt: number | null = null;
    const queuedLockPromise = acquireModelRequestWithWait(ctx, 'summary').then((lock) => {
      queuedResolvedAt = Date.now();
      return lock;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    const releaseStartedAt = Date.now();
    const releasePromise = releaseModelRequestAfterDelay(ctx, activeLock.token, 10);
    await new Promise<void>((resolve) => setTimeout(resolve, 3));
    assert.equal(queuedResolvedAt, null);

    assert.equal(await releasePromise, true);
    const queuedLock = await queuedLockPromise;
    assert.ok(queuedLock);
    assert.ok((queuedResolvedAt ?? 0) - releaseStartedAt >= 8);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.managedLlamaFlushQueue.close();
  }
});
