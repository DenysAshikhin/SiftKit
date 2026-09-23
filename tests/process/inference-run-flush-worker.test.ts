import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { z } from '../../src/lib/zod.js';
import {
  createInferenceRun,
  readInferenceRunLogTextByStream,
  type InferenceRunPendingLogChunkEntry,
} from '../../src/state/inference-runs.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { getFlushWorkerPath } from '../helpers/flush-worker-fixture.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

const FlushWorkerResponseSchema = z.object({
  id: z.number(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
});

async function flushInWorker(request: {
  runId: string;
  databasePath: string;
  entries: InferenceRunPendingLogChunkEntry[];
}): Promise<z.infer<typeof FlushWorkerResponseSchema>> {
  const worker = new Worker(getFlushWorkerPath());
  try {
    return await new Promise((resolve, reject) => {
      worker.on('message', (message) => resolve(FlushWorkerResponseSchema.parse(message)));
      worker.on('error', reject);
      worker.postMessage({ id: 1, ...request });
    });
  } finally {
    await worker.terminate();
  }
}

// An empty batch must not be the reason runtime.sqlite gets created, initialized, or checkpointed:
// pointing it at a path that does not exist proves the worker never opened a database at all.
test('inference run flush worker answers an empty batch without touching the database', async () => {
  const tempRoot = createManagedTempDir('siftkit-flush-worker-empty-');
  const databasePath = path.join(tempRoot, 'absent', 'runtime.sqlite');

  const response = await flushInWorker({ runId: 'run-empty', databasePath, entries: [] });

  assert.deepEqual(response, { id: 1, ok: true });
  assert.equal(fs.existsSync(path.dirname(databasePath)), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('inference run flush worker treats a batch of empty strings as empty', async () => {
  const tempRoot = createManagedTempDir('siftkit-flush-worker-blank-');
  const databasePath = path.join(tempRoot, 'absent', 'runtime.sqlite');

  const response = await flushInWorker({
    runId: 'run-blank',
    databasePath,
    entries: [
      { streamKind: 'launcher_stdout', chunkText: '' },
      { streamKind: 'launcher_stderr', chunkText: '' },
    ],
  });

  assert.deepEqual(response, { id: 1, ok: true });
  assert.equal(fs.existsSync(path.dirname(databasePath)), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** A real runtime database with one run row, closed again so the worker owns the only handle. */
function createRunDatabase(prefix: string): { databasePath: string; runId: string; tempRoot: string } {
  const tempRoot = createManagedTempDir(prefix);
  const databasePath = path.join(tempRoot, 'runtime.sqlite');
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup', databasePath });
  closeRuntimeDatabase(databasePath);
  return { databasePath, runId: run.id, tempRoot };
}

// Whitespace is log content; only zero-length entries are dropped, and the rest still lands.
test('inference run flush worker writes the nonempty entries of a mixed batch', async () => {
  const { databasePath, runId, tempRoot } = createRunDatabase('siftkit-flush-worker-mixed-');

  const response = await flushInWorker({
    runId,
    databasePath,
    entries: [
      { streamKind: 'launcher_stdout', chunkText: '' },
      { streamKind: 'launcher_stderr', chunkText: ' \t' },
      { streamKind: 'engine_stdout', chunkText: 'ready\n' },
    ],
  });

  assert.deepEqual(response, { id: 1, ok: true });
  const text = readInferenceRunLogTextByStream(runId, databasePath);
  assert.equal(text.launcher_stdout, '');
  assert.equal(text.launcher_stderr, ' \t');
  assert.equal(text.engine_stdout, 'ready\n');
  closeRuntimeDatabase(databasePath);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The batch is one transaction: a rejected second insertion leaves no first chunk behind, so
// the queue's retry of the same batch writes each chunk exactly once instead of duplicating it.
test('inference run flush worker rolls back the whole batch when one entry fails', async () => {
  const { databasePath, runId, tempRoot } = createRunDatabase('siftkit-flush-worker-atomic-');
  const database = getRuntimeDatabase(databasePath);
  database.exec(`
    CREATE TRIGGER reject_stderr BEFORE INSERT ON inference_run_log_chunks
    WHEN NEW.stream_kind = 'launcher_stderr'
    BEGIN SELECT RAISE(ABORT, 'stderr rejected'); END;
  `);
  closeRuntimeDatabase(databasePath);
  const entries: InferenceRunPendingLogChunkEntry[] = [
    { streamKind: 'launcher_stdout', chunkText: 'first\n' },
    { streamKind: 'launcher_stderr', chunkText: 'second\n' },
  ];

  const failed = await flushInWorker({ runId, databasePath, entries });
  assert.equal(failed.ok, false);
  assert.match(failed.errorMessage ?? '', /stderr rejected/u);
  const countRow = getRuntimeDatabase(databasePath)
    .prepare('SELECT COUNT(*) AS count FROM inference_run_log_chunks WHERE run_id = ?')
    .get(runId);
  assert.deepEqual(countRow, { count: 0 });
  getRuntimeDatabase(databasePath).exec('DROP TRIGGER reject_stderr');
  closeRuntimeDatabase(databasePath);

  const retried = await flushInWorker({ runId, databasePath, entries });
  assert.deepEqual(retried, { id: 1, ok: true });
  const text = readInferenceRunLogTextByStream(runId, databasePath);
  assert.equal(text.launcher_stdout, 'first\n');
  assert.equal(text.launcher_stderr, 'second\n');
  closeRuntimeDatabase(databasePath);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
