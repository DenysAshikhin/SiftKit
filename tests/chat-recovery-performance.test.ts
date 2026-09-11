import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { z } from '../src/lib/zod.js';
import { ChatJournalStore, CHAT_JOURNAL_READ_PAGE_SIZE } from '../src/state/chat-journal.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { readChatRunMessages, saveChatSession } from '../src/state/chat-sessions.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { ChatOperationSnapshotReader } from '../src/status-server/chat-operation-snapshot.js';
import { createChatSnapshotRecords, encodeChatProjectionRecords } from '../src/status-server/chat-projection-encoder.js';
import { chatProjectionWireBytes, decodeChatProjectionFrames } from './helpers/chat-projection-decoder.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';
import {
  ChatReplayMemoryConfigSchema, PERFORMANCE_AT, PERFORMANCE_MODEL_TURNS, PERFORMANCE_RESULT_BYTES, PERFORMANCE_SESSION_ID,
  PERFORMANCE_TEXT_DELTA, PERFORMANCE_TOOL_RESULTS, REPLAY_MEMORY_CHILD_ENV, performanceDatabasePath,
  recordSyntheticRun, runChatReplayMemoryProcess, spawnChatReplayMemoryProcess,
} from './helpers/chat-replay-memory-process.js';

/** Peak RSS growth a clean process may show while replaying the ~28 MB incident fixture. */
const REPLAY_RSS_BUDGET_BYTES = 192 * 1024 * 1024;
const MIB = 1024 * 1024;

