import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { join } from 'node:path';

import { z } from '../../src/lib/zod.js';
import { ChatJournalStore } from '../../src/state/chat-journal.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { readChatRunMessages, saveChatSession } from '../../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../../src/status-server/chat-run-recorder.js';
import { rebuildChatRun } from '../../src/status-server/chat-run-projection.js';
import { buildRecoveredChatHistory } from '../../src/status-server/chat-context-replay.js';
import { ChatOperationSnapshotReader } from '../../src/status-server/chat-operation-snapshot.js';
import { mockModelPreset } from './mock-config.js';

export const REPLAY_MEMORY_CHILD_ENV = 'SIFTKIT_TEST_CHAT_REPLAY_MEMORY_CHILD';
const RESULT_PREFIX = 'CHAT_REPLAY_MEMORY ';

export const PERFORMANCE_SESSION_ID = 'performance-session';
export const PERFORMANCE_OWNER_EPOCH = 'owner-perf:1';
export const PERFORMANCE_AT = '2026-09-10T11:04:54.755Z';
export const PERFORMANCE_MODEL_TURNS = 103;
export const PERFORMANCE_TOOL_RESULTS = 116;
export const PERFORMANCE_RESULT_BYTES = 80_000;
export const PERFORMANCE_TEXT_DELTA = 'Narrating the next step in some detail. ';

export const ChatReplayMemoryConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('generate'), runtimeRoot: z.string().min(1) }),
  z.strictObject({ mode: z.literal('replay'), runtimeRoot: z.string().min(1), operationId: z.string().uuid() }),
]);
type ReplayMemoryConfig = z.infer<typeof ChatReplayMemoryConfigSchema>;

export const ChatReplayMemoryResultSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('generate'), operationId: z.string().uuid(), journalBytes: z.number().int().nonnegative() }),
  z.strictObject({
    mode: z.literal('replay'), nodeVersion: z.string().min(1), journalBytes: z.number().int().nonnegative(),
    rssBaselineBytes: z.number().int().nonnegative(), rssPeakBytes: z.number().int().nonnegative(),
    rssAfterStepBytes: z.array(z.tuple([z.string().min(1), z.number().int().nonnegative()])),
    maxRssBeforeBytes: z.number().int().nonnegative(), maxRssAfterBytes: z.number().int().nonnegative(),
    retainedContextBytes: z.number().int().nonnegative(), retainedRowBytes: z.number().int().nonnegative(),
    toolResults: z.number().int().nonnegative(), historyStatus: z.string().min(1), snapshotMessages: z.number().int().nonnegative(),
  }),
]);
type ReplayMemoryResult = z.infer<typeof ChatReplayMemoryResultSchema>;

export function performanceDatabasePath(runtimeRoot: string): string {
  return join(runtimeRoot, 'runtime.sqlite');
}

/** The shape of the incident: 103 model turns, 116 full tool outcomes, well over 8 MiB of display history. */
export function recordSyntheticRun(databasePath: string): ChatRunRecorder {
  const recorder = ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
    operationId: randomUUID(), sessionId: PERFORMANCE_SESSION_ID, ownerEpoch: PERFORMANCE_OWNER_EPOCH, operationKind: 'repo-agent',
    userMessageId: 'user-1', content: 'exercise the journal at incident scale', images: [], imageMeta: [],
    settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'preset-a', model: 'model-a',
      repoRoot: 'C:/repo', approval: 'off', maxTurns: 120, thinkingEnabled: false, webSearchEnabled: false, contextWindowTokens: 4096,
    },
    retainedHistoryRevision: 0, startedAtUtc: PERFORMANCE_AT,
  });
  recorder.bindEngine({ requestId: 'request-perf', repoAgentSessionId: randomUUID() });
  const initial = [{ role: 'system' as const, content: 'SYSTEM' }, { role: 'user' as const, content: 'exercise the journal at incident scale', chatMessageId: 'user-1' }];
  recorder.recordContextInitialized({ messages: initial, contextRevision: 0, turnBoundary: 1 });
  let revision = 0;
  let contextLength = initial.length;
  let resultsRecorded = 0;
  for (let turn = 1; turn <= PERFORMANCE_MODEL_TURNS; turn += 1) {
    // Live text arrives as coalesced deltas: each commit carries only the new fragment.
    for (let piece = 0; piece < 3; piece += 1) {
      recorder.recordDisplay({ kind: 'narration', delta: { turn, offset: piece * PERFORMANCE_TEXT_DELTA.length, text: PERFORMANCE_TEXT_DELTA } });
    }
    const callsThisTurn = turn % 8 === 0 || turn === PERFORMANCE_MODEL_TURNS ? 2 : 1;
    const calls = Array.from({ length: callsThisTurn }, (_, index) => ({
      toolCallId: `call_${String(turn)}_${String(index)}`, displayToolCallId: `tc_${String(resultsRecorded + index)}`,
      batchId: `batch-${String(turn)}`, turn, indexInBatch: index,
    }));
    for (const call of calls) {
      recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: `rg -n needle-${call.toolCallId}` }, command: `rg -n needle-${call.toolCallId}`,
        activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 120, promptTokenCount: 1000 + turn, executionState: 'proposed' });
    }
    revision += 1;
    recorder.recordContextSpliced({ expectedRevision: revision - 1, contextRevision: revision, startIndex: contextLength, deleteCount: 0, turnBoundary: 1, reason: 'append', coalescedToolCallIds: [],
      inserted: [{ role: 'assistant', content: '', tool_calls: calls.map(call => ({ id: call.toolCallId, type: 'function' as const, function: { name: 'run', arguments: JSON.stringify({ command: `rg -n needle-${call.toolCallId}` }) } })) }] });
    contextLength += 1;
    for (const call of calls) {
      const output = `${call.toolCallId}:${'x'.repeat(PERFORMANCE_RESULT_BYTES)}`;
      recorder.recordToolStarted({ call, startedAtUtc: PERFORMANCE_AT });
      recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output, images: [], imageMeta: [],
        outputTokens: PERFORMANCE_RESULT_BYTES / 4, outputTokensEstimated: true, promptTokenCount: 1000 + turn, finishedAtUtc: PERFORMANCE_AT });
      recorder.recordToolResultFinalized({ call, modelVisibleText: output, contextRevision: revision });
      revision += 1;
      recorder.recordContextSpliced({ expectedRevision: revision - 1, contextRevision: revision, startIndex: contextLength, deleteCount: 0, turnBoundary: 1, reason: 'append', coalescedToolCallIds: [],
        inserted: [{ role: 'tool', tool_call_id: call.toolCallId, content: output }] });
      contextLength += 1;
      resultsRecorded += 1;
    }
  }
  assert.equal(resultsRecorded, PERFORMANCE_TOOL_RESULTS);
  return recorder;
}

