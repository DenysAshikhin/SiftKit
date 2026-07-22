import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  deleteInferenceRunLogChunksOlderThan,
  flushInferenceRunLogChunks,
  listInferenceRuns,
  readInferenceRun,
  readInferenceRunLogTextByStream,
  readInferenceRunLogTextStatsByStream,
} from '../src/state/inference-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaLogCursor,
  getManagedLlamaSpeculativeMetricsDelta,
  getManagedLlamaSpeculativeMetricsSince,
} from '../src/status-server/managed-llama.js';
import {
  appendManagedLlamaSpeculativeMetricsChunk,
  flushManagedLlamaSpeculativeMetricsTracker,
  ManagedLlamaSpeculativeMetricsTracker,
} from '../src/status-server/managed-llama-speculative-tracker.js';
import { releaseModelRequest } from '../src/status-server/server-ops.js';
import { z } from '../src/lib/zod.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { withTestEnvAndServer } from './_test-helpers.js';

// SQLite .get()/.all() return `unknown`; narrow to JsonObject at the boundary.
function asRow<T>(value: T): JsonObject {
  return JsonRecordReader.asObject(value) ?? {};
}

function asRows<T>(values: readonly T[]): JsonObject[] {
  return values.map((value) => JsonRecordReader.asObject(value) ?? {});
}

// Brand a partial server-ops context fixture at one boundary.
const ReleaseModelRequestCtxSchema = z.custom<Parameters<typeof releaseModelRequest>[0]>(
  (value) => typeof value === 'object' && value !== null,
);
function mockReleaseCtx(ctx: object): Parameters<typeof releaseModelRequest>[0] {
  return ReleaseModelRequestCtxSchema.parse(ctx);
}

async function captureStdoutLines(fn: () => Promise<void> | void): Promise<string[]> {
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
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  if (buffer.trim()) {
    lines.push(buffer.trim());
  }
  return lines;
}

test('inference runs are recorded per backend', async () => {
  await withTestEnvAndServer(async () => {
    const llama = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const exl3 = createInferenceRun({ backend: 'exl3', purpose: 'startup' });

    assert.equal(readInferenceRun(llama.id)?.backend, 'llama');
    assert.equal(readInferenceRun(exl3.id)?.backend, 'exl3');
    assert.equal(listInferenceRuns({ backend: 'exl3' }).length, 1);
    assert.equal(listInferenceRuns({ backend: 'llama' }).length, 1);
    assert.equal(listInferenceRuns({ backend: 'exl3', status: 'ready' }).length, 0);
  });
});

test('managed llama log chunks stay buffered until flushed', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const database = getRuntimeDatabase();

    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'first\n' });
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'second\n' });

    const beforeFlush = asRow(database.prepare(`
      SELECT COUNT(*) AS count
      FROM inference_run_log_chunks
      WHERE run_id = ?
    `).get(run.id));
    assert.equal(Number(beforeFlush.count || 0), 0);

    const pendingText = readInferenceRunLogTextByStream(run.id);
    assert.equal(pendingText.launcher_stdout, 'first\nsecond\n');

    flushInferenceRunLogChunks(run.id);

    const afterFlush = asRow(database.prepare(`
      SELECT COUNT(*) AS count
      FROM inference_run_log_chunks
      WHERE run_id = ?
    `).get(run.id));
    assert.equal(Number(afterFlush.count || 0), 1);

    const persistedText = readInferenceRunLogTextByStream(run.id);
    assert.equal(persistedText.launcher_stdout, 'first\nsecond\n');
  });
});

test('managed llama pending log chunks emit peak size logs only after one-kilobyte stream deltas', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });

    const lines = await captureStdoutLines(() => {
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'a'.repeat(1023) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'b' });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'c'.repeat(1023) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'd' });
    });

    const peakLines = lines.filter((line) => line.includes(`inference_run pending_log_peak run_id=${run.id}`));
    assert.deepEqual(
      peakLines.map((line) => line.replace(/^.*inference_run/u, 'inference_run')),
      [
        `inference_run pending_log_peak run_id=${run.id} pending_chars=1024 stream=engine_stdout stream_chars=1024`,
        `inference_run pending_log_peak run_id=${run.id} pending_chars=2048 stream=engine_stdout stream_chars=2048`,
      ],
    );
  });
});

