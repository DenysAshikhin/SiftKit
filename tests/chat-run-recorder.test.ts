import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../src/state/chat-journal.js';
import type { ChatJournalEnvelope } from '../src/state/chat-journal-schema.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { reconcileChatRun } from '../src/status-server/chat-run-projection.js';
import { readChatRunMessages, saveChatSession } from '../src/state/chat-sessions.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import type { RuntimeDatabase } from '../src/state/database-handle.js';
import { makeProcessor } from './helpers/tool-action-processor.js';
import type { AgentLoopToolAction } from '../src/agent-loop/types.js';
import type { ApprovalRequester } from '../src/repo-search/engine/approval-gate.js';
import type {
  ChatRunEvidenceRecorder,
  ChatToolResultEvidence,
  ChatToolProposedEvidence,
} from '../src/repo-search/engine/chat-run-evidence.js';
import type { ChatContextInit, ChatContextSplice } from '../src/repo-search/planner-chat-message.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { ChatMessageQueueStore } from '../src/state/chat-message-queue.js';
import { TaskLoop } from '../src/repo-search/engine/task-loop.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';

const SESSION_ID = 'recorder-session';
const OWNER_EPOCH = 'owner-a:1';
const AT = '2026-09-10T11:04:54.755Z';

const SETTINGS = {
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
  return ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
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

for (const resumed of [false, true]) test(`late context initialization prevents submission cancellation (resumed=${resumed})`, () => {
  const { databasePath, database } = openSessionDatabase('chat-recorder-dispatched-');
  let recorder = beginRecorder(databasePath);
  database.transaction(() => {
    for (let index = 0; index < 501; index += 1) recorder.recordPresentation({ kind: 'warning', warning: 'status' });
  })();
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [] });
  if (resumed) recorder = ChatRunRecorder.resume(getRuntimeDatabase(databasePath), recorder.operationId, OWNER_EPOCH);
  assert.throws(() => recorder.cancelUndispatchedSubmission(), /Only an undispatched/u);
  assert.equal(recorder.terminalCause, null);
});

test('resuming a recorder restores narration and tool identities from committed evidence', () => {
  const { databasePath } = openSessionDatabase('chat-recorder-resume-identities-');
  const recorder = beginRecorder(databasePath);
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'looking' } });
  recorder.recordToolProposed({ call: call(0, 'native'), toolName: 'read', arguments: { path: 'file' }, command: 'read file',
    activityKind: 'read', activitySubject: { kind: 'file', value: 'file' }, maxTurns: 5, promptTokenCount: 0, executionState: 'proposed' });
  const resumed = ChatRunRecorder.resume(getRuntimeDatabase(databasePath), recorder.operationId, OWNER_EPOCH);
  assert.equal(resumed.resolveAssistantMessageId(1), recorder.resolveAssistantMessageId(1));
  assert.equal(resumed.resolveToolMessageId('native'), recorder.resolveToolMessageId('native'));
});

test('Stop preserves generated text and exposes its durable outcome separately after rebuild', () => {
  const { databasePath, database } = openSessionDatabase('chat-recorder-stop-outcome-');
  const recorder = beginRecorder(databasePath);
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial answer' } });
  const stopped = recorder.stop('user_stop', null);
  assert.equal(stopped.messages.find(message => message.kind === 'assistant_answer')?.content, 'partial answer');
  assert.equal(stopped.messages.at(-1)?.runTerminalCause, 'user_stop');
  database.prepare('DELETE FROM chat_messages WHERE session_id=?').run(SESSION_ID);
  const recovered = recorder.readSession();
  assert.equal(recovered.messages.find(message => message.kind === 'assistant_answer')?.content, 'partial answer');
  assert.equal(recovered.messages.at(-1)?.runTerminalCause, 'user_stop');
});

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

