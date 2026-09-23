import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  InferenceRunFlushQueue,
} from '../../src/status-server/inference-run-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  getInferenceRunPendingLogChunkStats,
  readInferenceRunLogTextByStream,
} from '../../src/state/inference-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { withTestEnvAndServer } from '../_test-helpers.js';
import { waitForCondition } from '../helpers/deferred-shutdown-fixture.js';
import { lateAckFlushWorker } from '../helpers/flush-worker-fixture.js';
import { OutputCapture } from '../helpers/stdout-capture.js';
import { failReportingOn, committedRows } from '../helpers/inference-run-flush-queue-fixtures.js';

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
