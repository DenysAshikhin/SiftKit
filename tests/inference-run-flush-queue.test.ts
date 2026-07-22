import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { z } from 'zod';

import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  readInferenceRunLogTextByStream,
} from '../src/state/inference-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { withTestEnvAndServer } from './_test-helpers.js';

function createStdoutCapture(): { lines: string[]; restore: () => void } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  let buffer = '';
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) {
        lines.push(line);
      }
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  return {
    lines,
    restore: () => {
      process.stdout.write = originalWrite;
      if (buffer.trim()) {
        lines.push(buffer.trim());
      }
    },
  };
}

test('managed llama flush queue coalesces duplicate run flushes and drains asynchronously', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const database = getRuntimeDatabase();
    database.pragma('busy_timeout = 1');
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'queued\n' });

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
      const persistedText = readInferenceRunLogTextByStream(run.id);
      assert.equal(persistedText.launcher_stdout, 'queued\n');
      assert.equal(queue.getSnapshot().pendingCount, 0);
      assert.equal(queue.getSnapshot().completedCount, 1);
    } finally {
      await queue.close();
    }
  });
});

test('managed llama flush queue records another flush requested while the same run is active', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const queue = new ManagedLlamaFlushQueue();
    type FlushQueueInternals = {
      runningRunId: string | null;
      draining: boolean;
    };
    const internals = z.custom<FlushQueueInternals>((value) => value instanceof ManagedLlamaFlushQueue).parse(queue);
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
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'idle-gated\n' });
    const queue = new ManagedLlamaFlushQueue({ idleDelayMs: 80 });

    try {
      queue.markModelRequestFinished(Date.now());
      assert.equal(queue.enqueue(run.id), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(queue.getSnapshot().completedCount, 0);

      await queue.waitForIdle(1000);
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'idle-gated\n');
    } finally {
      await queue.close();
    }
  });
});

test('managed llama flush queue pauses while a model request is active and drains after idle', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'active-gated\n' });
    const queue = new ManagedLlamaFlushQueue({ idleDelayMs: 50 });

    try {
      queue.setModelRequestState({ active: true, queueLength: 0 });
      assert.equal(queue.enqueue(run.id), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      assert.equal(queue.getSnapshot().completedCount, 0);

      queue.setModelRequestState({ active: false, queueLength: 0, lastFinishedAtMs: Date.now() });
      await queue.waitForIdle(1000);
      assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'active-gated\n');
    } finally {
      await queue.close();
    }
  });
});

test('managed llama flush queue does not log repeated active-request drain waits', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'active-gated\n' });
    const queue = new ManagedLlamaFlushQueue({ idleDelayMs: 20 });
    const capture = createStdoutCapture();

    try {
      queue.setModelRequestState({ active: true, queueLength: 0 });
      assert.equal(queue.enqueue(run.id), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 70));
    } finally {
      capture.restore();
      await queue.close();
    }

    assert.equal(
      capture.lines.some((line) => line.includes(`llama ${run.id.slice(0, 8)}  flush_done`)),
      false,
      capture.lines.join('\n'),
    );
  });
});
