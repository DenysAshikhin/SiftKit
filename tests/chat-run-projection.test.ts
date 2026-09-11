import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../src/state/chat-journal.js';
import type { ChatJournalEvent } from '../src/state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { readChatSessions, saveChatSession } from '../src/state/chat-sessions.js';
import { rebuildChatRun, reconcileChatRun } from '../src/status-server/chat-run-projection.js';
import type { RuntimeDatabase } from '../src/state/database-handle.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { ChatRecoveryInvariantError } from '../src/state/chat-journal.js';

const SESSION_ID = 'projection-session';
const OWNER_EPOCH = 'owner-a:1';
const AT = '2026-09-10T11:04:54.755Z';

test('a missing projection run fails with its actual operation identity and no fabricated session', () => {
  const { database } = openSession('chat-projection-missing-');
  const operationId = randomUUID();
  assert.throws(() => reconcileChatRun(database, operationId), error => error instanceof ChatRecoveryInvariantError
    && error.code === 'missing_run' && error.operationId === operationId);
});

function openSession(prefix: string): { runtimeRoot: string; database: RuntimeDatabase } {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID,
    title: 'Projection session',
    modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent',
    mode: 'repo-search',
    planRepoRoot: 'C:/repo',
    createdAtUtc: AT,
    updatedAtUtc: AT,
    messages: [],
  });
  return { runtimeRoot, database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')) };
}

function call(indexInBatch: number, toolCallId: string) {
  return {
    toolCallId,
    displayToolCallId: `tc_${String(indexInBatch)}`,
    batchId: 'batch-1',
    turn: 1,
    indexInBatch,
  };
}

function runEvents(userMessageId = 'user-1'): ChatJournalEvent[] {
  return [
    {
      kind: 'run_started',
      sessionId: SESSION_ID,
      operationKind: 'repo-agent',
      runOrder: 1,
      userMessageId,
      content: 'find the physics module',
      images: [],
      imageMeta: [],
      settings: {
        operationKind: 'repo-agent',
        mode: 'repo-search',
        presetId: 'repo-agent',
        modelPresetId: 'preset-a',
        model: 'model-a',
        repoRoot: 'C:/repo',
        approval: 'interactive',
        maxTurns: 120,
        thinkingEnabled: true,
        webSearchEnabled: false,
        contextWindowTokens: 4096,
      },
      retainedHistoryRevision: 0,
    },
    { kind: 'display', event: { kind: 'narration', delta: { turn: 1, offset: 0, text: 'looking for it' } } },
    {
      kind: 'tool_proposed',
      call: call(0, 'call_a'),
      toolName: 'run',
      arguments: { command: 'rg -n physics' },
      command: 'rg -n physics',
      activityKind: 'command',
      activitySubject: { kind: 'file', value: 'research/physics.py' },
      maxTurns: 120,
      promptTokenCount: 120,
      executionState: 'proposed',
    },
    { kind: 'tool_started', call: call(0, 'call_a'), startedAtUtc: AT },
    {
      kind: 'tool_result',
      call: call(0, 'call_a'),
      executionState: 'completed',
      exitCode: 0,
      output: 'research/physics.py:1:import math\nresearch/physics.py:2:def step()',
      images: [],
      imageMeta: [],
      outputTokens: 12,
      outputTokensEstimated: true,
      promptTokenCount: 120,
      finishedAtUtc: AT,
    },
    { kind: 'display', event: { kind: 'answer', delta: { turn: 2, offset: 0, text: 'It lives in research/physics.py.' } } },
  ];
}

function interrupted(): ChatJournalEvent {
  return {
    kind: 'run_finished',
    terminalCause: 'server_restart',
    detail: null,
    usage: null,
    recoveryStatus: 'recovery_needed',
    finishedAtUtc: AT,
  };
}

function writeRun(database: RuntimeDatabase, events: readonly ChatJournalEvent[]): string {
  const store = new ChatJournalStore(database);
  const operationId = randomUUID();
  store.begin({
    operationId,
    sessionId: SESSION_ID,
    recordKind: 'execution',
    operationKind: 'repo-agent',
    ownerEpoch: OWNER_EPOCH,
    settings: null,
    provenance: null,
    createdAtUtc: AT,
  });
  events.forEach((event, index) => {
    store.append({
      operationId,
      ownerEpoch: OWNER_EPOCH,
      expectedSequence: index,
      eventId: `event-${String(index + 1)}`,
      occurredAtUtc: AT,
      event,
    });
  });
  return operationId;
}

