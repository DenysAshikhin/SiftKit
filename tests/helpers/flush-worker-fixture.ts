import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TEST_BUILD_ROOT } from '../../src/test-runner/test-build-state.js';
import type { InferenceRunFlushWorkerLaunch } from '../../src/status-server/inference-run-flush-queue.js';

import { findNearestSiftKitRepoRoot, moduleDirname } from '../../src/lib/paths.js';

/** The package root this test tree belongs to â€” the same one the queue resolves its worker from. */
function getSiftKitPackageRoot(): string {
  const packageRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (packageRoot === null) {
    throw new Error('Unable to locate the SiftKit package root for the inference-run flush worker.');
  }
  return packageRoot;
}

/** Where the built flush worker lands â€” the same path the queue resolves in production. */
export function getFlushWorkerPath(): string {
  return join(getSiftKitPackageRoot(), 'dist', 'status-server', 'inference-run-flush-worker.js');
}

/**
 * The late-acknowledgement worker entrypoint, compiled. `tsc -p tsconfig.test-build.json` emits every
 * non-entry file under `tests/` beside the bundled test entries, so a suite run spawns that module; a
 * run against the source tree (`tsx --test <file>`) spawns the TypeScript itself.
 */
function getLateAckFlushWorkerModulePath(): string {
  const packageRoot = getSiftKitPackageRoot();
  const compiled = join(packageRoot, TEST_BUILD_ROOT, 'tests', 'fixtures', 'late-ack-flush-worker.js');
  return existsSync(compiled)
    ? compiled
    : join(packageRoot, 'tests', 'fixtures', 'late-ack-flush-worker.ts');
}

/**
 * A flush worker launch whose replies arrive `ackDelayMs` late. Late acknowledgements are what the
 * shutdown budget has to survive, and the shipped worker answers in about a millisecond, so no amount
 * of database contention produces one: the delay has to sit between the queue and that worker, which
 * is precisely what the launch descriptor puts there.
 */
export function lateAckFlushWorker(ackDelayMs: number): InferenceRunFlushWorkerLaunch {
  return {
    modulePath: getLateAckFlushWorkerModulePath(),
    data: { workerPath: getFlushWorkerPath(), ackDelayMs },
  };
}
