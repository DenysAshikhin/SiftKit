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

test('managed llama flush queue records another flush requested while the same run is active', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const queue = new ManagedLlamaFlushQueue();
    type FlushQueueInternals = {
      runningRunId: string | null;
      draining: boolean;
    };
    const internals = queue as unknown as FlushQueueInternals;
    internals.runningRunId = run.id;
    internals.draining = true;

    try {
      assert.equal(queue.enqueue(run.id), true);
      assert.equal(queue.getSnapshot().pendingCount, 1);
      assert.equal(queue.getSnapshot().scheduled, false);
    } finally {
      await queue.close();
    }
  });
});

test('managed llama flush queue waits for model-request idle delay before draining', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'idle-gated\n' });
    const queue = new ManagedLlamaFlushQueue({ idleDelayMs: 80 });

    try {
      queue.markModelRequestFinished(Date.now());
      assert.equal(queue.enqueue(run.id), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(queue.getSnapshot().completedCount, 0);

      await queue.waitForIdle(1000);
      assert.equal(readManagedLlamaLogTextByStream(run.id).startup_script_stdout, 'idle-gated\n');
    } finally {
      await queue.close();
    }
  });
});

test('managed llama flush queue pauses while a model request is active and drains after idle', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'active-gated\n' });
    const queue = new ManagedLlamaFlushQueue({ idleDelayMs: 50 });

    try {
      queue.setModelRequestState({ active: true, queueLength: 0 });
      assert.equal(queue.enqueue(run.id), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      assert.equal(queue.getSnapshot().completedCount, 0);

      queue.setModelRequestState({ active: false, queueLength: 0, lastFinishedAtMs: Date.now() });
      await queue.waitForIdle(1000);
      assert.equal(readManagedLlamaLogTextByStream(run.id).startup_script_stdout, 'active-gated\n');
    } finally {
      await queue.close();
    }
  });
});
