import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  InferenceRunFlushQueue,
  PENDING_FLUSH_HIGH_WATER_CHARACTERS,
} from '../src/status-server/inference-run-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  consumeInferenceRunPendingLogChunks,
  createInferenceRun,
  getInferenceRunPendingLogChunkStats,
  readInferenceRunLogTextByStream,
} from '../src/state/inference-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { waitForCondition } from './helpers/deferred-shutdown-fixture.js';
import { lateAckFlushWorker } from './helpers/flush-worker-fixture.js';
import { countLogRows } from './helpers/runtime-database-probe.js';
import { OutputCapture } from './helpers/stdout-capture.js';

/**
 * Makes the *reporting* path fail: `ServerLogger` writes to stdout synchronously, so a sink that
 * throws on the matching line is a report that failed after the database write had already
 * committed — the one failure the restore-and-retry path must never treat as a rejected transaction.
 * Everything else passes through, so the test reporter's own output is untouched.
 */
function failReportingOn(t: TestContext, marker: string): void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes(marker)) {
      throw new Error('injected reporting failure');
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  t.after(() => {
    process.stdout.write = originalWrite;
  });
}

/** Committed chunk rows for `runId`, read straight from the runtime database. */
function committedRows(runId: string): number {
  return countLogRows(getRuntimeDatabase(), runId);
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

// An empty batch has nothing to write, so starting the flush flow would only contend for the
// journal. Whitespace is real log data and must still flush.
test('inference run flush queue refuses to enqueue a run with nothing buffered', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const queue = new InferenceRunFlushQueue();

    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), false);
      assert.deepEqual(queue.getSnapshot(), {
        pendingCount: 0,
        runningRunId: null,
        scheduled: false,
        completedCount: 0,
        failedCount: 0,
      });

      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: '  \t ' });
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await queue.waitForIdle();
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, '  \t ');
      assert.equal(queue.getSnapshot().completedCount, 1);
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue drops a queued run whose buffer emptied before draining', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'taken\n' });
    const queue = new InferenceRunFlushQueue();

    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      assert.deepEqual(consumeInferenceRunPendingLogChunks(run.id), [
        { streamKind: 'launcher_stdout', chunkText: 'taken\n' },
      ]);

      await queue.drainNow();
      await queue.waitForIdle();
      // Skipped, not flushed and not failed: neither counter moves.
      assert.equal(queue.getSnapshot().completedCount, 0);
      assert.equal(queue.getSnapshot().failedCount, 0);
      assert.equal(queue.getSnapshot().pendingCount, 0);
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, '');
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
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'busy\n' });
    // A flush has to be genuinely in flight for this to mean anything, so the run is drained through
    // a worker that keeps its reply back until the second enqueue has been observed.
    const queue = new InferenceRunFlushQueue({ flushWorker: lateAckFlushWorker(250) });

    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await waitForCondition(() => queue.getSnapshot().runningRunId === run.id, 5_000,
        'the first batch is with the worker');
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'again\n' });
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      assert.equal(queue.getSnapshot().pendingCount, 1);
      assert.equal(queue.getSnapshot().scheduled, false, 'a drain in flight does not schedule a second one');
    } finally {
      await queue.close();
    }
  });
});

