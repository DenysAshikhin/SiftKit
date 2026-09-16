import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { toError } from '../lib/errors.js';
import { sleep } from '../lib/time.js';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../lib/paths.js';
import type { InferenceBackendId } from '../config/types.js';
import {
  consumeInferenceRunPendingLogChunks,
  getInferenceRunPendingLogChunkStats,
  restoreInferenceRunPendingLogChunks,
  type InferenceRunPendingLogChunkEntry,
} from '../state/inference-runs.js';
import { getRuntimeDatabasePath } from '../state/runtime-db.js';
import {
  clearUnrefTimer,
  deferredDrainWaitMs,
  elapsedIdleWaitMs,
  getPollSleepMs,
  IDLE_POLL_INTERVAL_MS,
  idleTimeoutError,
  normalizeTimeoutMs,
  scheduleUnrefTimer,
} from './idle-drain.js';
import { SHUTDOWN_CLOSE_FLUSH_WAIT_MS } from './shutdown-budget.js';
import { serverLogger } from './server-logger.js';

/**
 * Pending characters at which a run flushes even while a model request is
 * active. The deferral exists to keep DB writes off the inference path; past
 * this point the memory cost outweighs it. No log data is dropped either way.
 */
export const PENDING_FLUSH_HIGH_WATER_CHARACTERS = 8 * 1024 * 1024;

const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 2000;

/**
 * The worker never acknowledged the batch inside the shutdown budget. Distinct from a failed flush:
 * its transaction may still commit, so the batch has to stay the worker's — restoring it would write
 * the same chunk text a second time.
 */
class FlushAcknowledgementTimeoutError extends Error {
}

type InferenceRunFlushQueueItem = {
  runId: string;
  backend: InferenceBackendId;
  enqueuedAtMs: number;
  attempts: number;
  entries: InferenceRunPendingLogChunkEntry[] | null;
};

export type InferenceRunFlushQueueOptions = {
  idleDelayMs?: number;
  closeFlushWaitMs?: number;
};

export type InferenceRunModelRequestState = {
  active: boolean;
  queueLength: number;
  lastFinishedAtMs?: number | null;
};

type FlushWorkerResponse = {
  id: number;
  ok: boolean;
  errorMessage?: string;
};

export type InferenceRunFlushQueueSnapshot = {
  pendingCount: number;
  runningRunId: string | null;
  scheduled: boolean;
  completedCount: number;
  failedCount: number;
};

export class InferenceRunFlushQueue {
  private readonly idleDelayMs: number;
  /**
   * How long `close` gives an in-flight flush to finish, so the worker is never terminated with its
   * sqlite handle open: that fd survives until process exit and holds the directory containing the
   * database. The default is shared with the shutdown watchdog that supervises this wait.
   */
  private readonly closeFlushWaitMs: number;
  private readonly pendingByRunId = new Map<string, InferenceRunFlushQueueItem>();
  private readonly pendingOrder: string[] = [];
  private scheduled = false;
  private drainTimer: NodeJS.Timeout | null = null;
  /** Set by the shutdown drain: the idle-delay gate is bypassed until the queue is empty. */
  private shuttingDown = false;
  private draining = false;
  private runningRunId: string | null = null;
  private activeModelRequest = false;
  private modelRequestQueueLength = 0;
  private lastModelRequestFinishedAtMs: number | null = null;
  private completedCount = 0;
  private failedCount = 0;
  /**
   * The first drain failure that escaped the retry scope, kept until the process ends. Only a failure
   * the restore-and-retry path could not justify lands here — a rejected transaction is retried, not
   * recorded — so this is a batch whose outcome nobody was told about, and `waitForIdle` hands it to
   * the next caller that waits on the queue rather than letting it go quiet. `isIdle` deliberately
   * ignores it: an empty queue is still empty, and the idempotency assertion after a good drain has
   * to keep meaning that.
   */
  private drainFailure: Error | null = null;
  private worker: Worker | null = null;
  private nextWorkerMessageId = 1;
  private closed = false;

  constructor(options: InferenceRunFlushQueueOptions = {}) {
    const configuredIdleDelayMs = Number(options.idleDelayMs ?? 0);
    this.idleDelayMs = Number.isFinite(configuredIdleDelayMs)
      ? Math.max(0, Math.trunc(configuredIdleDelayMs))
      : 0;
    const configuredCloseFlushWaitMs = Number(options.closeFlushWaitMs ?? SHUTDOWN_CLOSE_FLUSH_WAIT_MS);
    this.closeFlushWaitMs = Number.isFinite(configuredCloseFlushWaitMs)
      ? Math.max(0, Math.trunc(configuredCloseFlushWaitMs))
      : SHUTDOWN_CLOSE_FLUSH_WAIT_MS;
  }