test('an asynchronous storage failure blocks later tool evidence while allowing its terminal outcome', () => {
  const { database, databasePath } = openSessionDatabase('chat-storage-abort-');
  const recorder = beginRecorder(databasePath);
  recorder.abortForStorageFailure(new Error('stream flush failed'));
  assert.throws(() => recorder.recordToolStarted({ call: call(0, 'call_a'), startedAtUtc: AT }), /stream flush failed/u);
  recorder.finish({ terminalCause: 'storage_failure', detail: 'stream flush failed', usage: null, recoveryStatus: 'recovery_needed' });
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, 'storage_failure');
  assert.equal(readAll(database, recorder.operationId).some(envelope => envelope.event.kind === 'tool_started'), false);
});

test('a storage abort reaches the model loop before it prepares another provider request', async () => {
  const { databasePath } = openSessionDatabase('chat-storage-loop-abort-');
  const recorder = beginRecorder(databasePath);
  const loop = new TaskLoop({ id: 'storage-abort', question: 'stop on failed storage' }, {
    ...createMockLoopDefaults('chat-storage-loop-'), evidenceRecorder: recorder,
    mockResponses: [{ content: 'must not be requested' }], mockCommandResults: {},
  });
  recorder.abortForStorageFailure(new Error('durable storage failed'));
  await assert.rejects(loop.prepareTurn(1), /durable storage failed/u);
});

test('approval resolution is durable once and conflicting decisions cannot overwrite it', () => {
  const { database, databasePath } = openSessionDatabase('chat-approval-cas-');
  const recorder = beginRecorder(databasePath);
  const approvalId = randomUUID();
  recorder.recordApprovalRequested({ approvalId, call: call(0, 'call_a'), toolName: 'write', command: 'write file', reviewPayload: null,
    mode: 'interactive', requestedAtUtc: AT, expiresAtUtc: '2026-09-10T11:14:54.755Z' });
  const resolution = { approvalId, outcome: 'approved', decision: { decision: 'approve' }, reason: null, decidedAtUtc: AT } as const;
  recorder.recordApprovalResolved(resolution);
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'continuing' } });
  recorder.recordApprovalResolved(resolution);
  assert.throws(() => recorder.recordApprovalResolved({ ...resolution, outcome: 'denied', decision: { decision: 'deny', reason: 'late' } }), /conflict|different/u);
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 10, text: ' safely' } });
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'approval_resolved').length, 1);
});

test('a rejected submission event leaves no unfinished admission behind', () => {
  const { database, databasePath } = openSessionDatabase('chat-admission-rollback-');
  database.exec(`CREATE TRIGGER reject_submission BEFORE INSERT ON chat_run_events WHEN NEW.kind = 'run_started'
    BEGIN SELECT RAISE(ABORT, 'submission write refused'); END;`);
  assert.throws(() => beginRecorder(databasePath), /submission write refused/u);
  assert.deepEqual(new ChatJournalStore(database).listSessionRuns(SESSION_ID), []);
});

test('engine binding and its journal event commit atomically and retry without duplicates', () => {
  const { database, databasePath } = openSessionDatabase('chat-binding-rollback-');
  const recorder = beginRecorder(databasePath);
  const store = new ChatJournalStore(database);
  const binding = { requestId: 'request', repoAgentSessionId: randomUUID() };
  database.exec(`CREATE TRIGGER reject_binding BEFORE INSERT ON chat_run_events WHEN NEW.kind='engine_bound'
    BEGIN SELECT RAISE(ABORT, 'binding write refused'); END;`);
  assert.throws(() => recorder.bindEngine(binding), /binding write refused/u);
  assert.equal(store.readRun(recorder.operationId)?.requestId, null);
  assert.equal(store.readRun(recorder.operationId)?.repoAgentSessionId, null);
  database.exec('DROP TRIGGER reject_binding');
  recorder.bindEngine(binding);
  recorder.bindEngine(binding);
  assert.equal(store.readRun(recorder.operationId)?.requestId, binding.requestId);
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'engine_bound').length, 1);
});