test('managed llama log stats cap returned text while preserving full character counts', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });

    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'first-' });
    flushInferenceRunLogChunks(run.id);
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'second-pending' });

    const stats = readInferenceRunLogTextStatsByStream(run.id, { maxCharactersPerStream: 10 });

    assert.equal(stats.textByStream.launcher_stdout, 'nd-pending');
    assert.equal(stats.characterCountByStream.launcher_stdout, 'first-second-pending'.length);
    assert.equal(stats.truncatedByStream.launcher_stdout, true);
    assert.equal(stats.textByStream.engine_stderr, '');
    assert.equal(stats.characterCountByStream.engine_stderr, 0);
    assert.equal(stats.truncatedByStream.engine_stderr, false);
  });
});

test('managed llama speculative tracker parses split cumulative stats', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();

  tracker.appendChunk('launcher_stderr', 'statistics ngram_mod: #gen tokens = 62');
  const before = tracker.captureSnapshot();
  assert.equal(before.latestSpeculativeGeneratedTokens, null);
  assert.equal(before.latestSpeculativeAcceptedTokens, null);

  tracker.appendChunk('launcher_stderr', '00, #acc tokens = 5841\n');
  const after = tracker.captureSnapshot();
  assert.equal(after.latestSpeculativeGeneratedTokens, 6200);
  assert.equal(after.latestSpeculativeAcceptedTokens, 5841);
});

test('managed llama speculative tracker computes cumulative delta from snapshot', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();

  tracker.appendChunk('launcher_stdout', 'statistics ngram_mod: #gen tokens = 6168, #acc tokens = 5837\n');
  const snapshot = tracker.captureSnapshot();
  tracker.appendChunk('engine_stderr', 'statistics ngram_mod: #gen tokens = 6426, #acc tokens = 5895\n');

  assert.deepEqual(tracker.getDelta(snapshot), {
    speculativeAcceptedTokens: 58,
    speculativeGeneratedTokens: 258,
  });
});

test('managed llama speculative tracker ignores non-primary streams and rejects decreasing counters', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();

  tracker.appendChunk('startup_review', 'statistics ngram_mod: #gen tokens = 10, #acc tokens = 9\n');
  const ignored = tracker.captureSnapshot();
  assert.equal(ignored.stdoutOffset, 0);
  assert.equal(ignored.stderrOffset, 0);
  assert.equal(ignored.latestSpeculativeGeneratedTokens, null);

  tracker.appendChunk('engine_stdout', 'statistics ngram_mod: #gen tokens = 100, #acc tokens = 90\n');
  const snapshot = tracker.captureSnapshot();
  tracker.appendChunk('engine_stdout', 'statistics ngram_mod: #gen tokens = 80, #acc tokens = 70\n');

  assert.equal(tracker.getDelta(snapshot), null);
});

test('managed llama speculative tracker flushes persisted run metrics', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const database = getRuntimeDatabase();

    appendManagedLlamaSpeculativeMetricsChunk({
      runId: run.id,
      streamKind: 'launcher_stdout',
      chunkText: 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n',
    });

    assert.equal(flushManagedLlamaSpeculativeMetricsTracker(run.id), true);

    const row = asRow(database.prepare(`
      SELECT speculative_accepted_tokens, speculative_generated_tokens,
             stdout_character_count, stderr_character_count, metrics_updated_at_utc
      FROM inference_runs
      WHERE id = ?
    `).get(run.id));

    assert.equal(row.speculative_accepted_tokens, 40);
    assert.equal(row.speculative_generated_tokens, 42);
    assert.equal(row.stdout_character_count, 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n'.length);
    assert.equal(row.stderr_character_count, 0);
    assert.match(String(row.metrics_updated_at_utc || ''), /^\d{4}-\d{2}-\d{2}T/u);
  });
});

