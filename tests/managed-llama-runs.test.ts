import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import {
  bufferManagedLlamaLogChunk,
  createManagedLlamaRun,
  deleteManagedLlamaLogChunksOlderThan,
  flushManagedLlamaLogChunks,
  readManagedLlamaLogTextByStream,
  readManagedLlamaLogTextStatsByStream,
} from '../dist/state/managed-llama-runs.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../dist/state/runtime-db.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaLogCursor,
  getManagedLlamaSpeculativeMetricsDelta,
  getManagedLlamaSpeculativeMetricsSince,
} from '../dist/status-server/managed-llama.js';
import {
  appendManagedLlamaSpeculativeMetricsChunk,
  flushManagedLlamaSpeculativeMetricsTracker,
  ManagedLlamaSpeculativeMetricsTracker,
} from '../dist/status-server/managed-llama-speculative-tracker.js';
import { releaseModelRequest } from '../dist/status-server/server-ops.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('managed llama log chunks stay buffered until flushed', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();

    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'first\n' });
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'second\n' });

    const beforeFlush = database.prepare(`
      SELECT COUNT(*) AS count
      FROM managed_llama_log_chunks
      WHERE run_id = ?
    `).get(run.id) as { count?: number };
    assert.equal(Number(beforeFlush.count || 0), 0);

    const pendingText = readManagedLlamaLogTextByStream(run.id);
    assert.equal(pendingText.startup_script_stdout, 'first\nsecond\n');

    flushManagedLlamaLogChunks(run.id);

    const afterFlush = database.prepare(`
      SELECT COUNT(*) AS count
      FROM managed_llama_log_chunks
      WHERE run_id = ?
    `).get(run.id) as { count?: number };
    assert.equal(Number(afterFlush.count || 0), 1);

    const persistedText = readManagedLlamaLogTextByStream(run.id);
    assert.equal(persistedText.startup_script_stdout, 'first\nsecond\n');
  });
});

test('managed llama log stats cap returned text while preserving full character counts', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });

    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'first-' });
    flushManagedLlamaLogChunks(run.id);
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'second-pending' });

    const stats = readManagedLlamaLogTextStatsByStream(run.id, { maxCharactersPerStream: 10 });

    assert.equal(stats.textByStream.startup_script_stdout, 'nd-pending');
    assert.equal(stats.characterCountByStream.startup_script_stdout, 'first-second-pending'.length);
    assert.equal(stats.truncatedByStream.startup_script_stdout, true);
    assert.equal(stats.textByStream.llama_stderr, '');
    assert.equal(stats.characterCountByStream.llama_stderr, 0);
    assert.equal(stats.truncatedByStream.llama_stderr, false);
  });
});

test('managed llama speculative tracker parses split cumulative stats', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();

  tracker.appendChunk('startup_script_stderr', 'statistics ngram_mod: #gen tokens = 62');
  const before = tracker.captureSnapshot();
  assert.equal(before.latestSpeculativeGeneratedTokens, null);
  assert.equal(before.latestSpeculativeAcceptedTokens, null);

  tracker.appendChunk('startup_script_stderr', '00, #acc tokens = 5841\n');
  const after = tracker.captureSnapshot();
  assert.equal(after.latestSpeculativeGeneratedTokens, 6200);
  assert.equal(after.latestSpeculativeAcceptedTokens, 5841);
});

test('managed llama speculative tracker computes cumulative delta from snapshot', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();

  tracker.appendChunk('startup_script_stdout', 'statistics ngram_mod: #gen tokens = 6168, #acc tokens = 5837\n');
  const snapshot = tracker.captureSnapshot();
  tracker.appendChunk('llama_stderr', 'statistics ngram_mod: #gen tokens = 6426, #acc tokens = 5895\n');

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

  tracker.appendChunk('llama_stdout', 'statistics ngram_mod: #gen tokens = 100, #acc tokens = 90\n');
  const snapshot = tracker.captureSnapshot();
  tracker.appendChunk('llama_stdout', 'statistics ngram_mod: #gen tokens = 80, #acc tokens = 70\n');

  assert.equal(tracker.getDelta(snapshot), null);
});

test('managed llama speculative tracker flushes persisted run metrics', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();

    appendManagedLlamaSpeculativeMetricsChunk({
      runId: run.id,
      streamKind: 'startup_script_stdout',
      chunkText: 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n',
    });

    assert.equal(flushManagedLlamaSpeculativeMetricsTracker(run.id), true);

    const row = database.prepare(`
      SELECT speculative_accepted_tokens, speculative_generated_tokens,
             stdout_character_count, stderr_character_count, metrics_updated_at_utc
      FROM managed_llama_runs
      WHERE id = ?
    `).get(run.id) as {
      speculative_accepted_tokens?: number | null;
      speculative_generated_tokens?: number | null;
      stdout_character_count?: number;
      stderr_character_count?: number;
      metrics_updated_at_utc?: string | null;
    };

    assert.equal(row.speculative_accepted_tokens, 40);
    assert.equal(row.speculative_generated_tokens, 42);
    assert.equal(row.stdout_character_count, 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n'.length);
    assert.equal(row.stderr_character_count, 0);
    assert.match(String(row.metrics_updated_at_utc || ''), /^\d{4}-\d{2}-\d{2}T/u);
  });
});

