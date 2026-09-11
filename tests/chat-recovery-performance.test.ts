import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { z } from '../src/lib/zod.js';
import { ChatJournalStore, CHAT_JOURNAL_READ_PAGE_SIZE } from '../src/state/chat-journal.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { readChatRunMessages, saveChatSession } from '../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { ChatOperationSnapshotReader, pageChatOperationSnapshot } from '../src/status-server/chat-operation-snapshot.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const SESSION_ID = 'performance-session';
const OWNER_EPOCH = 'owner-perf:1';
const AT = '2026-09-10T11:04:54.755Z';
const MODEL_TURNS = 103;
const TOOL_RESULTS = 116;
const RESULT_BYTES = 80_000;
const TEXT_DELTA = 'Narrating the next step in some detail. ';

/** The shape of the incident: 103 model turns, 116 full tool outcomes, well over 8 MiB of display history. */
function recordSyntheticRun(databasePath: string): ChatRunRecorder {
  const recorder = ChatRunRecorder.begin(databasePath, {
    operationId: randomUUID(), sessionId: SESSION_ID, ownerEpoch: OWNER_EPOCH, operationKind: 'repo-agent',
    userMessageId: 'user-1', content: 'exercise the journal at incident scale', images: [], imageMeta: [],
    settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'preset-a', model: 'model-a',
      repoRoot: 'C:/repo', approval: 'off', maxTurns: 120, thinkingEnabled: false, webSearchEnabled: false, contextWindowTokens: 4096,
    },
    retainedHistoryRevision: 0, startedAtUtc: AT,
  });
  recorder.bindEngine({ requestId: 'request-perf', repoAgentSessionId: randomUUID() });
  const initial = [{ role: 'system' as const, content: 'SYSTEM' }, { role: 'user' as const, content: 'exercise the journal at incident scale', chatMessageId: 'user-1' }];
  recorder.recordContextInitialized({ messages: initial, contextRevision: 0, turnBoundary: 1 });
  let revision = 0;
  let contextLength = initial.length;
  let resultsRecorded = 0;
  for (let turn = 1; turn <= MODEL_TURNS; turn += 1) {
    // Live text arrives as coalesced deltas: each commit carries only the new fragment.
    for (let piece = 0; piece < 3; piece += 1) {
      recorder.recordDisplay({ kind: 'narration', delta: { turn, offset: piece * TEXT_DELTA.length, text: TEXT_DELTA } });
    }
    const callsThisTurn = turn % 8 === 0 || turn === MODEL_TURNS ? 2 : 1;
    const calls = Array.from({ length: callsThisTurn }, (_, index) => ({
      toolCallId: `call_${String(turn)}_${String(index)}`, displayToolCallId: `tc_${String(resultsRecorded + index)}`,
      batchId: `batch-${String(turn)}`, turn, indexInBatch: index,
    }));
    for (const call of calls) {
      recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: `rg -n needle-${call.toolCallId}` }, command: `rg -n needle-${call.toolCallId}`,
        activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 120, promptTokenCount: 1000 + turn, executionState: 'proposed' });
    }
    revision += 1;
    recorder.recordContextSpliced({ expectedRevision: revision - 1, contextRevision: revision, startIndex: contextLength, deleteCount: 0, turnBoundary: 1, reason: 'append',
      inserted: [{ role: 'assistant', content: '', tool_calls: calls.map(call => ({ id: call.toolCallId, type: 'function' as const, function: { name: 'run', arguments: JSON.stringify({ command: `rg -n needle-${call.toolCallId}` }) } })) }] });
    contextLength += 1;
    for (const call of calls) {
      const output = `${call.toolCallId}:${'x'.repeat(RESULT_BYTES)}`;
      recorder.recordToolStarted({ call, startedAtUtc: AT });
      recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output, images: [], imageMeta: [],
        outputTokens: RESULT_BYTES / 4, outputTokensEstimated: true, promptTokenCount: 1000 + turn, finishedAtUtc: AT });
      recorder.recordToolResultFinalized({ call, modelVisibleText: output, contextRevision: revision });
      revision += 1;
      recorder.recordContextSpliced({ expectedRevision: revision - 1, contextRevision: revision, startIndex: contextLength, deleteCount: 0, turnBoundary: 1, reason: 'append',
        inserted: [{ role: 'tool', tool_call_id: call.toolCallId, content: output }] });
      contextLength += 1;
      resultsRecorded += 1;
    }
  }
  assert.equal(resultsRecorded, TOOL_RESULTS);
  return recorder;
}