const childConfig = process.env[REPLAY_MEMORY_CHILD_ENV];
if (childConfig !== undefined) {
  runChatReplayMemoryProcess(ChatReplayMemoryConfigSchema.parse(JSON.parse(childConfig)));
} else {

test('incident-scale journal: appends stay per-delta, reads are paged, and replay reproduces every full result', { timeout: 300_000 }, t => {
  const runtimeRoot = createManagedTempDir('chat-recovery-performance-');
  saveChatSession(runtimeRoot, {
    id: PERFORMANCE_SESSION_ID, title: 'Performance', modelPresetId: 'preset-a', modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: PERFORMANCE_AT, updatedAtUtc: PERFORMANCE_AT, messages: [],
  });
  const databasePath = performanceDatabasePath(runtimeRoot);
  const database = getRuntimeDatabase(databasePath);
  const appendStart = process.hrtime.bigint();
  const recorder = recordSyntheticRun(databasePath);
  const appendMs = Number(process.hrtime.bigint() - appendStart) / 1e6;
  recorder.finish({ terminalCause: 'approval_timeout', detail: 'No approval decision was received.', usage: null, recoveryStatus: 'recovery_needed' });

  const store = new ChatJournalStore(database);
  const run = store.readRun(recorder.operationId);
  assert.ok(run);
  const stats = z.object({ rows: z.number(), bytes: z.number() }).parse(database.prepare(
    'SELECT count(*) AS rows, COALESCE(sum(length(body_json)), 0) AS bytes FROM chat_run_events WHERE operation_id = ?',
  ).get(recorder.operationId));
  assert.equal(stats.rows, run.latestSequence);
  assert.ok(stats.bytes > 8 * 1024 * 1024, `journal must exceed 8 MiB, got ${String(stats.bytes)}`);

  // No per-token rewrites: every narration event carries exactly one delta, never the accumulated text.
  const textEvents = z.array(z.object({ body_json: z.string() })).parse(database.prepare(
    "SELECT body_json FROM chat_run_events WHERE operation_id = ? AND kind = 'display' AND json_extract(body_json, '$.event.kind') = 'narration'",
  ).all(recorder.operationId));
  assert.equal(textEvents.length, PERFORMANCE_MODEL_TURNS * 3);
  const deltaOnly = z.object({ event: z.object({ delta: z.object({ text: z.literal(PERFORMANCE_TEXT_DELTA) }) }) });
  assert.equal(textEvents.every(row => deltaOnly.safeParse(JSON.parse(row.body_json)).success), true);
  const resultCount = z.object({ n: z.number() }).parse(database.prepare(
    "SELECT count(*) AS n FROM chat_run_events WHERE operation_id = ? AND kind = 'tool_result'",
  ).get(recorder.operationId)).n;
  assert.equal(resultCount, PERFORMANCE_TOOL_RESULTS);

  // Paged reads: one page never exceeds the read page size, and the pages cover the run exactly once.
  assert.ok(run.latestSequence > CHAT_JOURNAL_READ_PAGE_SIZE);
  assert.equal(store.readAfter(recorder.operationId, 0, CHAT_JOURNAL_READ_PAGE_SIZE).length, CHAT_JOURNAL_READ_PAGE_SIZE);
  let cursor = 0;
  let paged = 0;
  for (const envelope of store.readAll(recorder.operationId)) {
    assert.equal(envelope.sequence, cursor + 1);
    cursor = envelope.sequence;
    paged += 1;
  }
  assert.equal(paged, run.latestSequence);
  const plan = z.array(z.object({ detail: z.string() })).parse(database.prepare(
    'EXPLAIN QUERY PLAN SELECT * FROM chat_run_events WHERE operation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
  ).all(recorder.operationId, 0, 10));
  assert.equal(plan.some(row => /USING (INDEX|PRIMARY KEY)/u.test(row.detail) && !/SCAN/u.test(row.detail)), true, JSON.stringify(plan));

  // Rebuild and context replay reproduce all 116 full results without executing anything.
  const replayStart = process.hrtime.bigint();
  const rebuilt = rebuildChatRun(database, recorder.operationId);
  const history = buildRecoveredChatHistory(database, PERFORMANCE_SESSION_ID);
  const replayMs = Number(process.hrtime.bigint() - replayStart) / 1e6;
  assert.equal(rebuilt.status, 'ok');
  assert.equal(rebuilt.toolCount, PERFORMANCE_TOOL_RESULTS);
  // Interrupted mid-answer: the partial narration is folded back once; no batch is reopened.
  assert.equal(history.status, 'recovery_needed');
  assert.equal(history.interruptionNotices.length, 1);
  assert.match(history.interruptionNotices[0] ?? '', /partial narration/u);
  const rows = readChatRunMessages(database, PERFORMANCE_SESSION_ID, recorder.operationId);
  const toolRows = rows.filter(message => message.kind === 'assistant_tool_call');
  assert.equal(toolRows.length, PERFORMANCE_TOOL_RESULTS);
  assert.equal(toolRows.every(row => (row.toolCallOutput?.length ?? 0) > PERFORMANCE_RESULT_BYTES), true);
  const toolContext = history.messages.filter(message => message.role === 'tool');
  assert.equal(toolContext.length, PERFORMANCE_TOOL_RESULTS);
  assert.equal(toolContext.every(message => typeof message.content === 'string' && message.content.length > PERFORMANCE_RESULT_BYTES), true);
  // Narration that precedes a tool start in its turn is displayed as progress, one row per turn.
  assert.equal(rows.filter(message => message.kind === 'assistant_progress').length, PERFORMANCE_MODEL_TURNS);

  // Attach transfers are bounded frames; no frame carries the whole transcript, and nothing is lost.
  const capture = new ChatOperationSnapshotReader(recorder.operationId).capture(database, { approval: null, controlOperationId: null, activeOperation: null });
  const transferId = '4f9c1f9a-1111-4000-8000-000000000001';
  const frames = [...encodeChatProjectionRecords(createChatSnapshotRecords(capture), transferId)];
  assert.ok(frames.length > 1);
  chatProjectionWireBytes(frames);
  const records = decodeChatProjectionFrames(frames, transferId);
  assert.equal(records.filter(record => record.kind === 'message').length, capture.snapshot.messages.length);

  t.diagnostic(`append_ms=${appendMs.toFixed(0)} replay_ms=${replayMs.toFixed(0)} rows=${String(stats.rows)} bytes=${String(stats.bytes)} frames=${String(frames.length)}`);
});

test('incident-scale replay stays within its memory budget in a clean process', { timeout: 300_000 }, t => {
  const runtimeRoot = createManagedTempDir('chat-replay-memory-');
  const entrypoint = fileURLToPath(import.meta.url);
  const generated = spawnChatReplayMemoryProcess(entrypoint, { mode: 'generate', runtimeRoot });
  assert.equal(generated.mode, 'generate');
  assert.ok(generated.journalBytes > 8 * MIB, `journal must exceed 8 MiB, got ${String(generated.journalBytes)}`);

  const replayed = spawnChatReplayMemoryProcess(entrypoint, { mode: 'replay', runtimeRoot, operationId: generated.operationId });
  assert.equal(replayed.mode, 'replay');
  assert.equal(replayed.toolResults, PERFORMANCE_TOOL_RESULTS);
  assert.equal(replayed.historyStatus, 'recovery_needed');
  assert.ok(replayed.snapshotMessages > PERFORMANCE_TOOL_RESULTS);
  const sampledDelta = replayed.rssPeakBytes - replayed.rssBaselineBytes;
  const peakDelta = replayed.maxRssAfterBytes - replayed.maxRssBeforeBytes;
  t.diagnostic(`node=${replayed.nodeVersion} journal_mib=${(replayed.journalBytes / MIB).toFixed(1)}`
    + ` retained_context_mib=${(replayed.retainedContextBytes / MIB).toFixed(1)} retained_rows_mib=${(replayed.retainedRowBytes / MIB).toFixed(1)}`
    + ` rss_baseline_mib=${(replayed.rssBaselineBytes / MIB).toFixed(1)} rss_peak_mib=${(replayed.rssPeakBytes / MIB).toFixed(1)}`
    + ` max_rss_before_mib=${(replayed.maxRssBeforeBytes / MIB).toFixed(1)} max_rss_after_mib=${(replayed.maxRssAfterBytes / MIB).toFixed(1)}`
    + ` sampled_delta_mib=${(sampledDelta / MIB).toFixed(1)} peak_delta_mib=${(peakDelta / MIB).toFixed(1)}`
    + replayed.rssAfterStepBytes.map(([step, rss]) => ` rss_after_${step}_mib=${(rss / MIB).toFixed(1)}`).join(''));
  assert.ok(Math.max(sampledDelta, peakDelta) <= REPLAY_RSS_BUDGET_BYTES,
    `replay grew RSS by ${(Math.max(sampledDelta, peakDelta) / MIB).toFixed(1)} MiB, over the ${String(REPLAY_RSS_BUDGET_BYTES / MIB)} MiB budget`);
});

}
