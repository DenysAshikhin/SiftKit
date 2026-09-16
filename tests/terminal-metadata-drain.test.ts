import assert from 'node:assert/strict';
import test from 'node:test';
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
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';
import {
  completionBody,
  createDeferredContext,
  waitForCondition,
} from './helpers/deferred-shutdown-fixture.js';
import {
  countLogRows,
  countMetricsRows,
  countRunLogs,
  installRejectingTrigger,
  removeRejectingTrigger,
} from './helpers/runtime-database-probe.js';

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

// Shutdown must not race a 10s idle delay against a 10s wait: pending metadata is processed now.
test('shutdown flush persists queued metadata whose idle delay exceeds the shutdown budget', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  enqueueTerminalMetadata(ctx, { requestId: 'shutdown-completion', terminalState: 'completed', bodyText: completionBody('shutdown-completion'), capturedAtMs: Date.now() });
  await delay(50);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'shutdown-completion'), 0, 'the normal drain is still deferred');

  await flushTerminalMetadataForShutdown(ctx, 1000);

  assert.equal(countRunLogs(ctx.runtimeDatabase, 'shutdown-completion'), 1);
  assert.equal(ctx.metrics.outputTokensTotal, 7);
  assert.equal(ctx.terminalMetadata.drainScheduled, false);
  // Repeating the flush is safe and writes nothing further.
  await flushTerminalMetadataForShutdown(ctx, 1000);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'shutdown-completion'), 1);
});

test('shutdown drains pending inference logs, then metadata that was waiting on them', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
  bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'late log\n' });
  assert.equal(ctx.inferenceRunFlushQueue.enqueue(run.id, 'exl3'), true);
  enqueueTerminalMetadata(ctx, { requestId: 'shutdown-with-logs', terminalState: 'completed', bodyText: completionBody('shutdown-with-logs'), capturedAtMs: Date.now() });
  await delay(50);
  assert.equal(countLogRows(ctx.runtimeDatabase, run.id), 0, 'the log batch is still deferred');
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'shutdown-with-logs'), 0);

  await ctx.inferenceRunFlushQueue.drainForShutdown(2000);
  assert.equal(countLogRows(ctx.runtimeDatabase, run.id), 1);
  assert.equal(readInferenceRunLogTextByStream(run.id).launcher_stdout, 'late log\n');
  assert.equal(ctx.inferenceRunFlushQueue.isIdle(), true);
  await ctx.inferenceRunFlushQueue.drainForShutdown(2000);
  assert.equal(countLogRows(ctx.runtimeDatabase, run.id), 1, 'a repeated shutdown drain writes nothing further');

  await flushTerminalMetadataForShutdown(ctx, 1000);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'shutdown-with-logs'), 1);
});

// A batch that cannot be written stays a failure: shutdown reports it instead of dropping it.
test('shutdown drain of inference logs propagates a persistent flush failure within its budget', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup' });
  installRejectingTrigger(ctx.runtimeDatabase, 'inference_run_log_chunks', 'reject_logs', ['INSERT']);
  bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'launcher_stdout', chunkText: 'refused\n' });
  assert.equal(ctx.inferenceRunFlushQueue.enqueue(run.id, 'exl3'), true);

  await assert.rejects(() => ctx.inferenceRunFlushQueue.drainForShutdown(600), /Timed out waiting for inference run flush queue idle/u);
  assert.ok(ctx.inferenceRunFlushQueue.getSnapshot().failedCount >= 1);
  removeRejectingTrigger(ctx.runtimeDatabase, 'reject_logs', ['INSERT']);
});

// A rejected write at shutdown has no later retry, so it must reach the caller instead of being
// logged as a failure and then reported as a clean drain.
test('shutdown flush propagates a rejected terminal-metadata write', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  installRejectingTrigger(ctx.runtimeDatabase, 'run_logs', 'reject_run_logs', ['INSERT']);
  enqueueTerminalMetadata(ctx, { requestId: 'refused-completion', terminalState: 'completed', bodyText: completionBody('refused-completion'), capturedAtMs: Date.now() });
  await delay(50);

  await assert.rejects(() => flushTerminalMetadataForShutdown(ctx, 1000), /reject_run_logs/u);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'refused-completion'), 0);
  // The rejection still carries the SQLite reason, which is what the log line and the exit path
  // report; tests/status-server-shutdown-exit.test.ts checks the emitted lines end to end.
});