test('inference run flush queue idle wait fails with state diagnostics at its ceiling', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'ceiling\n' });
    const queue = new InferenceRunFlushQueue({ flushWorker: lateAckFlushWorker(250) });

    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await waitForCondition(() => queue.getSnapshot().runningRunId === run.id, 5_000,
        'the wait has to run out against a batch that is actually running');
      await assert.rejects(
        () => queue.waitForIdle(25),
        new RegExp(`pendingCount=0 runningRunId=${run.id} scheduled=false completedCount=0 failedCount=0`, 'u'),
      );
    } finally {
      await queue.close();
    }
  });
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
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'stuck\n' });
    // The reply arrives after the close budget, which is how a flush is still in flight when close()
    // starts: the batch itself is written, and only its outcome is late.
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 40, flushWorker: lateAckFlushWorker(500) });
    assert.equal(queue.enqueue(run.id, 'exl3'), true);
    await waitForCondition(() => queue.getSnapshot().runningRunId === run.id, 5_000);

    const capture = OutputCapture.start(process.stdout);
    try {
      await queue.close();
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    assert.equal(
      lines.some((line) => line.includes('flush_close_timeout') && line.includes(run.id.slice(0, 8))),
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

// Restore-and-retry is justified only by a rejected transaction. A report that fails after the worker
// acked used to land in that same catch: it restored already-committed chunk text to the pending
// buffer, wrote it a second time, and moved both counters for one batch.
test('a report that fails after a committed flush never rewrites the batch', async t => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'hello\n' });
    const queue = new InferenceRunFlushQueue();
    failReportingOn(t, 'flush_done');
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(() => queue.drainNow(), /injected reporting failure/u, 'the failure still surfaces');

      assert.equal(committedRows(run.id), 1, 'the batch was written exactly once');
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'hello\n');
      assert.equal(getInferenceRunPendingLogChunkStats(run.id).totalCharacters, 0, 'nothing was restored to the buffer');
      assert.deepEqual(queue.getSnapshot(), {
        pendingCount: 0, runningRunId: null, scheduled: false, completedCount: 1, failedCount: 0,
      }, 'one batch can never advance both counters');
    } finally {
      await queue.close();
    }
  });
});

// An escaped failure ends that pass, not the queue: the items behind it must not wait for some
// unrelated enqueue to kick the drain again.
test('a report that fails stops that pass without stalling the runs behind it', async t => {
  await withTestEnvAndServer(async () => {
    const runs = ['first', 'second', 'third'].map(purpose => createInferenceRun({ backend: 'exl3', purpose }));
    for (const run of runs) {
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'batch\n' });
    }
    const queue = new InferenceRunFlushQueue();
    failReportingOn(t, 'flush_done');
    try {
      for (const run of runs) {
        assert.equal(queue.enqueue(run.id, 'exl3'), true);
      }

      // Waits on the queue having taken the acknowledgements, not on the rows being visible: the
      // worker commits before it answers, so a committed row does not yet mean the drain saw it.
      await waitForCondition(() => queue.getSnapshot().completedCount === 3, 5_000,
        'every run behind the failing report still got its drain');
      assert.equal(queue.getSnapshot().failedCount, 0, 'a failed report is not a failed write');
      for (const run of runs) {
        assert.equal(committedRows(run.id), 1, `run ${run.id} wrote its batch once`);
      }
    } finally {
      await queue.close();
    }
  });
});

// A shutdown that joins a drain already in flight only polls queue state. If the failed batch was the
// last one the queue genuinely looks idle, so the recorded failure has to be what it finds.
test('a shutdown that joins a drain in flight still gets its failure', async t => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'joined\n' });
    const queue = new InferenceRunFlushQueue();
    failReportingOn(t, 'flush_done');
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      const inFlight = queue.drainNow();
      const settled = inFlight.then(() => null, (error: Error) => error);

      await assert.rejects(() => queue.drainForShutdown(2_000), /injected reporting failure/u);
      assert.match(String(await settled), /injected reporting failure/u);
      assert.equal(committedRows(run.id), 1, 'and the batch itself was still written once');
    } finally {
      await queue.close();
    }
  });
});

// The drain a timer starts has no caller to receive the failure. It is recorded for whoever waits on
// the queue, and written straight to stderr — a handler that reported through the logger could throw
// again on the same sink and come back as the unhandled rejection this path exists to remove.
test('a report that fails in a timer-started drain is recorded and reported on stderr', async t => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'retried\n' });
    const queue = new InferenceRunFlushQueue();
    const blocker = new Database(getRuntimeDatabasePath());
    blocker.pragma('busy_timeout = 1');
    blocker.exec('BEGIN IMMEDIATE');
    const stderr = OutputCapture.start(process.stderr);
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await queue.drainNow();
      assert.equal(queue.getSnapshot().failedCount, 1, 'the rejected transaction took the legitimate retry path');
      blocker.exec('ROLLBACK');
      blocker.close();
      failReportingOn(t, 'flush_done');

      // The retry runs from `scheduleDrain(250)`, so nothing here awaits the failing drain.
      await waitForCondition(() => committedRows(run.id) === 1, 5_000);
      await waitForCondition(() => stderr.lines.join('\n').includes('Inference run flush drain failed'), 5_000);
      assert.match(stderr.lines.join('\n'), /Inference run flush drain failed: injected reporting failure/u);
      await assert.rejects(() => queue.waitForIdle(100), /injected reporting failure/u);
    } finally {
      stderr.restore();
      await queue.close();
    }
  });
});

