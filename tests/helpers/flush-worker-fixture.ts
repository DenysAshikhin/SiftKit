import { join } from 'node:path';

import { getShippedFlushWorkerPath, type InferenceRunFlushWorkerLaunch } from '../../src/status-server/inference-run-flush-queue.ts';
import { moduleDirname } from '../../src/lib/paths.ts';

/** A flush worker launch whose replies arrive `ackDelayMs` late, the condition the shutdown budget must survive.
 * The shipped worker answers in ~1ms, so the delay sits between the queue and that worker. */
export function lateAckFlushWorker(ackDelayMs: number): InferenceRunFlushWorkerLaunch {
  return {
    modulePath: join(moduleDirname(import.meta.url), '..', 'fixtures', 'late-ack-flush-worker.ts'),
    data: { workerPath: getShippedFlushWorkerPath(), ackDelayMs },
  };
}
