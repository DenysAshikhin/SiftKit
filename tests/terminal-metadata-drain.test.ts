import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from '../src/config/index.js';
import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { getRuntimeRoot } from '../src/status-server/paths.js';
import { clearIdleSummaryTimer } from '../src/status-server/server-ops.js';
import { parseStatusMetadata } from '../src/status-server/status-file.js';
import {
  enqueueTerminalMetadata,
  flushTerminalMetadataForShutdown,
  scheduleDeferredTerminalMetadata,
  waitForTerminalMetadataIdle,
} from '../src/status-server/terminal-metadata.js';
import { bufferInferenceRunLogChunk, createInferenceRun, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';

test('terminal metadata idle waits for direct deferred jobs before releasing their runtime', async t => {
  const runtime = new IsolatedRuntime();
  runtime.start();
  const configPath = getConfigPath();
  writeConfig(configPath, getDefaultServerConfig());
  const ctx = { ...createTestServerContext(configPath, getRuntimeRoot()), metricsPath: getRuntimeDatabasePath() };
  t.after(async () => {
    await delay(50);
    clearIdleSummaryTimer(ctx);
    await ctx.inferenceRunFlushQueue.close();
    await runtime.close();
  });
  const now = new Date().toISOString();
  scheduleDeferredTerminalMetadata(ctx, {
    requestId: 'deferred-completion', metadata: parseStatusMetadata(JSON.stringify({
      requestId: 'deferred-completion', running: false, terminalState: 'completed', taskKind: 'chat', outputTokens: 7,
    })), startedAtUtc: now, finishedAtUtc: now, elapsedMs: 1, totalElapsedMs: 1,
    requestCompleted: true, suppressLogLine: true,
  });
  await waitForTerminalMetadataIdle(ctx, 1000);
  assert.equal(ctx.metrics.completedRequestCount, 1);
  assert.equal(ctx.metrics.outputTokensTotal, 7);
});

/** A context whose normal drains would wait far longer than any shutdown budget. */
function createDeferredContext(t: TestContext, idleDelayMs: number): { ctx: ServerContext; runtime: IsolatedRuntime } {
  const runtime = new IsolatedRuntime();
  runtime.start();
  const configPath = getConfigPath();
  writeConfig(configPath, getDefaultServerConfig());
  const base = createTestServerContext(configPath, getRuntimeRoot());
  const nowMs = Date.now();
  const ctx: ServerContext = {
    ...base,
    metricsPath: getRuntimeDatabasePath(),
    inferenceRunFlushQueue: new InferenceRunFlushQueue({ idleDelayMs }),
    terminalMetadata: { ...base.terminalMetadata, idleDelayMs, serverStartedAtMs: nowMs, lastModelRequestFinishedAtMs: nowMs },
  };
  t.after(async () => {
    clearIdleSummaryTimer(ctx);
    await ctx.inferenceRunFlushQueue.close();
    await runtime.close();
  });
  return { ctx, runtime };
}

function completionBody(requestId: string): string {
  return JSON.stringify({ requestId, running: false, terminalState: 'completed', taskKind: 'summary', outputTokens: 7, inputTokens: 3 });
}

/** Committed chunk rows only; the text reader also folds in chunks still buffered in memory. */
function countLogRows(ctx: ServerContext, runId: string): number {
  const row = JsonRecordReader.asObject(ctx.runtimeDatabase.prepare('SELECT COUNT(*) AS count FROM inference_run_log_chunks WHERE run_id = ?').get(runId));
  return Number(row?.count);
}

function countRunLogs(ctx: ServerContext, requestId: string): number {
  const row = JsonRecordReader.asObject(ctx.runtimeDatabase.prepare('SELECT COUNT(*) AS count FROM run_logs WHERE request_id = ?').get(requestId));
  return Number(row?.count);
}

// Shutdown must not race a 10s idle delay against a 10s wait: pending metadata is processed now.
test('shutdown flush persists queued metadata whose idle delay exceeds the shutdown budget', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  enqueueTerminalMetadata(ctx, { requestId: 'shutdown-completion', terminalState: 'completed', bodyText: completionBody('shutdown-completion'), capturedAtMs: Date.now() });
  await delay(50);
  assert.equal(countRunLogs(ctx, 'shutdown-completion'), 0, 'the normal drain is still deferred');

  await flushTerminalMetadataForShutdown(ctx, 1000);

  assert.equal(countRunLogs(ctx, 'shutdown-completion'), 1);
  assert.equal(ctx.metrics.outputTokensTotal, 7);
  assert.equal(ctx.terminalMetadata.drainScheduled, false);
  // Repeating the flush is safe and writes nothing further.
  await flushTerminalMetadataForShutdown(ctx, 1000);
  assert.equal(countRunLogs(ctx, 'shutdown-completion'), 1);
});

test('shutdown drains pending inference logs, then metadata that was waiting on them', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
  bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'late log\n' });
  assert.equal(ctx.inferenceRunFlushQueue.enqueue(run.id, 'exl3'), true);
  enqueueTerminalMetadata(ctx, { requestId: 'shutdown-with-logs', terminalState: 'completed', bodyText: completionBody('shutdown-with-logs'), capturedAtMs: Date.now() });
  await delay(50);
  assert.equal(countLogRows(ctx, run.id), 0, 'the log batch is still deferred');
  assert.equal(countRunLogs(ctx, 'shutdown-with-logs'), 0);

  await ctx.inferenceRunFlushQueue.drainForShutdown(2000);
  assert.equal(countLogRows(ctx, run.id), 1);
  assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'late log\n');
  assert.equal(ctx.inferenceRunFlushQueue.isIdle(), true);
  await ctx.inferenceRunFlushQueue.drainForShutdown(2000);
  assert.equal(countLogRows(ctx, run.id), 1, 'a repeated shutdown drain writes nothing further');

  await flushTerminalMetadataForShutdown(ctx, 1000);
  assert.equal(countRunLogs(ctx, 'shutdown-with-logs'), 1);
});

// A batch that cannot be written stays a failure: shutdown reports it instead of dropping it.
test('shutdown drain of inference logs propagates a persistent flush failure within its budget', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
  ctx.runtimeDatabase.exec(`CREATE TRIGGER reject_logs BEFORE INSERT ON inference_run_log_chunks
    BEGIN SELECT RAISE(ABORT, 'log write refused'); END;`);
  bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'refused\n' });
  assert.equal(ctx.inferenceRunFlushQueue.enqueue(run.id, 'exl3'), true);

  await assert.rejects(() => ctx.inferenceRunFlushQueue.drainForShutdown(600), /Timed out waiting for inference run flush queue idle/u);
  assert.ok(ctx.inferenceRunFlushQueue.getSnapshot().failedCount >= 1);
  ctx.runtimeDatabase.exec('DROP TRIGGER reject_logs');
});
