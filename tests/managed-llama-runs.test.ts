import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bufferManagedLlamaLogChunk,
  createManagedLlamaRun,
  flushManagedLlamaLogChunks,
  readManagedLlamaLogTextByStream,
} from '../dist/state/managed-llama-runs.js';
import { getRuntimeDatabase } from '../dist/state/runtime-db.js';
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