test('retrying a failed terminal row update commits one terminal event', () => {
  const { database, databasePath } = openSessionDatabase('chat-terminal-rollback-');
  const recorder = beginRecorder(databasePath);
  const outcome = { terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' } as const;
  database.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE OF terminal_cause ON chat_runs
    BEGIN SELECT RAISE(ABORT, 'terminal write refused'); END;`);
  assert.throws(() => recorder.finish(outcome), /terminal write refused/u);
  database.exec('DROP TRIGGER reject_terminal');
  recorder.finish(outcome);
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'run_finished').length, 1);
});

test('queue delivery and journal evidence commit together or leave the message pending', () => {
  const { database, databasePath } = openSessionDatabase('chat-queue-journal-atomic-');
  const recorder = beginRecorder(databasePath);
  const queue = new ChatMessageQueueStore(database);
  const id = randomUUID();
  queue.enqueue(SESSION_ID, { id, content: 'steering', images: [], options: { operationKind: 'repo-agent' } });
  const input = { requestId: 'request-queue', turn: 1, ids: [id] };
  database.exec(`CREATE TRIGGER reject_delivery BEFORE INSERT ON chat_run_events WHEN NEW.kind = 'queue_delivered'
    BEGIN SELECT RAISE(ABORT, 'delivery write refused'); END;`);
  assert.throws(() => recorder.claimQueuedMessages(SESSION_ID, input, mockModelPreset({ Model: 'model-a', NumCtx: 4096 })), /delivery write refused/u);
  assert.equal(queue.get(SESSION_ID, id)?.state, 'pending');
  database.exec('DROP TRIGGER reject_delivery');
  assert.equal(recorder.claimQueuedMessages(SESSION_ID, input, mockModelPreset({ Model: 'model-a', NumCtx: 4096 }))[0]?.id, id);
  const events = readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'queue_delivered');
  assert.equal(events.length, 1);
});

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
  readonly userMessageId = 'spy-user';
  readonly messageIdPrefix = 'spy';
  readonly historyRevision = 0;
  readonly abortSignal = new AbortController().signal;
  private readonly toolIds = new Map<string, string>();
  resolveAssistantMessageId(turn: number): string { return `spy-narration-${turn}`; }
  resolveToolMessageId(toolCallId: string): string | null { return this.toolIds.get(toolCallId) ?? null; }
  readHistoryRevisions() { return []; }
  recordApprovalReviewed(): void { this.note('approval_reviewed'); }
  recordApprovalRequested(): void { this.note('approval_requested'); }
  recordApprovalResolved(): void { this.note('approval_resolved'); }
  readonly steps: string[] = [];
  readonly results: ChatToolResultEvidence[] = [];

  constructor(private readonly sideEffectPath: string, private readonly failAt: string | null = null) {}

  private note(step: string): void {
    this.steps.push(`${step}:${fs.existsSync(this.sideEffectPath) ? 'after' : 'before'}`);
    if (step === this.failAt) throw new Error(`journal is unavailable at ${step}`);
  }

  recordContextInitialized(init: ChatContextInit): ChatContextInit {
    this.note('context_initialized');
    return init;
  }

  recordContextSpliced(splice: ChatContextSplice): ChatContextSplice {
    this.note('context_spliced');
    return splice;
  }

  recordToolProposed(evidence: ChatToolProposedEvidence): void {
    this.note('tool_proposed');
    this.toolIds.set(evidence.call.toolCallId, `spy-tool-${evidence.call.displayToolCallId}`);
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

test('a run, its queue and its owner stay on their own database while another root opens and closes', () => {
  const first = openSessionDatabase('chat-run-recorder-stable-a-');
  const owner = ChatRuntimeOwner.acquire(first.database, 'owner-a');
  assert.equal(owner.ownerEpoch, OWNER_EPOCH);
  const recorder = beginRecorder(first.databasePath);
  const queue = new ChatMessageQueueStore(first.database);

  const second = openSessionDatabase('chat-run-recorder-stable-b-');
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'still on A' } });
  assert.equal(new ChatJournalStore(first.database).readRun(recorder.operationId)?.latestSequence, 2);
  closeRuntimeDatabase(second.databasePath);
  assert.equal(second.database.open, false);
  assert.equal(first.database.open, true);

  const queued = randomUUID();
  queue.enqueue(SESSION_ID, { id: queued, content: 'queued on A', images: [], options: { operationKind: 'repo-agent' } });
  assert.equal(queue.state(SESSION_ID).messages.length, 1);
  owner.renew();
  recorder.bindEngine({ requestId: 'request-1', repoAgentSessionId: null });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });

  assert.equal(getRuntimeDatabase(first.databasePath), first.database);
  const run = new ChatJournalStore(first.database).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'completed');
  assert.equal(run?.requestId, 'request-1');
  assert.equal(new ChatJournalStore(getRuntimeDatabase(second.databasePath)).readRun(recorder.operationId), null);
});

test('a mid-run queued delivery admits its images for the run preset and projects their metadata', () => {
  const { database, databasePath } = openSessionDatabase('chat-queue-image-admission-');
  const modelPreset = mockModelPreset({ Model: 'model-a', NumCtx: 4096, VisionEnabled: true, VisionImageRetention: 4 });
  const recorder = beginRecorder(databasePath);
  const queue = new ChatMessageQueueStore(database);
  const image = toDataUrl('image/png', rasterBuffer('png', 32, 24));
  const id = randomUUID();
  queue.enqueue(SESSION_ID, { id, content: 'look at this', images: [image], options: { operationKind: 'repo-agent' } });
  const claimed = recorder.claimQueuedMessages(SESSION_ID, { requestId: 'request-image', turn: 1, ids: [id] }, modelPreset);
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0]?.images, [image]);
  const delivered = readAll(database, recorder.operationId).find(envelope => envelope.event.kind === 'queue_delivered');
  assert.ok(delivered && delivered.event.kind === 'queue_delivered');
  assert.equal(delivered.event.message.imageMeta[0]?.width, 32);
  assert.equal(delivered.event.message.imageMeta[0]?.height, 24);
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  recorder.readSession();
  const row = readChatRunMessages(database, SESSION_ID, recorder.operationId).find(message => message.id === id);
  assert.deepEqual(row?.images, [image]);
  assert.equal(row?.imageMeta?.[0]?.width, 32);
  assert.ok((row?.imageMeta?.[0]?.tokenEstimate ?? 0) > 0);
});

test('a queued delivery whose images the run preset refuses stays pending and records nothing', () => {
  const { database, databasePath } = openSessionDatabase('chat-queue-image-refusal-');
  const modelPreset = mockModelPreset({ Model: 'model-a', NumCtx: 4096, VisionEnabled: false });
  const recorder = beginRecorder(databasePath);
  const queue = new ChatMessageQueueStore(database);
  const id = randomUUID();
  queue.enqueue(SESSION_ID, { id, content: 'look at this', images: [toDataUrl('image/png', rasterBuffer('png', 1, 1))], options: { operationKind: 'repo-agent' } });
  assert.throws(() => recorder.claimQueuedMessages(SESSION_ID, { requestId: 'request-image', turn: 1, ids: [id] }, modelPreset), /image/iu);
  assert.equal(queue.get(SESSION_ID, id)?.state, 'pending');
  assert.equal(readAll(database, recorder.operationId).some(envelope => envelope.event.kind === 'queue_delivered'), false);
});

test('an automatic reviewer verdict is committed as evidence and projects no display row of its own', () => {
  const { database, databasePath } = openSessionDatabase('chat-approval-reviewed-');
  const recorder = beginRecorder(databasePath);
  recorder.recordToolProposed({ call: call(0, 'call_a'), toolName: 'write', arguments: { path: 'out.txt' }, command: 'write path="out.txt"',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 120, promptTokenCount: 10, executionState: 'proposed' });
  recorder.recordApprovalReviewed({ call: call(0, 'call_a'), toolName: 'write', command: 'write path="out.txt"',
    verdict: 'approve', reason: 'task-scoped write', reviewedAtUtc: AT });
  const reviewed = readAll(database, recorder.operationId).map(envelope => envelope.event).find(event => event.kind === 'approval_reviewed');
  assert.equal(reviewed?.kind === 'approval_reviewed' && reviewed.verdict, 'approve');
  const report = reconcileChatRun(database, recorder.operationId);
  assert.equal(report.status, 'ok');
  assert.deepEqual(readChatRunMessages(database, SESSION_ID, recorder.operationId).map(message => message.kind), ['user_text', 'assistant_tool_call']);
});