function journalBytes(databasePath: string, operationId: string): number {
  return z.object({ bytes: z.number() }).parse(getRuntimeDatabase(databasePath).prepare(
    'SELECT COALESCE(sum(length(body_json)), 0) AS bytes FROM chat_run_events WHERE operation_id = ?',
  ).get(operationId)).bytes;
}

/** Child body: generation and replay run in separate processes so neither inflates the other's RSS. */
export function runChatReplayMemoryProcess(config: ReplayMemoryConfig): void {
  const databasePath = performanceDatabasePath(config.runtimeRoot);
  let result: ReplayMemoryResult;
  if (config.mode === 'generate') {
    saveChatSession(config.runtimeRoot, {
      id: PERFORMANCE_SESSION_ID, title: 'Performance', modelPresetId: 'preset-a', modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: PERFORMANCE_AT, updatedAtUtc: PERFORMANCE_AT, messages: [],
    });
    const recorder = recordSyntheticRun(databasePath);
    recorder.finish({ terminalCause: 'approval_timeout', detail: 'No approval decision was received.', usage: null, recoveryStatus: 'recovery_needed' });
    result = { mode: 'generate', operationId: recorder.operationId, journalBytes: journalBytes(databasePath, recorder.operationId) };
  } else {
    const database = getRuntimeDatabase(databasePath);
    const bytes = journalBytes(databasePath, config.operationId);
    assert.ok(new ChatJournalStore(database).readRun(config.operationId));
    const rssBaselineBytes = process.memoryUsage().rss;
    const maxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
    let rssPeakBytes = rssBaselineBytes;
    const rssAfterStepBytes: [string, number][] = [];
    const sample = (step: string): void => {
      const rss = process.memoryUsage().rss;
      rssPeakBytes = Math.max(rssPeakBytes, rss);
      rssAfterStepBytes.push([step, rss]);
    };
    const rebuilt = rebuildChatRun(database, config.operationId);
    sample('rebuild');
    const history = buildRecoveredChatHistory(database, PERFORMANCE_SESSION_ID);
    sample('history');
    const snapshot = new ChatOperationSnapshotReader(config.operationId).capture(database, { approval: null, controlOperationId: null, activeOperation: null }).snapshot;
    sample('snapshot');
    const rows = readChatRunMessages(database, PERFORMANCE_SESSION_ID, config.operationId);
    sample('rows');
    result = {
      mode: 'replay', nodeVersion: process.version, journalBytes: bytes, rssBaselineBytes, rssPeakBytes, rssAfterStepBytes,
      maxRssBeforeBytes, maxRssAfterBytes: process.resourceUsage().maxRSS * 1024,
      retainedContextBytes: JSON.stringify(history.messages).length, retainedRowBytes: JSON.stringify(rows).length,
      toolResults: rebuilt.toolCount, historyStatus: history.status, snapshotMessages: snapshot.messages.length,
    };
  }
  closeAllRuntimeDatabases();
  writeSync(1, `${RESULT_PREFIX}${JSON.stringify(ChatReplayMemoryResultSchema.parse(result))}\n`);
}

/** Runs one child to completion and returns its published result. */
export function spawnChatReplayMemoryProcess(entrypoint: string, config: ReplayMemoryConfig): ReplayMemoryResult {
  const child = spawnSync(process.execPath, [entrypoint], {
    cwd: config.runtimeRoot, windowsHide: true, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, [REPLAY_MEMORY_CHILD_ENV]: JSON.stringify(ChatReplayMemoryConfigSchema.parse(config)) },
  });
  assert.equal(child.status, 0, `${config.mode} child failed: ${child.stderr.slice(-4000)}`);
  const line = child.stdout.split('\n').map(text => text.trim()).find(text => text.startsWith(RESULT_PREFIX));
  assert.ok(line, `${config.mode} child published no result: ${child.stdout.slice(-4000)}`);
  return ChatReplayMemoryResultSchema.parse(JSON.parse(line.slice(RESULT_PREFIX.length)));
}