function projectedMessages(runtimeRoot: string) {
  const session = readChatSessions(runtimeRoot).find((candidate) => candidate.id === SESSION_ID);
  assert.ok(session?.messages);
  return session.messages;
}

test('a run projects its committed evidence into display rows carrying complete tool output', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-basic-');
  const operationId = writeRun(database, runEvents());

  const report = reconcileChatRun(database, operationId);

  assert.equal(report.status, 'ok');
  assert.equal(report.changed, true);
  assert.equal(report.appliedSequence, 6);
  const messages = projectedMessages(runtimeRoot);
  assert.deepEqual(messages.map((message) => message.kind), [
    'user_text',
    'assistant_progress',
    'assistant_tool_call',
    'assistant_answer',
  ]);
  const tool = messages[2];
  assert.equal(tool.toolCallExecutionState, 'completed');
  assert.equal(tool.toolCallStatus, 'done');
  assert.equal(tool.toolCallOutput, 'research/physics.py:1:import math\nresearch/physics.py:2:def step()');
  assert.equal(messages[0].content, 'find the physics module');
  assert.equal(messages[3].content, 'It lives in research/physics.py.');
});

test('late display frames cannot erase a finalized full tool result or regress its state', () => {
  const { runtimeRoot, database } = openSession('chat-projection-late-preview-');
  const operationId = writeRun(database, [
    ...runEvents(),
    { kind: 'tool_result_finalized', call: call(0, 'call_a'), modelVisibleText: 'complete finalized output', contextRevision: 1 },
    { kind: 'display', event: { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 'tc_0', turn: 1, maxTurns: 120, command: 'rg -n physics',
      activityKind: 'command', activitySubject: { kind: 'file', value: 'research/physics.py' }, promptTokenCount: 120,
    } } },
    { kind: 'display', event: { kind: 'tool', tool: {
      kind: 'tool_result', toolCallId: 'tc_0', turn: 1, maxTurns: 120, command: 'rg -n physics',
      activityKind: 'command', activitySubject: { kind: 'file', value: 'research/physics.py' }, promptTokenCount: 120,
      exitCode: 0, outputSnippet: 'short preview', outputTokens: 12, outputTokensEstimated: true,
    } } },
  ]);
  reconcileChatRun(database, operationId);
  const tool = projectedMessages(runtimeRoot).find(message => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallOutput, 'complete finalized output');
  assert.equal(tool?.toolCallExecutionState, 'completed');
  assert.equal(tool?.toolCallOutputSnippet, 'short preview');
});

test('reconciling an already projected run changes nothing', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-idempotent-');
  const operationId = writeRun(database, runEvents());
  reconcileChatRun(database, operationId);
  const first = projectedMessages(runtimeRoot);

  const second = reconcileChatRun(database, operationId);

  assert.equal(second.changed, false);
  assert.deepEqual(projectedMessages(runtimeRoot), first);
});

test('reconciliation repairs altered rows even when their sequence checkpoint survived', () => {
  const { runtimeRoot, database } = openSession('chat-projection-integrity-');
  const operationId = writeRun(database, runEvents());
  reconcileChatRun(database, operationId);
  const expected = projectedMessages(runtimeRoot);
  database.prepare("UPDATE chat_messages SET tool_call_output='preview only' WHERE source_run_id=? AND kind='assistant_tool_call'").run(operationId);
  reconcileChatRun(database, operationId);
  assert.deepEqual(projectedMessages(runtimeRoot), expected);
});

test('a rebuild after the projection rows are destroyed reproduces the fault-free rows', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-rebuild-');
  const operationId = writeRun(database, runEvents());
  reconcileChatRun(database, operationId);
  const uninterrupted = projectedMessages(runtimeRoot);
  database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(SESSION_ID);

  const report = rebuildChatRun(database, operationId);

  assert.equal(report.status, 'ok');
  assert.deepEqual(projectedMessages(runtimeRoot), uninterrupted);
  assert.equal(rebuildChatRun(database, operationId).changed, false);
});

