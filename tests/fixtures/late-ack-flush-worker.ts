/**
 * A flush worker that hands every batch to the real flush worker and holds that worker's reply for
 * `ackDelayMs`. The batch is written by the real worker before the reply is held back, so a delayed
 * acknowledgement is exactly what it looks like: a commit whose outcome arrived too late to be
 * believed, never a failed write.
 *
 * It is a worker entrypoint in its own right, spawned through `InferenceRunFlushWorkerLaunch`, and it
 * speaks the shipped queue↔worker protocol unchanged — validating both directions with the same
 * schemas the queue and the real worker use.
 */
import { parentPort, workerData, Worker } from 'node:worker_threads';

import { z } from '../../src/lib/zod.js';
import {
  FlushWorkerRequestSchema,
  FlushWorkerResponseSchema,
  type FlushWorkerRequest,
  type FlushWorkerResponse,
} from '../../src/status-server/inference-run-flush-messages.js';

/** What the queue forwards to this module untouched; only this module reads it, so only it validates it. */
const LateAckWorkerDataSchema = z.object({
  /** The worker whose replies this one delays — the shipped flush worker. */
  workerPath: z.string().min(1),
  ackDelayMs: z.number().int().nonnegative().max(60_000),
});

const parent = parentPort;
if (parent === null) {
  throw new Error('The late-acknowledgement flush worker has to be spawned by a flush queue.');
}
const launch = LateAckWorkerDataSchema.parse(workerData);

const worker = new Worker(launch.workerPath);
// The queue terminates this proxy; a child that kept the event loop alive on its own would outlive it.
worker.unref();
let lastRequestId = 0;

parent.on('message', (posted: FlushWorkerRequest) => {
  const request = FlushWorkerRequestSchema.parse(posted);
  lastRequestId = request.id;
  worker.postMessage(request);
});

worker.on('message', (posted: FlushWorkerResponse) => {
  const response = FlushWorkerResponseSchema.parse(posted);
  // A real wait rather than a timer: the reply still has to be missing when the queue's budget
  // expires, and a timer would run once this thread got scheduled instead of never.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, launch.ackDelayMs);
  parent.postMessage(response);
});

worker.on('error', (error: Error) => {
  parent.postMessage({
    id: lastRequestId,
    ok: false,
    errorMessage: String(error),
  } satisfies FlushWorkerResponse);
});

parent.on('close', () => {
  void worker.terminate();
});