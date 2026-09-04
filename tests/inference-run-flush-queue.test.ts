import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  InferenceRunFlushQueue,
  PENDING_FLUSH_HIGH_WATER_CHARACTERS,
} from '../src/status-server/inference-run-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  getInferenceRunPendingLogChunkStats,
  readInferenceRunLogTextByStream,
} from '../src/state/inference-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { OutputCapture } from './helpers/stdout-capture.js';

type FlushQueueInternals = {
  runningRunId: string | null;
  draining: boolean;
};

/** Reaches the drain state the queue never exposes, so close() can be driven deterministically. */
function flushQueueInternals(queue: InferenceRunFlushQueue): FlushQueueInternals {
  return z.custom<FlushQueueInternals>((value) => value instanceof InferenceRunFlushQueue).parse(queue);
}

test('inference run flush queue coalesces duplicate run flushes and drains asynchronously', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const database = getRuntimeDatabase();
    database.pragma('busy_timeout = 1');
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'queued\n' });

    const blocker = new Database(getRuntimeDatabasePath());
    blocker.pragma('busy_timeout = 1');
    blocker.exec('BEGIN IMMEDIATE');
    const queue = new InferenceRunFlushQueue();

    try {
      try {
        assert.equal(queue.enqueue(run.id, 'exl3'), true);
        assert.equal(queue.enqueue(run.id, 'exl3'), false);
        assert.equal(queue.getSnapshot().pendingCount, 1);
        await queue.drainNow();
        assert.equal(queue.getSnapshot().pendingCount, 1);
      } finally {
        blocker.exec('ROLLBACK');
        blocker.close();
      }

      await queue.waitForIdle();
      const persistedText = readInferenceRunLogTextByStream(run.id);
      assert.equal(persistedText.launcher_stdout, 'queued\n');
      assert.equal(queue.getSnapshot().pendingCount, 0);
      assert.equal(queue.getSnapshot().completedCount, 1);
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue logs each run under its own backend scope', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'exl3-scoped\n' });
    const queue = new InferenceRunFlushQueue();

    const capture = OutputCapture.start(process.stdout);
    try {
      try {
        assert.equal(queue.enqueue(run.id, 'exl3'), true);
        await queue.waitForIdle();
      } finally {
        await queue.close();
      }
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(
      lines.some((line) => line.includes(`exl3 ${run.id.slice(0, 8)}  flush_done`)),
      true,
      lines.join('\n'),
    );
    assert.equal(
      lines.some((line) => line.includes(`inference ${run.id.slice(0, 8)}`)),
      false,
      lines.join('\n'),
    );
  });
});

test('inference run flush queue records another flush requested while the same run is active', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const queue = new InferenceRunFlushQueue();
    const internals = flushQueueInternals(queue);
    internals.runningRunId = run.id;
    internals.draining = true;

    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      assert.equal(queue.getSnapshot().pendingCount, 1);
      assert.equal(queue.getSnapshot().scheduled, false);
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue idle wait fails with state diagnostics at its ceiling', async () => {
  const queue = new InferenceRunFlushQueue();
  const internals = flushQueueInternals(queue);
  internals.runningRunId = 'run-stuck';
  internals.draining = true;

  await assert.rejects(
    queue.waitForIdle(25),
    /pendingCount=0 runningRunId=run-stuck scheduled=false completedCount=0 failedCount=0/u,
  );
  await queue.close();
});

test('inference run flush queue waits for model-request idle delay before draining', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'idle-gated\n' });
    const queue = new InferenceRunFlushQueue({ idleDelayMs: 80 });

    try {
      queue.markModelRequestFinished(Date.now());
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(queue.getSnapshot().completedCount, 0);

      await queue.waitForIdle();
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'idle-gated\n');
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue pauses while a model request is active and drains after idle', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'active-gated\n' });
    const queue = new InferenceRunFlushQueue({ idleDelayMs: 50 });

    try {
      queue.setModelRequestState({ active: true, queueLength: 0 });
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      assert.equal(queue.getSnapshot().completedCount, 0);

      queue.setModelRequestState({ active: false, queueLength: 0, lastFinishedAtMs: Date.now() });
      await queue.waitForIdle();
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'active-gated\n');
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue does not log repeated active-request drain waits', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'active-gated\n' });
    const queue = new InferenceRunFlushQueue({ idleDelayMs: 20 });

    const capture = OutputCapture.start(process.stdout);
    try {
      try {
        queue.setModelRequestState({ active: true, queueLength: 0 });
        assert.equal(queue.enqueue(run.id, 'exl3'), true);
        await new Promise<void>((resolve) => setTimeout(resolve, 70));
      } finally {
        await queue.close();
      }
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(
      lines.some((line) => line.includes(`inference ${run.id.slice(0, 8)}  flush_done`)),
      false,
      lines.join('\n'),
    );
  });
});