test('a tool interrupted after it started projects as uncertain and reads as stopped', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-uncertain-');
  const operationId = writeRun(database, [...runEvents().slice(0, 4), interrupted()]);

  const report = reconcileChatRun(database, operationId);

  assert.equal(report.status, 'recovery_needed');
  const tool = projectedMessages(runtimeRoot).find((message) => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallExecutionState, 'uncertain');
  assert.equal(tool?.toolCallStatus, 'stopped');
  assert.equal(tool?.toolCallExitCode, null);
});

test('a tool that never started projects as not started, which is not the same as uncertain', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-not-started-');
  const operationId = writeRun(database, [...runEvents().slice(0, 3), interrupted()]);

  reconcileChatRun(database, operationId);

  const tool = projectedMessages(runtimeRoot).find((message) => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallExecutionState, 'not_started');
  assert.equal(tool?.toolCallStatus, 'stopped');
});

test('projecting a run leaves rows that belong to other runs alone', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-scoped-');
  const first = writeRun(database, runEvents());
  reconcileChatRun(database, first);
  new ChatJournalStore(database).finish({
    operationId: first,
    ownerEpoch: OWNER_EPOCH,
    terminalCause: 'completed',
    updatedAtUtc: AT,
  });
  const second = writeRun(database, runEvents('user-2'));

  reconcileChatRun(database, second);

  const messages = projectedMessages(runtimeRoot);
  assert.equal(messages.filter((message) => message.kind === 'user_text').length, 2);
  assert.equal(messages.filter((message) => message.kind === 'assistant_answer').length, 2);
  assert.deepEqual(
    messages.map((message) => message.sourceRunId),
    [first, first, first, first, second, second, second, second],
  );
  rebuildChatRun(database, first);
  assert.deepEqual(projectedMessages(runtimeRoot).map(message => message.id), messages.map(message => message.id));
});

test('incremental projection does not rewrite unrelated or unchanged rows', () => {
  const { database } = openSession('chat-projection-incremental-');
  const operationId = writeRun(database, runEvents());
  reconcileChatRun(database, operationId);
  database.exec(`CREATE TRIGGER keep_submission BEFORE DELETE ON chat_messages WHEN OLD.kind = 'user_text'
    BEGIN SELECT RAISE(ABORT, 'unchanged submission was rewritten'); END;`);
  new ChatJournalStore(database).append({
    operationId, ownerEpoch: OWNER_EPOCH, expectedSequence: 6, eventId: 'later-answer', occurredAtUtc: AT,
    event: { kind: 'display', event: { kind: 'answer', delta: { turn: 2, offset: 30, text: ' More.' } } },
  });
  assert.equal(reconcileChatRun(database, operationId).status, 'ok');
});

test('a terminal run projects exactly one answer row and its recorded outcome', () => {
  const { runtimeRoot, database } = openSession('chat-run-projection-terminal-');
  const operationId = writeRun(database, [
    ...runEvents(),
    {
      kind: 'run_finished',
      terminalCause: 'completed',
      detail: null,
      usage: null,
      recoveryStatus: 'ok',
      finishedAtUtc: AT,
    },
  ]);

  const report = reconcileChatRun(database, operationId);

  assert.equal(report.terminalCause, 'completed');
  assert.equal(projectedMessages(runtimeRoot).filter((message) => message.kind === 'assistant_answer').length, 1);
});

test('final answer metadata updates the streamed answer without duplicating it', () => {
  const { database, runtimeRoot } = openSession('chat-answer-finalization-');
  const operationId = writeRun(database, [
    ...runEvents(),
    { kind: 'display', event: { kind: 'answer_completed', answer: {
      content: 'Final answer.', outputTokensEstimate: 123, outputTokensEstimated: false, requestDurationMs: 250,
    } } },
  ]);
  assert.equal(reconcileChatRun(database, operationId).status, 'ok');
  const answers = projectedMessages(runtimeRoot).filter(message => message.kind === 'assistant_answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.content, 'Final answer.');
  assert.equal(answers[0]?.outputTokensEstimate, 123);
  assert.equal(answers[0]?.requestDurationMs, 250);
});