// The budget is a bound on total shutdown persistence time, not on its tail. It used to start after the
// first drain pass, so the flush a stalled worker never acknowledged ran unbounded and shutdown
// reported nothing.
test('the shutdown budget bounds the first flush and its acknowledgement', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'slow\n' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 50, flushWorker: lateAckFlushWorker(250) });
    const stdout = OutputCapture.start(process.stdout);
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      const startedAtMs = Date.now();
      await assert.rejects(
        () => queue.drainForShutdown(25),
        /flush acknowledgement not received within budget/u,
        'a budget that excludes the first flush is not a budget',
      );
      const elapsedMs = Date.now() - startedAtMs;
      assert.ok(elapsedMs <= 125, `a 25ms budget was overrun by ${elapsedMs}ms`);
      assert.equal(getInferenceRunPendingLogChunkStats(run.id).totalCharacters, 0,
        'an abandoned batch is never restored to the buffer');
      assert.deepEqual(queue.getSnapshot(), {
        pendingCount: 0, runningRunId: run.id, scheduled: false, completedCount: 0, failedCount: 0,
      }, 'the batch stays the worker\'s, and neither counter claims to know its outcome');

      await queue.close();
      assert.match(stdout.lines.join('\n'), /flush_close_timeout/u,
        'and close() says which handle it had to give up on instead of leaking it quietly');
    } finally {
      stdout.restore();
      await queue.close();
    }
  });
});

// The bound must not be eager: a flush that makes it inside the budget is a success, not a suspect.
test('an acknowledgement that is slow but inside the budget still flushes exactly once', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'patient\n' });
    const queue = new InferenceRunFlushQueue({ flushWorker: lateAckFlushWorker(120) });
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await queue.drainForShutdown(2_000);
      assert.equal(committedRows(run.id), 1, 'a batch the worker acknowledged was written once');
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'patient\n');
      assert.deepEqual(queue.getSnapshot(), {
        pendingCount: 0, runningRunId: null, scheduled: false, completedCount: 1, failedCount: 0,
      });
    } finally {
      await queue.close();
    }
  });
});

// A late acknowledgement may still commit, so restoring the batch would write it twice — defect #2
// arriving by a different route. The batch stays the worker's, and the next flush of that run must
// carry only its own text.
test('an acknowledgement that arrives after the budget never replays the batch', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'abandoned\n' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 50, flushWorker: lateAckFlushWorker(150) });
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(
        () => queue.drainForShutdown(25),
        /flush acknowledgement not received within budget/u,
      );
      // The whole point of not restoring: the worker gets there afterwards, on its own.
      await waitForCondition(() => committedRows(run.id) === 1, 5_000,
        'the batch the worker still owned committed once it got there');

      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'later\n' });
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await queue.drainNow();
      assert.equal(committedRows(run.id), 2, 'the abandoned batch was not queued up behind it');
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'abandoned\nlater\n');
    } finally {
      await queue.close();
    }
  });
});

// Between batches the deadline costs one comparison, and checking it before the hand-off is what keeps
// an unspent budget from consuming a batch it can no longer await.
test('a budget already spent rejects with the batch still owned by the queue', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'unspent\n' });
    const queue = new InferenceRunFlushQueue({ flushWorker: lateAckFlushWorker(250) });
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(
        () => queue.drainForShutdown(0),
        /Timed out draining inference run flush queue/u,
      );
      assert.equal(committedRows(run.id), 0, 'nothing was handed to the worker');
      assert.equal(getInferenceRunPendingLogChunkStats(run.id).totalCharacters, 'unspent\n'.length,
        'and nothing was consumed, so nothing needed restoring');
      assert.equal(queue.getSnapshot().pendingCount, 1);
      assert.equal(queue.getSnapshot().runningRunId, null);
      assert.equal(queue.getSnapshot().failedCount, 0, 'an unspent budget is not a failed write');

      // The rejection reschedules the leftover rather than leaving it buffered, so it still lands.
      await waitForCondition(() => committedRows(run.id) === 1, 5_000);
    } finally {
      await queue.close();
    }
  });
});