test('shutdown flush propagates a rejected write from a deferred direct job', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  installRejectingTrigger(ctx.runtimeDatabase, 'run_logs', 'reject_run_logs', ['INSERT']);
  const now = new Date().toISOString();
  scheduleDeferredTerminalMetadata(ctx, {
    requestId: 'refused-direct-job', metadata: parseStatusMetadata(completionBody('refused-direct-job')),
    startedAtUtc: now, finishedAtUtc: now, elapsedMs: 1, totalElapsedMs: 1,
    requestCompleted: true, suppressLogLine: true,
  });

  await assert.rejects(() => flushTerminalMetadataForShutdown(ctx, 1000), /reject_run_logs/u);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'refused-direct-job'), 0);
  assert.equal(ctx.terminalMetadata.pendingDirectJobs, 0, 'the failed job is still unregistered');
});

// A rejected totals write used to commit the run row, advance the in-memory aggregates, and then
// understate them forever. The two writes are one transaction now, and memory follows the commit.
test('a rejected metrics write rolls the run row back and leaves the in-memory totals untouched', async t => {
  const { ctx } = createDeferredContext(t, 60_000);
  installRejectingTrigger(ctx.runtimeDatabase, 'runtime_metrics_totals', 'reject_metrics');
  enqueueTerminalMetadata(ctx, { requestId: 'refused-totals', terminalState: 'completed', bodyText: completionBody('refused-totals'), capturedAtMs: Date.now() });
  await delay(50);

  await assert.rejects(() => flushTerminalMetadataForShutdown(ctx, 1000), /reject_metrics/u);
  assert.equal(ctx.metrics.outputTokensTotal, 0, 'memory must not advance past a write that never committed');
  assert.equal(ctx.metrics.completedRequestCount, 0);
  assert.equal(countMetricsRows(ctx.runtimeDatabase), 0, 'no totals row committed');
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'refused-totals'), 0, 'the run row rolled back with it');
});

// The deliberate swallow stays in the background drain, where a timer callback cannot propagate.
// It costs the item, so the loss is at least countable.
test('the background drain swallows a rejected write and counts the loss', async t => {
  const { ctx } = createDeferredContext(t, 0);
  installRejectingTrigger(ctx.runtimeDatabase, 'run_logs', 'reject_run_logs', ['INSERT']);
  enqueueTerminalMetadata(ctx, { requestId: 'drain-refused', terminalState: 'completed', bodyText: completionBody('drain-refused'), capturedAtMs: Date.now() });

  await waitForCondition(() => ctx.terminalMetadata.persistenceFailedCount === 1);
  await delay(50);
  assert.equal(countRunLogs(ctx.runtimeDatabase, 'drain-refused'), 0);
  assert.equal(ctx.metrics.completedRequestCount, 0, 'a lost item is not counted as completed');
  assert.equal(ctx.terminalMetadata.persistenceFailedCount, 1, 'counted once, not retried');
  assert.equal(ctx.terminalMetadata.drainScheduled, false, 'the lost item is not rescheduled');
});

// Consequence of the item being consumed before it persists: the duplicate guard rejects the only
// recovery path, so a write lost in the background is gone. Shutdown must not inherit that behaviour.
test('a write lost in the background drain cannot be recovered by re-posting the request', async t => {
  const { ctx } = createDeferredContext(t, 0);
  installRejectingTrigger(ctx.runtimeDatabase, 'run_logs', 'reject_run_logs', ['INSERT']);
  enqueueTerminalMetadata(ctx, { requestId: 'lost-then-reposted', terminalState: 'completed', bodyText: completionBody('lost-then-reposted'), capturedAtMs: Date.now() });
  await waitForCondition(() => ctx.terminalMetadata.persistenceFailedCount === 1);
  removeRejectingTrigger(ctx.runtimeDatabase, 'reject_run_logs', ['INSERT']);

  enqueueTerminalMetadata(ctx, { requestId: 'lost-then-reposted', terminalState: 'completed', bodyText: completionBody('lost-then-reposted'), capturedAtMs: Date.now() });
  await flushTerminalMetadataForShutdown(ctx, 1000);

  assert.equal(countRunLogs(ctx.runtimeDatabase, 'lost-then-reposted'), 0, 'the duplicate guard persists nothing');
  assert.equal(ctx.terminalMetadata.persistenceFailedCount, 1, 'the re-post is a duplicate, not a second failure');
});