// Terminating the worker mid-flush kills the thread with its sqlite handle open: the write is
// lost and better-sqlite3 can take the process down with it. close() must let it land first.
test('closing the queue completes an in-flight flush instead of terminating it', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'in-flight\n' });
    const queue = new InferenceRunFlushQueue();

    assert.equal(queue.enqueue(run.id, 'exl3'), true);
    // drainNow marks the run running before it awaits the worker, so close() sees it in flight.
    const draining = queue.drainNow();
    await queue.close();
    await draining;

    assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'in-flight\n');
    assert.equal(queue.getSnapshot().completedCount, 1);
  });
});

// The worker closes its connection after every message, so the second flush has to reopen it.
test('the flush worker serves consecutive runs after closing its database each time', async () => {
  await withTestEnvAndServer(async () => {
    const first = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const second = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: first.id, streamKind: 'launcher_stdout', chunkText: 'first\n' });
    bufferInferenceRunLogChunk({ runId: second.id, streamKind: 'launcher_stdout', chunkText: 'second\n' });
    const queue = new InferenceRunFlushQueue();

    try {
      assert.equal(queue.enqueue(first.id, 'exl3'), true);
      await queue.waitForIdle();
      assert.equal(queue.enqueue(second.id, 'exl3'), true);
      await queue.waitForIdle();
    } finally {
      await queue.close();
    }

    assert.equal(readInferenceRunLogTextByStream(first.id).launcher_stdout, 'first\n');
    assert.equal(readInferenceRunLogTextByStream(second.id).launcher_stdout, 'second\n');
    assert.equal(queue.getSnapshot().completedCount, 2);
  });
});

test('closing the queue reports an in-flight flush that outlives the wait budget', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 40 });
    assert.equal(queue.enqueue(run.id, 'exl3'), true);
    await queue.waitForIdle();

    const internals = flushQueueInternals(queue);
    internals.runningRunId = 'run-stuck';

    const capture = OutputCapture.start(process.stdout);
    try {
      await queue.close();
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(
      lines.some((line) => line.includes('flush_close_timeout') && line.includes('run-stuc')),
      true,
      lines.join('\n'),
    );
  });
});

test('a closed queue accepts no further work', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'ignored\n' });
    const queue = new InferenceRunFlushQueue();

    await queue.close();

    assert.equal(queue.enqueue(run.id, 'exl3'), false);
    await queue.drainNow();
    assert.equal(queue.getSnapshot().pendingCount, 0);
    assert.equal(queue.getSnapshot().completedCount, 0);
    // Nothing was consumed from the pending buffer, so no flush ran.
    assert.equal(getInferenceRunPendingLogChunkStats(run.id).totalCharacters, 'ignored\n'.length);
  });
});

test('a run past the pending high-water mark flushes despite an active model request', async () => {
  await withTestEnvAndServer(async () => {
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 60_000 });
    try {
      const run = createInferenceRun({
        backend: 'exl3',
        purpose: 'high-water-test',
        entrypointPath: null,
        baseUrl: null,
        status: 'running',
      });

      flushQueue.setModelRequestState({ active: true, queueLength: 0 });

      const chunk = 'x'.repeat(64 * 1024);
      const chunkCount = Math.ceil(PENDING_FLUSH_HIGH_WATER_CHARACTERS / chunk.length) + 1;
      for (let index = 0; index < chunkCount; index += 1) {
        bufferInferenceRunLogChunk({
          runId: run.id,
          streamKind: 'engine_stdout',
          chunkText: chunk,
        });
      }

      flushQueue.enqueue(run.id, 'exl3');
      await flushQueue.waitForIdle();

      const stats = getInferenceRunPendingLogChunkStats(run.id);
      assert.equal(stats.totalCharacters, 0, 'over-high-water run must flush past the deferral');

      const text = readInferenceRunLogTextByStream(run.id);
      assert.equal(text.engine_stdout.length, chunk.length * chunkCount, 'no log data may be dropped');
    } finally {
      await flushQueue.close();
    }
  });
});