test('incident-scale journal: appends stay per-delta, reads are paged, and replay reproduces every full result', { timeout: 300_000 }, t => {
  const runtimeRoot = createManagedTempDir('chat-recovery-performance-');
  saveChatSession(runtimeRoot, {
    id: SESSION_ID, title: 'Performance', modelPresetId: 'preset-a', modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: AT, updatedAtUtc: AT, messages: [],
  });
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  const rssBefore = process.memoryUsage().rss;
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
  assert.equal(textEvents.length, MODEL_TURNS * 3);
  const deltaOnly = z.object({ event: z.object({ delta: z.object({ text: z.literal(TEXT_DELTA) }) }) });
  assert.equal(textEvents.every(row => deltaOnly.safeParse(JSON.parse(row.body_json)).success), true);
  const resultCount = z.object({ n: z.number() }).parse(database.prepare(
    "SELECT count(*) AS n FROM chat_run_events WHERE operation_id = ? AND kind = 'tool_result'",
  ).get(recorder.operationId)).n;
  assert.equal(resultCount, TOOL_RESULTS);

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
  const history = buildRecoveredChatHistory(database, SESSION_ID);
  const replayMs = Number(process.hrtime.bigint() - replayStart) / 1e6;
  assert.equal(rebuilt.status, 'ok');
  assert.equal(rebuilt.toolCount, TOOL_RESULTS);
  // Interrupted mid-answer: the partial narration is folded back once; no batch is reopened.
  assert.equal(history.status, 'recovery_needed');
  assert.equal(history.interruptionNotices.length, 1);
  assert.match(history.interruptionNotices[0] ?? '', /partial narration/u);
  const rows = readChatRunMessages(database, SESSION_ID, recorder.operationId);
  const toolRows = rows.filter(message => message.kind === 'assistant_tool_call');
  assert.equal(toolRows.length, TOOL_RESULTS);
  assert.equal(toolRows.every(row => (row.toolCallOutput?.length ?? 0) > RESULT_BYTES), true);
  const toolContext = history.messages.filter(message => message.role === 'tool');
  assert.equal(toolContext.length, TOOL_RESULTS);
  assert.equal(toolContext.every(message => typeof message.content === 'string' && message.content.length > RESULT_BYTES), true);
  // Narration that precedes a tool start in its turn is displayed as progress, one row per turn.
  assert.equal(rows.filter(message => message.kind === 'assistant_progress').length, MODEL_TURNS);

  // Attach snapshots are paged and bounded; a page never carries the whole transcript.
  const snapshot = new ChatOperationSnapshotReader(recorder.operationId).capture(database, { approval: null, controlOperationId: null });
  const pages = [...pageChatOperationSnapshot(snapshot)];
  assert.ok(pages.length > 1);
  assert.equal(pages.every(page => page.messages.length <= 100), true);
  assert.equal(pages.reduce((total, page) => total + page.messages.length, 0), snapshot.messages.length);
  assert.equal(pages.at(-1)?.complete, true);

  const rssAfter = process.memoryUsage().rss;
  t.diagnostic(`append_ms=${appendMs.toFixed(0)} replay_ms=${replayMs.toFixed(0)} rows=${String(stats.rows)} bytes=${String(stats.bytes)} rss_delta_mib=${((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)} pages=${String(pages.length)}`);
});