  /**
   * Shutdown: cancels the delayed drain, flushes every pending batch now and awaits each
   * acknowledgement, all of it inside `timeoutMs`. A batch the worker does not acknowledge in time is
   * left with the worker, since it may still commit, and the wait rejects so shutdown reports the loss
   * instead of dropping it silently.
   */
  async drainForShutdown(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    this.clearDrainTimer();
    this.scheduled = false;
    // The clock starts before the work. Started after the first drain pass — which the shutdown flag
    // drives to completion — the budget bounded only the retry tail, and the flush and acknowledgement
    // a stalled worker never returned ran unbounded.
    const budgetMs = normalizeTimeoutMs(timeoutMs);
    const deadlineMs = Date.now() + budgetMs;
    if (!this.draining) {
      await this.drainNow(deadlineMs);
    }
    await this.waitForIdleUntil(deadlineMs, budgetMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearDrainTimer();
    const worker = this.worker;
    this.worker = null;
    if (!worker) {
      return;
    }
    const deadline = Date.now() + this.closeFlushWaitMs;
    while (this.runningRunId !== null && Date.now() < deadline) {
      await sleep(IDLE_POLL_INTERVAL_MS);
    }
    const abandonedRunId = this.runningRunId;
    if (abandonedRunId !== null) {
      // Terminating now leaks the worker's sqlite fd until process exit, which holds the
      // directory containing the database. Say so rather than fail silently: a flush this slow
      // is the bug, and no wider budget fixes it.
      serverLogger.error({
        scope: 'flush',
        id: abandonedRunId,
        event: 'flush_close_timeout',
        fields: `wait_ms=${this.closeFlushWaitMs}`,
      });
    }
    await worker.terminate();
  }

  enqueue(runId: string, backend: InferenceBackendId): boolean {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId || this.closed) {
      return false;
    }
    if (this.pendingByRunId.has(normalizedRunId)) {
      return false;
    }
    // Nothing buffered means no work: a flush flow here would only contend for the journal.
    if (getInferenceRunPendingLogChunkStats(normalizedRunId).totalCharacters === 0) {
      return false;
    }
    this.pendingByRunId.set(normalizedRunId, {
      runId: normalizedRunId,
      backend,
      enqueuedAtMs: Date.now(),
      attempts: 0,
      entries: null,
    });
    this.pendingOrder.push(normalizedRunId);
    serverLogger.debug({
      scope: backend,
      id: normalizedRunId,
      event: 'flush_enqueue',
      fields: `pending=${this.pendingOrder.length}`,
    });
    if (!this.draining) {
      this.scheduleDrain(0);
    }
    return true;
  }

