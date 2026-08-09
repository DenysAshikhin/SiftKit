import { rmSync } from 'node:fs';
import { saveContentAtomically } from '../../lib/fs.js';
import type { BufferedJsonLogger } from '../logging.js';
import { LiveRunSnapshotCollector } from './collector.js';

const DEFAULT_MIN_INTERVAL_MS = 200;

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: {
    filePath: string;
    collector: LiveRunSnapshotCollector;
  }) {
    this.filePath = options.filePath;
    this.collector = options.collector;
  }

  schedule(): void {
    if (this.stopped || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, DEFAULT_MIN_INTERVAL_MS);
    this.timer.unref();
  }

  flushNow(): Promise<void> {
    return this.enqueueWrite();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Waits for serialized writes, then unlinks synchronously. Awaiting an idle
   * queue yields only a microtask; the sync unlink prevents deferred macrotask
   * persistence from running before request resolution.
   */
  async remove(): Promise<void> {
    await this.queue;
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // A snapshot we cannot delete is a stale file, never a failed run.
    }
  }

  private enqueueWrite(): Promise<void> {
    this.queue = this.queue.then(() => this.writeOnce());
    return this.queue;
  }

  private writeOnce(): void {
    if (this.stopped) {
      return;
    }
    try {
      const text = `${JSON.stringify(this.collector.build(), null, 2)}\n`;
      saveContentAtomically(this.filePath, text);
    } catch (error) {
      this.collector.recordWriteError(error instanceof Error ? error.message : String(error));
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
