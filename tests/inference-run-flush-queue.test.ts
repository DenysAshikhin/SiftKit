import test from 'node:test';
import assert from 'node:assert/strict';

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
import { withTestEnvAndServer } from './_test-helpers.js';
import { waitForCondition } from './helpers/deferred-shutdown-fixture.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import { failReportingOn, committedRows } from './helpers/inference-run-flush-queue-fixtures.js';

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
