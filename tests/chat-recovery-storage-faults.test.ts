import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { z } from '../src/lib/zod.js';
import { getAbortError } from '../src/lib/abort.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import type { RuntimeDatabase } from '../src/state/database-handle.js';
import { readChatRunMessages, saveChatSession } from '../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const SESSION_ID = 'storage-fault-session';
const OWNER_EPOCH = 'owner-fault:1';
const AT = '2026-09-10T11:04:54.755Z';
const CALL = { toolCallId: 'call_a', displayToolCallId: 'tc_0', batchId: 'batch-1', turn: 1, indexInBatch: 0 };

function openSessionDatabase(prefix: string): { database: RuntimeDatabase; databasePath: string } {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID, title: 'Storage faults', modelPresetId: 'preset-a', modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: AT, updatedAtUtc: AT, messages: [],
  });
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  return { database: getRuntimeDatabase(databasePath), databasePath };
}

/** A run that has published text and proposed one command: the prefix a fault must not lose. */
function beginProposedRun(databasePath: string): ChatRunRecorder {
  const recorder = ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
    operationId: randomUUID(), sessionId: SESSION_ID, ownerEpoch: OWNER_EPOCH, operationKind: 'repo-agent',
    userMessageId: 'user-1', content: 'exercise storage faults', images: [], imageMeta: [],
    settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'preset-a', model: 'model-a',
      repoRoot: 'C:/repo', approval: 'interactive', maxTurns: 120, thinkingEnabled: false, webSearchEnabled: false, contextWindowTokens: 4096,
    },
    retainedHistoryRevision: 0, startedAtUtc: AT,
  });
  recorder.bindEngine({ requestId: 'request-fault', repoAgentSessionId: randomUUID() });
  recorder.recordContextInitialized({ messages: [{ role: 'user', content: 'exercise storage faults', chatMessageId: 'user-1' }], contextRevision: 0, turnBoundary: 0 });
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'Published before the fault. ' } });
  recorder.recordToolProposed({ call: CALL, toolName: 'run', arguments: { command: 'rm -rf build' }, command: 'rm -rf build',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 120, promptTokenCount: 10, executionState: 'proposed' });
  return recorder;
}

function committedKinds(database: RuntimeDatabase, operationId: string): string[] {
  return [...new ChatJournalStore(database).readAll(operationId)].map(envelope => envelope.event.kind);
}

function assertPrefixIntact(database: RuntimeDatabase, operationId: string, expectedKinds: readonly string[]): void {
  const run = new ChatJournalStore(database).readRun(operationId);
  assert.ok(run);
  assert.deepEqual(committedKinds(database, operationId), expectedKinds);
  assert.equal(run.latestSequence, expectedKinds.length);
  assert.equal(run.terminalCause, null);
}

test('SQLITE_BUSY on a tool start commits nothing, keeps the published prefix, and closes the run as a storage failure', () => {
  const { database, databasePath } = openSessionDatabase('chat-storage-busy-');
  const recorder = beginProposedRun(databasePath);
  const prefix = committedKinds(database, recorder.operationId);
  assert.deepEqual(prefix, ['run_started', 'engine_bound', 'context_initialized', 'display', 'tool_proposed']);

  // A second connection holds the write lock; the recorder must fail rather than wait forever.
  const blocker = new Database(databasePath, { timeout: 50 });
  blocker.exec('BEGIN IMMEDIATE');
  database.pragma('busy_timeout = 50');
  try {
    assert.throws(() => recorder.recordToolStarted({ call: CALL, startedAtUtc: AT }), { code: 'SQLITE_BUSY' });
    assertPrefixIntact(database, recorder.operationId, prefix);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    database.pragma('busy_timeout = 5000');
  }

  // Nothing was authorized while blocked: the proposal is still not started after rebuild.
  rebuildChatRun(database, recorder.operationId);
  const rows = readChatRunMessages(database, SESSION_ID, recorder.operationId);
  assert.equal(rows.find(message => message.kind === 'assistant_tool_call')?.toolCallExecutionState, 'proposed');
  assert.equal(rows.find(message => message.kind === 'assistant_progress')?.content, 'Published before the fault. ');

  assertStorageFailureIsFatal(database, recorder, prefix, 'SQLITE_BUSY');
});

/**
 * A failed commit is the run's storage failure wherever it surfaced: execution is fenced, a
 * further write is refused at the same head, and the terminal write names the storage cause.
 */
function assertStorageFailureIsFatal(database: RuntimeDatabase, recorder: ChatRunRecorder, prefix: readonly string[], code: string): void {
  assert.equal(recorder.abortSignal.aborted, true);
  assert.equal(z.object({ code: z.string() }).parse(getAbortError(recorder.abortSignal)).code, code);
  assert.throws(() => recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 28, text: 'after the fault' } }), { code });
  assertPrefixIntact(database, recorder.operationId, prefix);
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  const run = new ChatJournalStore(database).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'storage_failure');
  const finished = [...new ChatJournalStore(database).readAll(recorder.operationId)].at(-1)?.event;
  assert.equal(finished?.kind === 'run_finished' && finished.terminalCause, 'storage_failure');
}

test('SQLITE_FULL on a tool result commits nothing and closes the run as a storage failure', () => {
  const { database, databasePath } = openSessionDatabase('chat-storage-full-');
  const recorder = beginProposedRun(databasePath);
  recorder.recordToolStarted({ call: CALL, startedAtUtc: AT });
  const prefix = committedKinds(database, recorder.operationId);

  // Cap the file, never the disk: a result larger than the remaining pages must fail as SQLITE_FULL.
  const pageCount = z.number().int().positive().parse(database.pragma('page_count', { simple: true }));
  database.pragma(`max_page_count = ${String(pageCount + 2)}`);
  const output = 'x'.repeat(512 * 1024);
  const result = { call: CALL, executionState: 'completed' as const, exitCode: 0, output, images: [], imageMeta: [],
    outputTokens: 1000, outputTokensEstimated: true, promptTokenCount: 10, finishedAtUtc: AT };
  try {
    assert.throws(() => recorder.recordToolResult(result), { code: 'SQLITE_FULL' });
    assertPrefixIntact(database, recorder.operationId, prefix);
  } finally {
    database.pragma('max_page_count = 1073741823');
  }

  assertStorageFailureIsFatal(database, recorder, prefix, 'SQLITE_FULL');
  rebuildChatRun(database, recorder.operationId);
  const tool = readChatRunMessages(database, SESSION_ID, recorder.operationId).find(message => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallExecutionState, 'uncertain');
  assert.equal(tool?.toolCallOutput, null);
});
