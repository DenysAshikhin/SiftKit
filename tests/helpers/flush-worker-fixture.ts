import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

import { InferenceRunFlushQueue } from '../../src/status-server/inference-run-flush-queue.js';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../../src/lib/paths.js';

/** Where the built flush worker lands — the same path the queue resolves in production. */
export function getFlushWorkerPath(): string {
  const packageRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (packageRoot === null) {
    throw new Error('Unable to locate the SiftKit package root for the inference-run flush worker.');
  }
  return join(packageRoot, 'dist', 'status-server', 'inference-run-flush-worker.js');
}

export type FlushQueueInternals = {
  runningRunId: string | null;
  draining: boolean;
  worker: Worker | null;
  getWorker: () => Worker;
};

/**
 * Reaches the state the queue deliberately never exposes. `getWorker` is included because it is the
 * only seam a flush can be made slow through: the real worker yields the writer in 1ms, so no amount
 * of database contention produces a *late* acknowledgement, and late acknowledgements are what the
 * shutdown budget has to survive. Shadowing the prototype method leaves the production path untouched.
 */
export function flushQueueInternals(queue: InferenceRunFlushQueue): FlushQueueInternals {
  return z.custom<FlushQueueInternals>((value) => value instanceof InferenceRunFlushQueue).parse(queue);
}

/**
 * Proxies the real flush worker and holds its reply for `ackDelayMs`. The batch is written by the real
 * worker before the reply is held back, so a delayed acknowledgement is exactly what it looks like: a
 * commit whose outcome arrived too late to be believed, never a failed write.
 */
const LATE_ACK_WORKER_SCRIPT = `
const { parentPort, workerData, Worker } = require('node:worker_threads');
const child = new Worker(workerData.workerPath);
child.unref();
let lastRequestId = 0;
parentPort.on('message', (request) => {
  lastRequestId = request.id;
  child.postMessage(request);
});
child.on('message', (response) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ackDelayMs);
  parentPort.postMessage(response);
});
child.on('error', (error) => {
  parentPort.postMessage({ id: lastRequestId, ok: false, errorMessage: String(error) });
});
parentPort.on('close', () => {
  void child.terminate();
});
`;

/**
 * Swaps the queue's flush worker for one that acknowledges `ackDelayMs` late. It fills the worker slot
 * itself, so `close()` still finds the handle and still performs its in-flight wait.
 */
export function installLateAckFlushWorker(queue: InferenceRunFlushQueue, ackDelayMs: number): void {
  const internals = flushQueueInternals(queue);
  internals.getWorker = (): Worker => {
    const existing = internals.worker;
    if (existing !== null) {
      return existing;
    }
    const worker = new Worker(LATE_ACK_WORKER_SCRIPT, {
      eval: true,
      workerData: { workerPath: getFlushWorkerPath(), ackDelayMs },
    });
    worker.unref();
    internals.worker = worker;
    return worker;
  };
}