test('releaseModelRequest queues buffered managed llama logs for the active host run', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const database = getRuntimeDatabase();

    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'during-request\n' });
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: run.id,
      streamKind: 'launcher_stdout',
      chunkText: 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n',
    });

    const flushQueue = new ManagedLlamaFlushQueue();
    const released = releaseModelRequest(mockReleaseCtx({
      activeModelRequest: {
        token: 'token-1',
        kind: 'dashboard_chat_stream',
        startedAtUtc: new Date().toISOString(),
      },
      modelRequestQueue: [],
      managedLlamaLastStartupLogs: {
        runId: run.id,
        purpose: 'startup',
        scriptPath: 'fake-launcher.cmd',
        baseUrl: 'http://127.0.0.1:8080',
      },
      managedLlamaFlushQueue: flushQueue,
    }), 'token-1');
    try {
      assert.equal(released, true);
      assert.equal(flushQueue.getSnapshot().pendingCount, 1);
      await flushQueue.waitForIdle(1000);

      const row = asRow(database.prepare(`
        SELECT COUNT(*) AS count
        FROM inference_run_log_chunks
        WHERE run_id = ?
      `).get(run.id));
      assert.equal(Number(row.count || 0), 1);

      const persistedText = readInferenceRunLogTextByStream(run.id);
      assert.equal(persistedText.launcher_stdout, 'during-request\n');

      const metricsRow = asRow(database.prepare(`
        SELECT speculative_accepted_tokens, speculative_generated_tokens
        FROM inference_runs
        WHERE id = ?
      `).get(run.id));
      assert.equal(metricsRow.speculative_accepted_tokens, 40);
      assert.equal(metricsRow.speculative_generated_tokens, 42);
    } finally {
      await flushQueue.close();
    }
  });
});

test('releaseModelRequest releases the active request when managed llama log flush is database locked', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const database = getRuntimeDatabase();
    database.pragma('busy_timeout = 1');
    bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'locked-write\n' });

    const blocker = new Database(getRuntimeDatabasePath());
    blocker.pragma('busy_timeout = 1');
    blocker.exec('BEGIN IMMEDIATE');
    const flushQueue = new ManagedLlamaFlushQueue();
    const ctx = mockReleaseCtx({
      activeModelRequest: {
        token: 'token-locked',
        kind: 'repo_search',
        startedAtUtc: new Date().toISOString(),
      },
      modelRequestQueue: [],
      managedLlamaLastStartupLogs: {
        runId: run.id,
        purpose: 'startup',
        scriptPath: 'fake-launcher.cmd',
        baseUrl: 'http://127.0.0.1:8080',
      },
      managedLlamaFlushQueue: flushQueue,
    });

    try {
      try {
        const released = releaseModelRequest(ctx, 'token-locked');

        assert.equal(released, true);
        assert.equal(ctx.activeModelRequest, null);
        assert.equal(flushQueue.getSnapshot().pendingCount, 1);
      } finally {
        blocker.exec('ROLLBACK');
        blocker.close();
      }
      await flushQueue.waitForIdle(1000);
    } finally {
      await flushQueue.close();
    }
  });
});

test('deleteInferenceRunLogChunksOlderThan prunes old non-running chunks only', async () => {
  await withTestEnvAndServer(async () => {
    const database = getRuntimeDatabase();
    const oldStopped = createInferenceRun({ id: 'old-stopped-run', backend: 'llama', purpose: 'startup', status: 'stopped' });
    const oldFailed = createInferenceRun({ id: 'old-failed-run', backend: 'llama', purpose: 'startup', status: 'failed' });
    const oldRunning = createInferenceRun({ id: 'old-running-run', backend: 'llama', purpose: 'startup', status: 'running' });
    const oldReady = createInferenceRun({ id: 'old-ready-run', backend: 'llama', purpose: 'startup', status: 'ready' });
    const recentStopped = createInferenceRun({ id: 'recent-stopped-run', backend: 'llama', purpose: 'startup', status: 'stopped' });
    const oldUtc = '2026-04-20T00:00:00.000Z';
    const recentUtc = '2026-04-27T00:00:00.000Z';
    const cutoffUtc = '2026-04-25T00:00:00.000Z';

    const insertChunk = database.prepare(`
      INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
      VALUES (?, 'launcher_stdout', 0, 'chunk', ?)
    `);
    insertChunk.run(oldStopped.id, oldUtc);
    insertChunk.run(oldFailed.id, oldUtc);
    insertChunk.run(oldRunning.id, oldUtc);
    insertChunk.run(oldReady.id, oldUtc);
    insertChunk.run(recentStopped.id, recentUtc);

    assert.equal(deleteInferenceRunLogChunksOlderThan({ olderThanUtc: cutoffUtc }), 3);

    const remainingChunks = asRows(database.prepare(`
      SELECT run_id
      FROM inference_run_log_chunks
      ORDER BY run_id ASC
    `).all());
    assert.deepEqual(remainingChunks.map((row) => row.run_id), [
      oldRunning.id,
      recentStopped.id,
    ]);

    const runCount = asRow(database.prepare('SELECT COUNT(*) AS count FROM inference_runs').get());
    assert.equal(Number(runCount.count || 0), 5);
  });
});

