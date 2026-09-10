import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../src/state/chat-journal.js';
import type { ChatJournalEnvelope } from '../src/state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import type { RuntimeDatabase } from '../src/state/database-handle.js';
import { makeProcessor } from './helpers/tool-action-processor.js';
import type { AgentLoopToolAction } from '../src/agent-loop/types.js';
import type { ApprovalRequester } from '../src/repo-search/engine/approval-gate.js';
import type {
  ChatRunEvidenceRecorder,
  ChatToolResultEvidence,
} from '../src/repo-search/engine/chat-run-evidence.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const SESSION_ID = 'recorder-session';
const OWNER_EPOCH = 'owner-a:1';
const AT = '2026-09-10T11:04:54.755Z';

const SETTINGS = {
  operationKind: 'repo-agent',
  mode: 'repo-search',
  modelPresetId: 'preset-a',
  model: 'model-a',
  repoRoot: 'C:/repo',
  approval: 'interactive',
  maxTurns: 120,
  thinkingEnabled: true,
  webSearchEnabled: false,
  contextWindowTokens: 4096,
} as const;

function openSessionDatabase(prefix: string): { database: RuntimeDatabase; databasePath: string } {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID,
    title: 'Recorder session',
    modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent',
    mode: 'repo-search',
    planRepoRoot: 'C:/repo',
    createdAtUtc: AT,
    updatedAtUtc: AT,
    messages: [],
  });
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  return { database: getRuntimeDatabase(databasePath), databasePath };
}

function beginRecorder(databasePath: string, operationId = randomUUID()): ChatRunRecorder {
  return ChatRunRecorder.begin(databasePath, {
    operationId,
    sessionId: SESSION_ID,
    ownerEpoch: OWNER_EPOCH,
    operationKind: 'repo-agent',
    userMessageId: 'user-1',
    content: 'delete the dead physics module',
    images: [],
    imageMeta: [],
    settings: SETTINGS,
    retainedHistoryRevision: 0,
    startedAtUtc: AT,
  });
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

function readAll(database: RuntimeDatabase, operationId: string): ChatJournalEnvelope[] {
  return new ChatJournalStore(database).readAfter(operationId, 0, 500);
}

test('a run records its submission, engine binding and tool lifecycle in committed order', () => {
  const { databasePath } = openSessionDatabase('chat-run-recorder-lifecycle-');
  const recorder = beginRecorder(databasePath);

  recorder.bindEngine({ requestId: 'request-1', repoAgentSessionId: 'agent-1' });
  recorder.recordContextInitialized({
    messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'delete it' }],
    contextRevision: 0,
    turnBoundary: 1,
  });
  recorder.recordToolProposed({
    call: call(0, 'call_a'),
    toolName: 'run',
    arguments: { command: 'rg -n foo' },
    command: 'rg -n foo',
    activityKind: 'command',
    activitySubject: { kind: 'none' },
    maxTurns: 120,
    promptTokenCount: 100,
    executionState: 'proposed',
  });
  recorder.recordToolStarted({ call: call(0, 'call_a'), startedAtUtc: AT });
  recorder.recordToolResult({
    call: call(0, 'call_a'),
    executionState: 'completed',
    exitCode: 0,
    output: 'three matches',
    images: [],
    imageMeta: [],
    outputTokens: 4,
    outputTokensEstimated: true,
    promptTokenCount: 100,
    finishedAtUtc: AT,
  });
  recorder.recordToolResultFinalized({
    call: call(0, 'call_a'),
    modelVisibleText: 'three matches\n\nbudget notice',
    contextRevision: 1,
  });

  const reopened = getRuntimeDatabase(databasePath);
  const events = readAll(reopened, recorder.operationId);
  assert.deepEqual(events.map((envelope) => envelope.event.kind), [
    'run_started',
    'engine_bound',
    'context_initialized',
    'tool_proposed',
    'tool_started',
    'tool_result',
    'tool_result_finalized',
  ]);
  assert.deepEqual(events.map((envelope) => envelope.sequence), [1, 2, 3, 4, 5, 6, 7]);
  const run = new ChatJournalStore(reopened).readRun(recorder.operationId);
  assert.equal(run?.requestId, 'request-1');
  assert.equal(run?.repoAgentSessionId, 'agent-1');
  assert.equal(run?.latestSequence, 7);
});