test('releaseModelRequest queues buffered managed llama logs for the active host run', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();

    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'during-request\n' });
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: run.id,
      streamKind: 'startup_script_stdout',
      chunkText: 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n',
    });

    const flushQueue = new ManagedLlamaFlushQueue();
    const released = releaseModelRequest({
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
    } as unknown as Parameters<typeof releaseModelRequest>[0], 'token-1');
    try {
      assert.equal(released, true);
      assert.equal(flushQueue.getSnapshot().pendingCount, 1);
      await flushQueue.waitForIdle(1000);

      const row = database.prepare(`
        SELECT COUNT(*) AS count
        FROM managed_llama_log_chunks
        WHERE run_id = ?
      `).get(run.id) as { count?: number };
      assert.equal(Number(row.count || 0), 1);

      const persistedText = readManagedLlamaLogTextByStream(run.id);
      assert.equal(persistedText.startup_script_stdout, 'during-request\n');

      const metricsRow = database.prepare(`
        SELECT speculative_accepted_tokens, speculative_generated_tokens
        FROM managed_llama_runs
        WHERE id = ?
      `).get(run.id) as { speculative_accepted_tokens?: number | null; speculative_generated_tokens?: number | null };
      assert.equal(metricsRow.speculative_accepted_tokens, 40);
      assert.equal(metricsRow.speculative_generated_tokens, 42);
    } finally {
      await flushQueue.close();
    }
  });
});

test('releaseModelRequest releases the active request when managed llama log flush is database locked', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();
    database.pragma('busy_timeout = 1');
    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'locked-write\n' });

    const blocker = new Database(getRuntimeDatabasePath());
    blocker.pragma('busy_timeout = 1');
    blocker.exec('BEGIN IMMEDIATE');
    const flushQueue = new ManagedLlamaFlushQueue();
    const ctx = {
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
    } as unknown as Parameters<typeof releaseModelRequest>[0];

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

test('deleteManagedLlamaLogChunksOlderThan prunes old non-running chunks only', async () => {
  await withTestEnvAndServer(async () => {
    const database = getRuntimeDatabase();
    const oldStopped = createManagedLlamaRun({ id: 'old-stopped-run', purpose: 'startup', status: 'stopped' });
    const oldFailed = createManagedLlamaRun({ id: 'old-failed-run', purpose: 'startup', status: 'failed' });
    const oldRunning = createManagedLlamaRun({ id: 'old-running-run', purpose: 'startup', status: 'running' });
    const oldReady = createManagedLlamaRun({ id: 'old-ready-run', purpose: 'startup', status: 'ready' });
    const recentStopped = createManagedLlamaRun({ id: 'recent-stopped-run', purpose: 'startup', status: 'stopped' });
    const oldUtc = '2026-04-20T00:00:00.000Z';
    const recentUtc = '2026-04-27T00:00:00.000Z';
    const cutoffUtc = '2026-04-25T00:00:00.000Z';

    const insertChunk = database.prepare(`
      INSERT INTO managed_llama_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
      VALUES (?, 'startup_script_stdout', 0, 'chunk', ?)
    `);
    insertChunk.run(oldStopped.id, oldUtc);
    insertChunk.run(oldFailed.id, oldUtc);
    insertChunk.run(oldRunning.id, oldUtc);
    insertChunk.run(oldReady.id, oldUtc);
    insertChunk.run(recentStopped.id, recentUtc);

    assert.equal(deleteManagedLlamaLogChunksOlderThan({ olderThanUtc: cutoffUtc }), 3);

    const remainingChunks = database.prepare(`
      SELECT run_id
      FROM managed_llama_log_chunks
      ORDER BY run_id ASC
    `).all() as Array<{ run_id: string }>;
    assert.deepEqual(remainingChunks.map((row) => row.run_id), [
      oldRunning.id,
      recentStopped.id,
    ]);

    const runCount = database.prepare('SELECT COUNT(*) AS count FROM managed_llama_runs').get() as { count?: number };
    assert.equal(Number(runCount.count || 0), 5);
  });
});

test('getManagedLlamaSpeculativeMetricsSince reads speculative totals from persisted startup script logs', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
      chunkText: 'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6\n',
    });
    flushManagedLlamaLogChunks(run.id);
    const cursor = getManagedLlamaLogCursor(logRef);

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
      chunkText: 'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6\n',
    });
    flushManagedLlamaLogChunks(run.id);

    const parsed = getManagedLlamaSpeculativeMetricsSince(logRef, cursor);

    assert.deepEqual(parsed, {
      speculativeAcceptedTokens: 12,
      speculativeGeneratedTokens: 18,
    });
  });
});

test('getManagedLlamaSpeculativeMetricsSince sums multiple speculative batches without double-counting paired rate lines', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    const cursor = getManagedLlamaLogCursor(logRef);

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
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
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
      chunkText: [
        'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6',
        'llama_decode: draft acceptance rate = 66.67% (12 / 18)',
      ].join('\n') + '\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
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
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
      chunkText: [
        'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
      ].join('\n') + '\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stderr',
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
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const logRef = {
      runId: run.id,
      purpose: 'startup',
      scriptPath: 'fake-launcher.cmd',
      baseUrl: 'http://127.0.0.1:8080',
    };

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'startup_script_stdout',
      chunkText: 'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);

    bufferManagedLlamaLogChunk({
      runId: run.id,
      streamKind: 'llama_stderr',
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
