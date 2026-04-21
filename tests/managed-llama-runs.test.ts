import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bufferManagedLlamaLogChunk,
  createManagedLlamaRun,
  flushManagedLlamaLogChunks,
  readManagedLlamaLogTextByStream,
} from '../dist/state/managed-llama-runs.js';
import { getRuntimeDatabase } from '../dist/state/runtime-db.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaLogCursor,
  getManagedLlamaSpeculativeMetricsDelta,
  getManagedLlamaSpeculativeMetricsSince,
} from '../dist/status-server/managed-llama.js';
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

test('releaseModelRequest flushes buffered managed llama logs for the active host run', async () => {
  await withTestEnvAndServer(async () => {
    const run = createManagedLlamaRun({ purpose: 'startup' });
    const database = getRuntimeDatabase();

    bufferManagedLlamaLogChunk({ runId: run.id, streamKind: 'startup_script_stdout', chunkText: 'during-request\n' });

    const released = releaseModelRequest({
      activeModelRequest: {
        token: 'token-1',
        kind: 'dashboard_chat_stream',
        startedAtUtc: new Date().toISOString(),
      },
      managedLlamaLastStartupLogs: {
        runId: run.id,
        purpose: 'startup',
        scriptPath: 'fake-launcher.cmd',
        baseUrl: 'http://127.0.0.1:8080',
      },
    } as unknown as Parameters<typeof releaseModelRequest>[0], 'token-1');
    assert.equal(released, true);

    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM managed_llama_log_chunks
      WHERE run_id = ?
    `).get(run.id) as { count?: number };
    assert.equal(Number(row.count || 0), 1);

    const persistedText = readManagedLlamaLogTextByStream(run.id);
    assert.equal(persistedText.startup_script_stdout, 'during-request\n');
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
      chunkText: 'llama_decode: draft acceptance rate = 66.67% (12 / 18)\n',
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