  setModelRequestState(state: InferenceRunModelRequestState): void {
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

  getSnapshot(): InferenceRunFlushQueueSnapshot {
    return {
      pendingCount: this.pendingOrder.length,
      runningRunId: this.runningRunId,
      scheduled: this.scheduled,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
  }

  /** The drain state as the two budget failures report it. */
  private getSnapshotFields(): string {
    const snapshot = this.getSnapshot();
    return `pendingCount=${snapshot.pendingCount} runningRunId=${snapshot.runningRunId} `
      + `scheduled=${snapshot.scheduled} completedCount=${snapshot.completedCount} `
      + `failedCount=${snapshot.failedCount}`;
  }

  async waitForIdle(timeoutMs: number = DEFAULT_IDLE_WAIT_TIMEOUT_MS): Promise<void> {
    const budgetMs = normalizeTimeoutMs(timeoutMs);
    await this.waitForIdleUntil(Date.now() + budgetMs, budgetMs);
  }

  /**
   * Waits against a deadline someone else started. The shutdown budget is a bound on total persistence
   * time, so the drain and this wait share one deadline rather than each getting a fresh budget.
   */
  private async waitForIdleUntil(deadlineMs: number, budgetMs: number): Promise<void> {
    while (true) {
      // Hand a failure back as soon as it exists rather than at the deadline. Waiting cannot help:
      // if the failed batch was the last one the queue genuinely looks idle from here, so a shutdown
      // that joined a drain already in flight would resolve green over unsaved log text.
      if (this.drainFailure !== null) {
        throw this.drainFailure;
      }
      if (this.isIdle()) {
        return;
      }
      if (Date.now() >= deadlineMs) {
        throw idleTimeoutError('inference run flush queue idle', budgetMs, this.getSnapshotFields());
      }
      await sleep(getPollSleepMs(deadlineMs));
    }
  }

  isIdle(): boolean {
    return !this.draining
      && !this.scheduled
      && this.pendingOrder.length === 0
      && this.runningRunId === null;
  }

  /**
   * Drains every pending batch. `deadlineMs`, when given, is the shutdown budget: it bounds each
   * acknowledgement as well as the gaps between batches, and expiring it fails the drain rather than
   * quietly leaving work behind.
   */
  async drainNow(deadlineMs: number | null = null): Promise<void> {
    if (this.draining || this.closed) {
      return;
    }
    this.scheduled = false;
    this.draining = true;
    let failure: Error | null = null;
    try {
      while (this.pendingOrder.length > 0) {
        const nextRunId = this.pendingOrder[0];
        if (!nextRunId) {
          continue;
        }
        // Checked before the hand-off, not after it: past the deadline there is no acknowledgement
        // left to wait for, and the batch is still in `pendingOrder`, so this is the one expiry that
        // can be enforced without touching a batch at all.
        if (deadlineMs !== null && Date.now() >= deadlineMs) {
          throw new Error(
            `Timed out draining inference run flush queue within its shutdown budget before `
            + `run ${nextRunId}: ${this.getSnapshotFields()}`,
          );
        }
        const item = this.pendingByRunId.get(nextRunId);
        if (!item) {
          this.pendingOrder.shift();
          continue;
        }
        const pendingStats = getInferenceRunPendingLogChunkStats(nextRunId);
        // The buffer can drain between enqueue and drain; drop the stale item before scheduling.
        if (pendingStats.totalCharacters === 0) {
          this.pendingOrder.shift();
          this.pendingByRunId.delete(nextRunId);
          continue;
        }
        const idleWaitMs = this.getIdleWaitMs(item.enqueuedAtMs, pendingStats.totalCharacters);
        if (idleWaitMs > 0) {
          this.scheduleDrain(idleWaitMs);
          return;
        }
        const runId = this.pendingOrder.shift();
        if (!runId) {
          continue;
        }
        this.pendingByRunId.delete(runId);
        item.entries ??= consumeInferenceRunPendingLogChunks(runId);
        // Skipped without touching the counters: no flush was attempted and none failed.
        if (item.entries.length === 0) {
          continue;
        }
        this.runningRunId = runId;
        const startedAtMs = Date.now();
        const waitMs = startedAtMs - item.enqueuedAtMs;
        // The `try` covers the persistence call and nothing else. Restore-and-retry is justified only
        // by a rejected transaction: once the worker has acked the batch is durable, so a throw from
        // the reporting path below must surface rather than be mistaken for a failed write — being
        // mistaken for one put the committed chunk text back in the buffer and wrote it a second time.
        let flushFailure: Error | null = null;
        let abandonedToWorker = false;
        try {
          await this.flushInWorker(runId, item.entries, deadlineMs);
        } catch (error) {
          abandonedToWorker = error instanceof FlushAcknowledgementTimeoutError;
          flushFailure = toError(error);
        } finally {
          // An abandoned batch stays running as far as the queue is concerned: that is what tells
          // `close()` there is a handle to wait for, instead of terminating it over an open sqlite fd.
          if (!abandonedToWorker) {
            this.runningRunId = null;
          }
        }
        const durationMs = Date.now() - startedAtMs;
        if (flushFailure !== null) {
          if (abandonedToWorker) {
            // No restore, no retry, and neither counter moves: the outcome is genuinely unknown, so it
            // is reported by the rejection instead of counted as a write that failed and was handed
            // back. `ownDrainFailure` still gets it, so a waiter cannot read this as a clean drain.
            throw flushFailure;
          }
          item.attempts += 1;
          if (item.entries) {
            restoreInferenceRunPendingLogChunks(runId, item.entries);
            item.entries = null;
          }
          this.failedCount += 1;
          this.pendingByRunId.set(runId, item);
          this.pendingOrder.push(runId);
          serverLogger.error({
            scope: item.backend,
            id: runId,
            event: 'flush_retry',
            fields: `wait_ms=${waitMs} duration_ms=${durationMs} `
              + `attempt=${item.attempts} pending_chars=${pendingStats.totalCharacters} error=${JSON.stringify(flushFailure.message)}`,
          });
          this.scheduleDrain(250);
          break;
        }
        this.completedCount += 1;
        serverLogger.dim({
          scope: item.backend,
          id: runId,
          event: 'flush_done',
          fields: `wait_ms=${waitMs} duration_ms=${durationMs} `
            + `pending_chars=${pendingStats.totalCharacters} stream_count=${pendingStats.streamCount}`,
        });
      }
    } catch (error) {
      failure = toError(error);
    } finally {
      this.draining = false;
    }
    if (failure !== null) {
      this.ownDrainFailure(failure);
      throw failure;
    }
  }

  /**
   * A drain failure belongs to the queue, not to whichever call site happened to await it. It is
   * recorded first, so a caller that only polls state still finds it, and the remaining `pendingOrder`
   * items are rescheduled: an escaped failure ends this pass, not the queue, and without this the
   * leftovers sat until some unrelated `enqueue` kicked the drain.
   */
  private ownDrainFailure(error: Error): void {
    if (this.drainFailure === null) {
      this.drainFailure = error;
    }
    if (this.pendingOrder.length > 0 && !this.closed) {
      this.scheduleDrain(0);
    }
  }

  /**
   * A drain started by a timer has no caller to receive the failure, so it would land as an unhandled
   * rejection. `drainNow` has already owned it; all that is left is to say so, and to say it on stderr
   * rather than through the logger — the failure that arrives here can be the logger's own sink
   * throwing, and a handler that rethrows is exactly the unhandled rejection this replaces.
   */
  private drainFromTimer(): void {
    this.drainNow().then(
      () => undefined,
      (error: Error) => {
        process.stderr.write(`[siftKitStatus] Inference run flush drain failed: ${error.message}\n`);
      },
    );
  }

  private getIdleWaitMs(fallbackStartedAtMs: number, pendingCharacters: number): number {
    if (this.shuttingDown || pendingCharacters >= PENDING_FLUSH_HIGH_WATER_CHARACTERS) {
      return 0;
    }
    if (this.activeModelRequest || this.modelRequestQueueLength > 0) {
      return deferredDrainWaitMs(this.idleDelayMs);
    }
    return elapsedIdleWaitMs(this.idleDelayMs, this.lastModelRequestFinishedAtMs, fallbackStartedAtMs);
  }

  private flushInWorker(
    runId: string,
    entries: InferenceRunPendingLogChunkEntry[],
    deadlineMs: number | null,
  ): Promise<void> {
    const worker = this.getWorker();
    const id = this.nextWorkerMessageId;
    this.nextWorkerMessageId += 1;
    const startedAtMs = Date.now();
    return new Promise<void>((resolve, reject) => {
      let ackTimer: NodeJS.Timeout | null = null;
      // Detaching is left to the acknowledgement or the worker error even once the budget has expired.
      // The batch is still the worker's to finish, and a Worker that emits `error` with no listener
      // crashes the process outright.
      const cleanup = (): void => {
        if (ackTimer !== null) {
          clearUnrefTimer(ackTimer);
          ackTimer = null;
        }
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      const onMessage = (message: FlushWorkerResponse): void => {
        if (message.id !== id) {
          return;
        }
        cleanup();
        if (message.ok) {
          resolve();
        } else {
          reject(new Error(message.errorMessage || 'inference run flush worker failed'));
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      if (deadlineMs !== null) {
        ackTimer = scheduleUnrefTimer(() => {
          ackTimer = null;
          reject(new FlushAcknowledgementTimeoutError(
            `Inference run flush acknowledgement not received within budget after `
            + `${Date.now() - startedAtMs}ms for run ${runId}: ${this.getSnapshotFields()}`,
          ));
        }, deadlineMs - Date.now());
      }
      worker.postMessage({
        id,
        runId,
        databasePath: getRuntimeDatabasePath(),
        entries,
      });
    });
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const packageRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
    if (packageRoot === null) {
      throw new Error('Unable to locate the SiftKit package root for the inference-run flush worker.');
    }
    const workerPath = join(packageRoot, 'dist', 'status-server', 'inference-run-flush-worker.js');
    this.worker = new Worker(workerPath);
    this.worker.unref();
    this.worker.on('exit', () => {
      this.worker = null;
    });
    return this.worker;
  }

  private clearDrainTimer(): void {
    clearUnrefTimer(this.drainTimer);
    this.drainTimer = null;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    if (delayMs > 0) {
      this.drainTimer = scheduleUnrefTimer(() => {
        this.drainTimer = null;
        this.drainFromTimer();
      }, delayMs);
      return;
    }
    setImmediate(() => {
      this.drainFromTimer();
    });
  }
}