// An abandoned batch stays the queue's to wait for, and its acknowledgement does eventually arrive —
// that is what proves the write landed. `close()` waits on the same batch, so a reply that went
// unclaimed left close() burning its whole budget and reporting a timeout for a flush that had
// already been written and answered.
test('an acknowledgement that arrives late releases the batch close() is waiting on', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'belated\n' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 2_000, flushWorker: lateAckFlushWorker(150) });
    const stdout = OutputCapture.start(process.stdout);
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(
        () => queue.drainForShutdown(25),
        /flush acknowledgement not received within budget/u,
      );
      assert.equal(queue.getSnapshot().runningRunId, run.id,
        'the batch stays owned by the queue until its reply arrives');

      const startedAtMs = Date.now();
      await queue.close();
      const elapsedMs = Date.now() - startedAtMs;
      assert.equal(committedRows(run.id), 1, 'the batch the worker answered was written');
      assert.equal(queue.getSnapshot().runningRunId, null, 'and its answer leaves nothing running');
      assert.ok(elapsedMs < 1_000, `close() waited ${elapsedMs}ms for a batch that had been answered`);
      assert.doesNotMatch(stdout.lines.join('\n'), /flush_close_timeout/u,
        'a queue whose batch was answered cannot report that it never was');
    } finally {
      stdout.restore();
      await queue.close();
    }
  });
});

// The running state says which batch the worker still owns, and a run drained twice leaves it holding
// the same run id for both of them. Attributing a late reply by run id let the abandoned batch's reply
// clear the newer one, so close() returned in milliseconds over a drain still in flight and terminated
// the worker with its write unfinished.
test('a late acknowledgement cannot clear a newer batch of the same run', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'abandoned\n' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 2_000, flushWorker: lateAckFlushWorker(300) });
    const stdout = OutputCapture.start(process.stdout);
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(
        () => queue.drainForShutdown(25),
        /flush acknowledgement not received within budget/u,
      );

      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'newer\n' });
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      const newerDrain = queue.drainNow();

      // The abandoned batch's reply is the event that matters: it lands while the newer batch is
      // still waiting for its own, which is the moment a run-id guard mistakes for an idle queue.
      await waitForCondition(() => stdout.lines.join('\n').includes('flush_late_ack'), 5_000,
        'the abandoned batch answered');
      assert.equal(queue.getSnapshot().runningRunId, run.id,
        'a reply to the abandoned batch is not an answer for the newer one');

      await newerDrain;
      assert.equal(committedRows(run.id), 2, 'both batches were written, each exactly once');
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'abandoned\nnewer\n');
    } finally {
      stdout.restore();
      await queue.close();
    }
  });
});

// A late reply is handled inside a worker event handler, where a throw escapes as an uncaught
// exception that no cleanup of ours ever sees. Reporting is the only thing there that can fail, so it
// has to fail alone: the batch still gets handed back, and the lost report says so on stderr.
test('a late acknowledgement whose report cannot be written is still released', async t => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'unreported\n' });
    const queue = new InferenceRunFlushQueue({ closeFlushWaitMs: 2_000, flushWorker: lateAckFlushWorker(150) });
    failReportingOn(t, 'flush_late_ack');
    const stderr = OutputCapture.start(process.stderr);
    try {
      assert.equal(queue.enqueue(run.id, 'exl3'), true);
      await assert.rejects(
        () => queue.drainForShutdown(25),
        /flush acknowledgement not received within budget/u,
      );

      await waitForCondition(() => queue.getSnapshot().runningRunId === null, 5_000,
        'the reply still handed the batch back with its report broken');
      assert.equal(committedRows(run.id), 1, 'and the batch it answered was written');
      assert.match(stderr.lines.join('\n'), /went unreported: injected reporting failure/u);
    } finally {
      stderr.restore();
      await queue.close();
    }
  });
});
