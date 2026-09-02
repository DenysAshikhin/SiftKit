import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  deleteInferenceRunLogChunksOlderThan,
  flushInferenceRunLogChunks,
  getInferenceRunPendingLogChunkStats,
  listInferenceRuns,
  readInferenceRun,
  readInferenceRunLogTextByStream,
  readInferenceRunLogTextStatsByStream,
} from '../src/state/inference-runs.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { OutputCapture } from './helpers/stdout-capture.js';

// SQLite .get()/.all() return `unknown`; narrow to JsonObject at the boundary.
function asRow<T>(value: T): JsonObject {
  return JsonRecordReader.asObject(value) ?? {};
}

function asRows<T>(values: readonly T[]): JsonObject[] {
  return values.map((value) => JsonRecordReader.asObject(value) ?? {});
}

test('inference runs are recorded with their backend and status', async () => {
  await withTestEnvAndServer(async () => {
    const startup = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
    const ready = createInferenceRun({ backend: 'exl3', purpose: 'startup', status: 'ready' });

    assert.equal(readInferenceRun(startup.id)?.backend, 'exl3');
    assert.equal(readInferenceRun(ready.id)?.status, 'ready');
    assert.equal(listInferenceRuns({ backend: 'exl3' }).length, 2);
    assert.equal(listInferenceRuns({ backend: 'exl3', status: 'ready' }).length, 1);
  });
});

test('inference run log chunks stay buffered until flushed', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
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

test('inference run pending log chunks emit peak size logs only after one-kilobyte stream deltas', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });

    const capture = OutputCapture.start(process.stdout);
    try {
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'a'.repeat(262_143) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'b' });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'c'.repeat(262_143) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'd' });
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    const peakLines = lines.filter((line) => line.includes(`inference_run pending_log_peak run_id=${run.id}`));
    assert.deepEqual(
      peakLines.map((line) => line.replace(/^.*inference_run/u, 'inference_run')),
      [
        `inference_run pending_log_peak run_id=${run.id} pending_chars=262144 stream=engine_stdout stream_chars=262144`,
        `inference_run pending_log_peak run_id=${run.id} pending_chars=524288 stream=engine_stdout stream_chars=524288`,
      ],
    );
  });
});

test('inference run log stats cap returned text while preserving full character counts', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });

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

test('deleteInferenceRunLogChunksOlderThan prunes old non-running chunks only', async () => {
  await withTestEnvAndServer(async () => {
    const database = getRuntimeDatabase();
    const oldStopped = createInferenceRun({ id: 'old-stopped-run', backend: 'exl3', purpose: 'startup', status: 'stopped' });
    const oldFailed = createInferenceRun({ id: 'old-failed-run', backend: 'exl3', purpose: 'startup', status: 'failed' });
    const oldRunning = createInferenceRun({ id: 'old-running-run', backend: 'exl3', purpose: 'startup', status: 'running' });
    const oldReady = createInferenceRun({ id: 'old-ready-run', backend: 'exl3', purpose: 'startup', status: 'ready' });
    const recentStopped = createInferenceRun({ id: 'recent-stopped-run', backend: 'exl3', purpose: 'startup', status: 'stopped' });
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

test('inference run log chunk retention uses created-at index', async () => {
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

test('pending log chunks accumulate with O(1) character accounting and flush intact', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({
      backend: 'exl3',
      purpose: 'pending-buffer-test',
      entrypointPath: null,
      baseUrl: null,
      status: 'running',
    });

    for (let index = 0; index < 500; index += 1) {
      bufferInferenceRunLogChunk({
        runId: run.id,
        streamKind: 'engine_stdout',
        chunkText: `line-${index}\n`,
      });
    }
    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'engine_stderr',
      chunkText: 'warn\n',
    });

    const stats = getInferenceRunPendingLogChunkStats(run.id);
    assert.equal(stats.streamCount, 2);
    assert.equal(stats.characterCountByStream.engine_stderr, 'warn\n'.length);
    assert.ok(stats.totalCharacters > 0);
    assert.equal(
      stats.characterCountByStream.engine_stdout + stats.characterCountByStream.engine_stderr,
      stats.totalCharacters,
    );

    flushInferenceRunLogChunks(run.id);

    const text = readInferenceRunLogTextByStream(run.id);
    assert.match(text.engine_stdout, /^line-0\n/u);
    assert.match(text.engine_stdout, /line-499\n$/u);
    assert.equal(text.engine_stderr, 'warn\n');

    const afterFlush = getInferenceRunPendingLogChunkStats(run.id);
    assert.equal(afterFlush.totalCharacters, 0);
    assert.equal(afterFlush.streamCount, 0);
  });
});
