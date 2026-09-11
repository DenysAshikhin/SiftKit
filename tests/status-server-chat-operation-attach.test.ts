import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ChatOperationSnapshotSchema, ChatStreamErrorSchema } from '@siftkit/contracts';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, asObject } from './helpers/dashboard-http.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { ChatRuntimeOwnerSchema } from '../src/state/chat-runtime-owner.js';
import { getChatSessionPath, readChatSessionFromPath } from '../src/state/chat-sessions.js';
import { getRuntimeRoot, getConfigPath } from '../src/status-server/paths.js';
import { readConfig } from '../src/status-server/config-store.js';
import { ChatRunRecorder, buildChatRunSettings } from '../src/status-server/chat-run-recorder.js';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';

function begin(sessionId: string) {
  const session = readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId));
  assert.ok(session);
  const databasePath = getRuntimeDatabasePath();
  const owner = ChatRuntimeOwnerSchema.parse(getRuntimeDatabase(databasePath).prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  return ChatRunRecorder.begin(databasePath, {
    operationId: randomUUID(), sessionId, ownerEpoch: `${owner.owner_id}:${owner.epoch}`, operationKind: 'repo-agent',
    userMessageId: randomUUID(), content: 'accepted prompt', images: [], imageMeta: [], retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(), settings: buildChatRunSettings({ session, config: readConfig(getConfigPath()),
      operationKind: 'repo-agent', repoRoot: session.planRepoRoot, approval: 'interactive', maxTurns: 20 }),
  });
}

test('attach reports the exact corrupt journal identity without echoing source payloads', async t => {
  const harness = await startHarness('chat-attach-corruption-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'corruption' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'NEVER_ECHO_SECRET_PAYLOAD' } });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  getRuntimeDatabase().prepare('UPDATE chat_run_events SET version=999 WHERE operation_id=? AND sequence=2').run(recorder.operationId);
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  const body = await response.text();
  const frame = new SseFrameParser().push(body).find(event => event.event === 'error');
  assert.ok(frame);
  const failure = ChatStreamErrorSchema.parse(JSON.parse(frame.data));
  assert.equal(failure.issue?.code, 'unknown_event_version');
  assert.equal(failure.issue?.operationId, recorder.operationId);
  assert.equal(failure.issue?.sequence, 2);
  assert.match(failure.error, /unknown_event_version/u);
  assert.doesNotMatch(frame.data, /NEVER_ECHO_SECRET_PAYLOAD/u);
});

test('attach returns accepted content and partial output from a terminal journal with no active lease', async t => {
  const harness = await startHarness('chat-attach-terminal-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'attach' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial answer' } });
  recorder.finish({ terminalCause: 'user_stop', detail: null, usage: null, recoveryStatus: 'ok' });
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  assert.equal(response.status, 200);
  const frames = new SseFrameParser().push(await response.text());
  const first = frames[0];
  assert.equal(first?.event, 'snapshot');
  assert.ok(first);
  const snapshot = ChatOperationSnapshotSchema.parse(JSON.parse(first.data));
  assert.equal(snapshot.operationId, recorder.operationId);
  assert.equal(snapshot.terminalCause, 'user_stop');
  assert.deepEqual(snapshot.messages.map(message => message.content), ['accepted prompt', 'partial answer']);
  assert.equal(snapshot.approval, null);
  assert.equal(snapshot.complete, true);
  assert.equal(frames.at(-1)?.event, 'ended');
});

test('attach reads durable approval outcome instead of replaying a stale approval card', async t => {
  const harness = await startHarness('chat-attach-approval-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'approval' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  const runId = randomUUID();
  recorder.bindEngine({ requestId: randomUUID(), repoAgentSessionId: runId });
  const approvalId = randomUUID();
  const at = new Date().toISOString();
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 20, promptTokenCount: 0, executionState: 'pending_approval' });
  recorder.recordApprovalRequested({ call, approvalId, toolName: 'run', command: 'work', reviewPayload: null,
    mode: 'interactive', requestedAtUtc: at, expiresAtUtc: new Date(Date.parse(at) + 600_000).toISOString() });
  recorder.recordApprovalResolved({ approvalId, outcome: 'denied', decision: { decision: 'deny', reason: 'no' }, reason: 'no', decidedAtUtc: at });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  const frame = new SseFrameParser().push(await response.text()).find(item => item.event === 'snapshot');
  assert.ok(frame);
  const snapshot = ChatOperationSnapshotSchema.parse(JSON.parse(frame.data));
  assert.equal(snapshot.approval?.approvalId, approvalId);
  assert.equal(snapshot.approval?.outcome, 'denied');
  assert.equal(snapshot.approval?.actionable, false);
  assert.ok(snapshot.messages.some(message => message.kind === 'repo_agent_approval' && message.approvalDecision === 'deny'));
});

test('attach does not invent a run for a session with no accepted operation', async t => {
  const harness = await startHarness('chat-attach-empty-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'empty' }) });
  const sessionId = String(asObject(created.body.session).id);
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  assert.equal(response.status, 404);
});