test('managed llama log chunk retention uses created-at index', async () => {
  await withTestEnvAndServer(async () => {
    const database = getRuntimeDatabase();
    const indexes = asRows(database.prepare("PRAGMA index_list('inference_run_log_chunks')").all());
    assert.equal(
      indexes.some((row) => row.name === 'idx_inference_run_log_chunks_created_at'),
      true,
    );

    const planRows = asRows(database.prepare(`
      EXPLAIN QUERY PLAN
      DELETE FROM inference_run_log_chunks
      WHERE created_at_utc < ?
        AND run_id NOT IN (
          SELECT id
          FROM inference_runs
          WHERE status = 'running'
        )
    `).all('2026-04-25T00:00:00.000Z'));
    assert.equal(
      planRows.some((row) => String(row.detail || '').includes('idx_inference_run_log_chunks_created_at')),
      true,
    );
  });
});

test('getManagedLlamaSpeculativeMetricsSince reads speculative totals from persisted startup script logs', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: 'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6\n',
    });
    flushInferenceRunLogChunks(run.id);
    const cursor = getManagedLlamaLogCursor(logRef);

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: 'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6\n',
    });
    flushInferenceRunLogChunks(run.id);

    const parsed = getManagedLlamaSpeculativeMetricsSince(logRef, cursor);

    assert.deepEqual(parsed, {
      speculativeAcceptedTokens: 12,
      speculativeGeneratedTokens: 18,
    });
  });
});

test('getManagedLlamaSpeculativeMetricsSince sums multiple speculative batches without double-counting paired rate lines', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    const cursor = getManagedLlamaLogCursor(logRef);

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: [
        'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6',
        'llama_decode: draft acceptance rate = 66.67% (12 / 18)',
        'llama_decode: statistics ngram_map_k: #draft tokens = 10, #gen tokens = 8, #acc tokens = 5, #res tokens = 3',
        'llama_decode: draft acceptance rate = 62.50% (5 / 8)',
      ].join('\n') + '\n',
    });

    const parsed = getManagedLlamaSpeculativeMetricsSince(logRef, cursor);

    assert.deepEqual(parsed, {
      speculativeAcceptedTokens: 17,
      speculativeGeneratedTokens: 26,
    });
  });
});

test('getManagedLlamaSpeculativeMetricsDelta subtracts the baseline from cumulative speculative totals', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: [
        'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6',
        'llama_decode: draft acceptance rate = 66.67% (12 / 18)',
      ].join('\n') + '\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: [
        'llama_decode: statistics ngram_map_k: #draft tokens = 33, #gen tokens = 30, #acc tokens = 20, #res tokens = 10',
        'llama_decode: draft acceptance rate = 66.67% (20 / 30)',
      ].join('\n') + '\n',
    });

    assert.deepEqual(getManagedLlamaSpeculativeMetricsDelta(logRef, snapshot), {
      speculativeAcceptedTokens: 8,
      speculativeGeneratedTokens: 12,
    });
  });
});

test('getManagedLlamaSpeculativeMetricsDelta handles checkpointed speculative logs without llama_decode prefix', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: [
        'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
      ].join('\n') + '\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stderr',
      chunkText: [
        'draft acceptance rate = 1.00000 (   47 accepted /    47 generated)',
        'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
        'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
      ].join('\n') + '\n',
    });

    assert.deepEqual(getManagedLlamaSpeculativeMetricsDelta(logRef, snapshot), {
      speculativeAcceptedTokens: 58,
      speculativeGeneratedTokens: 258,
    });
  });
});

test('getManagedLlamaSpeculativeMetricsDelta combines startup and llama streams for checkpointed totals', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'llama', purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'launcher_stdout',
      chunkText: 'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'engine_stderr',
      chunkText: [
        'draft acceptance rate = 1.00000 (   47 accepted /    47 generated)',
        'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
        'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
      ].join('\n') + '\n',
    });

    assert.deepEqual(getManagedLlamaSpeculativeMetricsDelta(logRef, snapshot), {
      speculativeAcceptedTokens: 58,
      speculativeGeneratedTokens: 258,
    });
  });
});
