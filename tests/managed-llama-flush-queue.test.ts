import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import {
  bufferManagedLlamaLogChunk,
  createManagedLlamaRun,
  readManagedLlamaLogTextByStream,
} from '../dist/state/managed-llama-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../dist/state/runtime-db.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('managed llama flush queue coalesces duplicate run flushes and drains asynchronously', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();
    database.pragma('busy_timeout = 1');
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'queued\n' });

    const blocker = new Database(getRuntimeDatabasePath());
    blocker.pragma('busy_timeout = 1');
    blocker.exec('BEGIN IMMEDIATE');
    const queue = new ManagedLlamaFlushQueue();

    try {
      try {
        assert.equal(queue.enqueue(run.id), true);
        assert.equal(queue.enqueue(run.id), false);
        assert.equal(queue.getSnapshot().pendingCount, 1);
        await queue.drainNow();
        assert.equal(queue.getSnapshot().pendingCount, 1);
      } finally {
        blocker.exec('ROLLBACK');
        blocker.close();
      }

      await queue.waitForIdle(1000);
      const persistedText = readManagedLlamaLogTextByStream(run.id);
      assert.equal(persistedText.startup_script_stdout, 'queued\n');
      assert.equal(queue.getSnapshot().pendingCount, 0);
      assert.equal(queue.getSnapshot().completedCount, 1);
    } finally {
      await queue.close();
    }
  });
});
