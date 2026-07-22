import { extname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sleep } from '../lib/time.js';
import { moduleDirname, moduleFilename } from '../lib/paths.js';
import {
  consumeInferenceRunPendingLogChunks,
  getInferenceRunPendingLogChunkStats,
  restoreInferenceRunPendingLogChunks,
  type InferenceRunPendingLogChunkEntry,
} from '../state/inference-runs.js';
import { getRuntimeDatabasePath } from '../state/runtime-db.js';
import {
  getManagedLlamaSpeculativeMetricsSnapshot,
  type ManagedLlamaSpeculativeMetricsSnapshot,
} from './managed-llama-speculative-tracker.js';
import { serverLogger } from './server-logger.js';

type ManagedLlamaFlushQueueItem = {
  runId: string;
  enqueuedAtMs: number;
  attempts: number;
  entries: InferenceRunPendingLogChunkEntry[] | null;
  metricsSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type ManagedLlamaFlushQueueOptions = {
  idleDelayMs?: number;
};

export type ManagedLlamaModelRequestState = {
  active: boolean;
  queueLength: number;
  lastFinishedAtMs?: number | null;
};

type FlushWorkerResponse = {
  id: number;
  ok: boolean;
  errorMessage?: string;
  metricsFlushed?: boolean;
};

export type ManagedLlamaFlushQueueSnapshot = {
  pendingCount: number;
  runningRunId: string | null;
  scheduled: boolean;
  completedCount: number;
  failedCount: number;
};

export class ManagedLlamaFlushQueue {
  private readonly idleDelayMs: number;
  private readonly pendingByRunId = new Map<string, ManagedLlamaFlushQueueItem>();
  private readonly pendingOrder: string[] = [];
  private scheduled = false;
  private draining = false;
  private runningRunId: string | null = null;
  private activeModelRequest = false;
  private modelRequestQueueLength = 0;
  private lastModelRequestFinishedAtMs: number | null = null;
  private completedCount = 0;
  private failedCount = 0;
  private worker: Worker | null = null;
  private nextWorkerMessageId = 1;

  constructor(options: ManagedLlamaFlushQueueOptions = {}) {
    const configuredIdleDelayMs = Number(options.idleDelayMs ?? 0);
    this.idleDelayMs = Number.isFinite(configuredIdleDelayMs)
      ? Math.max(0, Math.trunc(configuredIdleDelayMs))
      : 0;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) {
      return;
    }
    await worker.terminate();
  }

  enqueue(runId: string): boolean {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      return false;
    }
    if (this.pendingByRunId.has(normalizedRunId)) {
      return false;
    }
    this.pendingByRunId.set(normalizedRunId, {
      runId: normalizedRunId,
      enqueuedAtMs: Date.now(),
      attempts: 0,
      entries: null,
      metricsSnapshot: null,
    });
    this.pendingOrder.push(normalizedRunId);
    serverLogger.debug({
      scope: 'llama',
      id: normalizedRunId,
      event: 'flush_enqueue',
      fields: `pending=${this.pendingOrder.length}`,
    });
    if (!this.draining) {
      this.scheduleDrain(0);
    }
    return true;
  }

  setModelRequestState(state: ManagedLlamaModelRequestState): void {
    this.activeModelRequest = Boolean(state.active);
    this.modelRequestQueueLength = Math.max(0, Math.trunc(Number(state.queueLength || 0)));
    if (typeof state.lastFinishedAtMs === 'number' && Number.isFinite(state.lastFinishedAtMs)) {
      this.lastModelRequestFinishedAtMs = Math.max(0, Math.trunc(state.lastFinishedAtMs));
    }
    if (this.pendingOrder.length > 0 && !this.draining) {
      this.scheduleDrain(0);
    }
  }

  markModelRequestFinished(finishedAtMs: number = Date.now()): void {
    if (Number.isFinite(finishedAtMs)) {
      this.lastModelRequestFinishedAtMs = Math.max(0, Math.trunc(finishedAtMs));
    }
    if (this.pendingOrder.length > 0 && !this.draining) {
      this.scheduleDrain(0);
    }
  }

  getSnapshot(): ManagedLlamaFlushQueueSnapshot {
    return {
      pendingCount: this.pendingOrder.length,
      runningRunId: this.runningRunId,
      scheduled: this.scheduled,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
  }

  async waitForIdle(timeoutMs: number): Promise<void> {
    const startedAtMs = Date.now();
    while (Date.now() - startedAtMs <= timeoutMs) {
      if (!this.draining && !this.scheduled && this.pendingOrder.length === 0 && this.runningRunId === null) {
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for managed llama flush queue after ${timeoutMs} ms.`);
  }

  isIdle(): boolean {
    return !this.draining
      && !this.scheduled
      && this.pendingOrder.length === 0
      && this.runningRunId === null;
  }

  async drainNow(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.scheduled = false;
    this.draining = true;
    try {
      while (this.pendingOrder.length > 0) {
        const nextRunId = this.pendingOrder[0];
        if (!nextRunId) {
          continue;
        }
        const item = this.pendingByRunId.get(nextRunId);
        if (!item) {
          this.pendingOrder.shift();
          continue;
        }
        const idleWaitMs = this.getIdleWaitMs(item.enqueuedAtMs);
        if (idleWaitMs > 0) {
          this.scheduleDrain(idleWaitMs);
          return;
        }
        const runId = this.pendingOrder.shift();
        if (!runId) {
          continue;
        }
        this.pendingByRunId.delete(runId);
        this.runningRunId = runId;
        const pendingStats = getInferenceRunPendingLogChunkStats(runId);
        const startedAtMs = Date.now();
        const waitMs = startedAtMs - item.enqueuedAtMs;
        try {
          item.entries ??= consumeInferenceRunPendingLogChunks(runId);
          item.metricsSnapshot ??= getManagedLlamaSpeculativeMetricsSnapshot(runId);
          const metricsFlushed = await this.flushInWorker(runId, item.entries, item.metricsSnapshot);
          const durationMs = Date.now() - startedAtMs;
          this.completedCount += 1;
          serverLogger.dim({
            scope: 'llama',
            id: runId,
            event: 'flush_done',
            fields: `wait_ms=${waitMs} duration_ms=${durationMs} `
              + `pending_chars=${pendingStats.totalCharacters} stream_count=${pendingStats.streamCount} `
              + `metrics_flushed=${metricsFlushed}`,
          });
        } catch (error) {
          const durationMs = Date.now() - startedAtMs;
          const message = error instanceof Error ? error.message : String(error);
          item.attempts += 1;
          if (item.entries) {
            restoreInferenceRunPendingLogChunks(runId, item.entries);
            item.entries = null;
          }
          this.failedCount += 1;
          this.pendingByRunId.set(runId, item);
          this.pendingOrder.push(runId);
          serverLogger.error({
            scope: 'llama',
            id: runId,
            event: 'flush_retry',
            fields: `wait_ms=${waitMs} duration_ms=${durationMs} `
              + `attempt=${item.attempts} pending_chars=${pendingStats.totalCharacters} error=${JSON.stringify(message)}`,
          });
          this.scheduleDrain(250);
          break;
        } finally {
          this.runningRunId = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private getIdleWaitMs(fallbackStartedAtMs: number): number {
    if (this.activeModelRequest || this.modelRequestQueueLength > 0) {
      return Math.max(1, Math.min(1000, this.idleDelayMs || 1000));
    }
    const lastFinishedAtMs = this.lastModelRequestFinishedAtMs ?? fallbackStartedAtMs;
    return Math.max(0, this.idleDelayMs - (Date.now() - lastFinishedAtMs));
  }

  private flushInWorker(
    runId: string,
    entries: InferenceRunPendingLogChunkEntry[],
    metricsSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
  ): Promise<boolean> {
    const worker = this.getWorker();
    const id = this.nextWorkerMessageId;
    this.nextWorkerMessageId += 1;
    return new Promise<boolean>((resolve, reject) => {
      const onMessage = (message: FlushWorkerResponse): void => {
        if (message.id !== id) {
          return;
        }
        cleanup();
        if (message.ok) {
          resolve(Boolean(message.metricsFlushed));
        } else {
          reject(new Error(message.errorMessage || 'managed llama flush worker failed'));
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({
        id,
        runId,
        databasePath: getRuntimeDatabasePath(),
        entries,
        metricsSnapshot,
      });
    });
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    // A Worker thread needs a loadable module. Compiled production runs from
    // dist where the sibling .js exists. When the status server runs from source
    // via tsx (the typed test harness), the module dir is src/ where only the .ts
    // exists; loading it would require a per-worker tsx subprocess, which does
    // not scale across many short-lived servers. The worker is internal
    // log-flush plumbing (not code under test), so load the compiled artifact
    // from dist in that case — a lightweight Worker thread, no tsx subprocess.
    const currentFile = moduleFilename(import.meta.url);
    const currentDir = moduleDirname(import.meta.url);
    const workerPath = extname(currentFile) === '.ts'
      ? resolve(currentDir, '..', '..', 'dist', 'status-server', 'managed-llama-flush-worker.js')
      : join(currentDir, 'managed-llama-flush-worker.js');
    this.worker = new Worker(workerPath);
    this.worker.unref();
    this.worker.on('exit', () => {
      this.worker = null;
    });
    return this.worker;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        void this.drainNow();
      }, delayMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      return;
    }
    setImmediate(() => {
      void this.drainNow();
    });
  }
}