test('run_started carries the submission and the order the run holds in its session', () => {
  const { database, databasePath } = openSessionDatabase('chat-run-recorder-submission-');
  const first = beginRecorder(databasePath);
  new ChatJournalStore(database).finish({
    operationId: first.operationId,
    ownerEpoch: OWNER_EPOCH,
    terminalCause: 'completed',
    updatedAtUtc: AT,
  });
  const second = beginRecorder(databasePath);

  const [firstStart] = readAll(database, first.operationId);
  const [secondStart] = readAll(database, second.operationId);
  assert.equal(firstStart.event.kind, 'run_started');
  if (firstStart.event.kind !== 'run_started' || secondStart.event.kind !== 'run_started') return;
  assert.equal(firstStart.event.runOrder, 1);
  assert.equal(secondStart.event.runOrder, 2);
  assert.equal(firstStart.event.content, 'delete the dead physics module');
  assert.deepEqual(firstStart.event.settings, SETTINGS);
});

test('an engine binding is written once and never repointed at another request', () => {
  const { database, databasePath } = openSessionDatabase('chat-run-recorder-binding-');
  const recorder = beginRecorder(databasePath);

  recorder.bindEngine({ requestId: 'request-1', repoAgentSessionId: null });
  recorder.bindEngine({ requestId: 'request-1', repoAgentSessionId: null });
  assert.throws(
    () => recorder.bindEngine({ requestId: 'request-2', repoAgentSessionId: null }),
    /cannot be rebound/u,
  );
  assert.equal(readAll(database, recorder.operationId).filter(
    (envelope) => envelope.event.kind === 'engine_bound',
  ).length, 1);
});

test('a recorder fenced out by a newer owner cannot commit further evidence', () => {
  const { database, databasePath } = openSessionDatabase('chat-run-recorder-fenced-');
  const recorder = beginRecorder(databasePath);
  database.prepare('UPDATE chat_runs SET owner_epoch = ? WHERE operation_id = ?')
    .run('owner-b:2', recorder.operationId);

  assert.throws(
    () => recorder.recordToolStarted({ call: call(0, 'call_a'), startedAtUtc: AT }),
    /fenced out/u,
  );
  assert.equal(readAll(database, recorder.operationId).length, 1);
});

/** Watches the recorder boundary and reports whether the command's side effect exists yet. */
class OrderSpy implements ChatRunEvidenceRecorder {
  readonly steps: string[] = [];
  readonly results: ChatToolResultEvidence[] = [];

  constructor(private readonly sideEffectPath: string, private readonly failAt: string | null = null) {}

  private note(step: string): void {
    this.steps.push(`${step}:${fs.existsSync(this.sideEffectPath) ? 'after' : 'before'}`);
    if (step === this.failAt) throw new Error(`journal is unavailable at ${step}`);
  }

  recordContextInitialized(): void {
    this.note('context_initialized');
  }

  recordContextSpliced(): void {
    this.note('context_spliced');
  }

  recordToolProposed(): void {
    this.note('tool_proposed');
  }

  recordToolStarted(): void {
    this.note('tool_started');
  }

  recordToolResult(evidence: ChatToolResultEvidence): void {
    this.results.push(evidence);
    this.note('tool_result');
  }

  recordToolResultFinalized(): void {
    this.note('tool_result_finalized');
  }
}

function writeAction(callId: string, relativePath: string): AgentLoopToolAction {
  return { kind: 'tool', callId, toolName: 'write', args: { path: relativePath, content: 'hello' } };
}

