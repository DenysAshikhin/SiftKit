import { rmSync } from 'node:fs';
import { saveContentAtomicallyAsync } from '../../lib/fs.js';
import type { BufferedJsonLogger } from '../logging.js';
import { LiveRunSnapshotCollector } from './collector.js';

const DEFAULT_MIN_INTERVAL_MS = 200;
/** Rewrites the file even while nothing happens, so a wedged phase still proves the process is alive. */
const DEFAULT_HEARTBEAT_MS = 5000;

export function isLiveRunSnapshotEnabled(): boolean {
  const value = String(process.env.SIFTKIT_LIVE_SNAPSHOT ?? '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

/**
 * Writes the collector's snapshot to one fixed path, overwriting it in place.
 * Writes are serialized through a promise chain (so `flushNow` is deterministic)
 * and coalesced behind a single pending timer (so a burst of events costs one write).
 * Never throws at the caller: write failures land in the snapshot's own health block.
 */
export class LiveRunSnapshotWriter {
  private readonly filePath: string;
  private readonly collector: LiveRunSnapshotCollector;
  private readonly minIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private stopped = false;

  constructor(options: {
    filePath: string;
    collector: LiveRunSnapshotCollector;
    minIntervalMs?: number;
    heartbeatMs?: number;
  }) {
    this.filePath = options.filePath;
    this.collector = options.collector;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.heartbeat = setInterval(() => {
      this.schedule();
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  schedule(): void {
    if (this.stopped || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.minIntervalMs);
    this.timer.unref();
  }

  async flushNow(): Promise<void> {
    await this.enqueueWrite();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Synchronous unlink on the common path: an awaited fs call here would yield a
   * macrotask and let deferred run-log persistence land before the request resolves,
   * which the request path must not do. Only a write caught in flight costs a yield.
   */
  async remove(): Promise<void> {
    if (this.pendingWrites > 0) {
      await this.queue;
    }
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // A snapshot we cannot delete is a stale file, never a failed run.
    }
  }

  private enqueueWrite(): Promise<void> {
    this.pendingWrites += 1;
    this.queue = this.queue.then(() => this.writeOnce());
    return this.queue;
  }

  private async writeOnce(): Promise<void> {
    if (this.stopped) {
      this.pendingWrites -= 1;
      return;
    }
    try {
      const text = `${JSON.stringify(this.collector.build(), null, 2)}\n`;
      await saveContentAtomicallyAsync(this.filePath, text);
    } catch (error) {
      this.collector.recordWriteError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pendingWrites -= 1;
    }
  }
}

/**
 * Wraps a transcript logger so every event also feeds the live snapshot. The
 * returned logger keeps the wrapped logger's identity (`path`, `getText`,
 * `persist`) — callers that persist the transcript are unaffected.
 */
export function attachLiveRunSnapshot(options: {
  logger: BufferedJsonLogger;
  filePath: string;
  requestId: string;
  taskKind: string;
  repoRoot: string;
  startedAtMs: number;
}): {
  logger: BufferedJsonLogger;
  writer: LiveRunSnapshotWriter;
  collector: LiveRunSnapshotCollector;
} {
  const collector = new LiveRunSnapshotCollector({
    requestId: options.requestId,
    taskKind: options.taskKind,
    repoRoot: options.repoRoot,
    startedAtMs: options.startedAtMs,
  });
  const writer = new LiveRunSnapshotWriter({ filePath: options.filePath, collector });
  const logger: BufferedJsonLogger = {
    path: options.logger.path,
    write(event) {
      options.logger.write(event);
      collector.record(event);
      writer.schedule();
    },
    getText: () => options.logger.getText(),
    persist: (targetPath, requestId) => options.logger.persist(targetPath, requestId),
  };
  return { logger, writer, collector };
}
