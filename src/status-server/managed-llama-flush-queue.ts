import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { sleep } from '../lib/time.js';
import {
  consumeManagedLlamaPendingLogChunks,
  getManagedLlamaPendingLogChunkStats,
  restoreManagedLlamaPendingLogChunks,
  type ManagedLlamaPendingLogChunkEntry,
} from '../state/managed-llama-runs.js';
import { getRuntimeDatabasePath } from '../state/runtime-db.js';
import {
  getManagedLlamaSpeculativeMetricsSnapshot,
  type ManagedLlamaSpeculativeMetricsSnapshot,
} from './managed-llama-speculative-tracker.js';
import { logLine } from './managed-llama.js';

type ManagedLlamaFlushQueueItem = {
  runId: string;
  enqueuedAtMs: number;
  attempts: number;
  entries: ManagedLlamaPendingLogChunkEntry[] | null;
  metricsSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
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
  private readonly pendingByRunId = new Map<string, ManagedLlamaFlushQueueItem>();
  private readonly pendingOrder: string[] = [];
  private scheduled = false;
  private draining = false;
  private runningRunId: string | null = null;
  private completedCount = 0;
  private failedCount = 0;
  private worker: Worker | null = null;
  private nextWorkerMessageId = 1;

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
    logLine(`managed_llama flush enqueue run_id=${normalizedRunId} pending=${this.pendingOrder.length}`);
    if (!this.draining) {
      this.scheduleDrain(0);
    }
    return true;
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

  async drainNow(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.scheduled = false;
    this.draining = true;
    try {
      while (this.pendingOrder.length > 0) {
        const runId = this.pendingOrder.shift();
        if (!runId) {
          continue;
        }
        const item = this.pendingByRunId.get(runId);
        if (!item) {
          continue;
        }
        this.pendingByRunId.delete(runId);
        this.runningRunId = runId;
        const pendingStats = getManagedLlamaPendingLogChunkStats(runId);
        const startedAtMs = Date.now();
        const waitMs = startedAtMs - item.enqueuedAtMs;
        try {
          item.entries ??= consumeManagedLlamaPendingLogChunks(runId);
          item.metricsSnapshot ??= getManagedLlamaSpeculativeMetricsSnapshot(runId);
          const metricsFlushed = await this.flushInWorker(runId, item.entries, item.metricsSnapshot);
          const durationMs = Date.now() - startedAtMs;
          this.completedCount += 1;
          logLine(
            `managed_llama flush done run_id=${runId} wait_ms=${waitMs} duration_ms=${durationMs} `
            + `pending_chars=${pendingStats.totalCharacters} stream_count=${pendingStats.streamCount} `
            + `metrics_flushed=${metricsFlushed}`,
          );
        } catch (error) {
          const durationMs = Date.now() - startedAtMs;
          const message = error instanceof Error ? error.message : String(error);
          item.attempts += 1;
          if (item.entries) {
            restoreManagedLlamaPendingLogChunks(runId, item.entries);
            item.entries = null;
          }
          this.failedCount += 1;
          this.pendingByRunId.set(runId, item);
          this.pendingOrder.push(runId);
          logLine(
            `managed_llama flush retry run_id=${runId} wait_ms=${waitMs} duration_ms=${durationMs} `
            + `attempt=${item.attempts} pending_chars=${pendingStats.totalCharacters} error=${JSON.stringify(message)}`,
          );
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

  private flushInWorker(
    runId: string,
    entries: ManagedLlamaPendingLogChunkEntry[],
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
    this.worker = new Worker(path.join(__dirname, 'managed-llama-flush-worker.js'));
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