test('a tool call commits its proposal and start before it runs, and its result before history', async () => {
  const root = createManagedTempDir('chat-run-recorder-order-');
  const sideEffect = path.join(root, 'made.txt');
  const spy = new OrderSpy(sideEffect);
  const { processor, commands } = makeProcessor(root, ['write'], 'repo-search', null, undefined, {
    evidenceRecorder: spy,
  });

  await processor.executeBatch(1, [writeAction('call_a', 'made.txt')], '', 0, false);

  assert.deepEqual(spy.steps, [
    'context_initialized:before',
    'tool_proposed:before',
    'tool_started:before',
    'tool_result:after',
    'tool_result_finalized:after',
    'context_spliced:after',
  ]);
  assert.equal(commands.length, 1);
  assert.equal(spy.results[0].executionState, 'completed');
  assert.equal(spy.results[0].exitCode, 0);
});

test('a start that cannot be committed leaves the command unrun', async () => {
  const root = createManagedTempDir('chat-run-recorder-start-fails-');
  const sideEffect = path.join(root, 'made.txt');
  const spy = new OrderSpy(sideEffect, 'tool_started');
  const { processor, commands, transcript } = makeProcessor(root, ['write'], 'repo-search', null, undefined, {
    evidenceRecorder: spy,
  });

  await assert.rejects(
    () => processor.executeBatch(1, [writeAction('call_a', 'made.txt')], '', 0, false),
    /journal is unavailable at tool_started/u,
  );
  assert.equal(fs.existsSync(sideEffect), false);
  assert.equal(commands.length, 0);
  assert.equal(transcript.getMessages().some((message) => message.tool_calls !== undefined), false);
});

test('a result that cannot be committed never reaches the planner history a next turn reads', async () => {
  const root = createManagedTempDir('chat-run-recorder-result-fails-');
  const sideEffect = path.join(root, 'made.txt');
  const spy = new OrderSpy(sideEffect, 'tool_result');
  const { processor, transcript } = makeProcessor(root, ['write'], 'repo-search', null, undefined, {
    evidenceRecorder: spy,
  });

  await assert.rejects(
    () => processor.executeBatch(1, [writeAction('call_a', 'made.txt')], '', 0, false),
    /journal is unavailable at tool_result/u,
  );
  assert.equal(fs.existsSync(sideEffect), true);
  assert.equal(transcript.getMessages().some((message) => message.tool_calls !== undefined), false);
});

test('a denied call is recorded as refused with no invented exit code and no start', async () => {
  const root = createManagedTempDir('chat-run-recorder-denied-');
  const spy = new OrderSpy(path.join(root, 'made.txt'));
  const denyingGate: ApprovalRequester = {
    request: () => Promise.resolve({ kind: 'deny', reason: 'not this one' }),
  };
  const { processor } = makeProcessor(root, ['write'], 'repo-search', denyingGate, undefined, {
    evidenceRecorder: spy,
  });

  await processor.executeBatch(1, [writeAction('call_a', 'made.txt')], '', 0, false);

  assert.equal(spy.steps.includes('tool_started:before'), false);
  assert.equal(spy.results.length, 1);
  assert.equal(spy.results[0].executionState, 'rejected');
  assert.equal(spy.results[0].exitCode, null);
  assert.equal(String(spy.results[0].output).includes('not this one'), true);
});

test('a run keeps recording after another runtime root evicts its cached database handle', () => {
  const first = openSessionDatabase('chat-run-recorder-evicted-a-');
  const recorder = beginRecorder(first.databasePath);

  // A second runtime root in the same process closes the first handle; the run must survive it.
  openSessionDatabase('chat-run-recorder-evicted-b-');

  recorder.bindEngine({ requestId: 'request-1', repoAgentSessionId: null });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });

  const reopened = getRuntimeDatabase(first.databasePath);
  const run = new ChatJournalStore(reopened).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'completed');
  assert.equal(run?.requestId, 'request-1');
});
