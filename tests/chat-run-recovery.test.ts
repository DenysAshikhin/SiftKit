import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { recoverInterruptedChatRuns, reconcileChatSession } from '../src/status-server/chat-run-recovery.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, asObject, asObjectArray } from './helpers/dashboard-http.js';
import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { ChatRuntimeOwnerSchema } from '../src/state/chat-runtime-owner.js';
import { ChatRunRecorder, buildChatRunSettings } from '../src/status-server/chat-run-recorder.js';
import { randomUUID } from 'node:crypto';
import { getRuntimeRoot, getConfigPath } from '../src/status-server/paths.js';
import { getChatSessionPath, readChatSessionFromPath } from '../src/state/chat-sessions.js';
import { readConfig } from '../src/status-server/config-store.js';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';
import { ChatOperationSnapshotSchema } from '@siftkit/contracts';
import { ChatMessageQueueStore } from '../src/state/chat-message-queue.js';

test('a gap behind an intact projection is attributed to the earlier corrupt run', () => {
  const root = createManagedTempDir('chat-recovery-gap-owner-');
  let session = createTestChatSession(root);
  const runs: ChatRunRecorder[] = [];
  for (const content of ['first', 'second']) {
    const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject(), { operationKind: 'message', content, images: [], imageMeta: [] });
    const history = recorder.readHistory();
    recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: history.length, messages: [...history,
      { role: 'user', content, chatMessageId: recorder.userMessageId },
      { role: 'assistant', content: `${content} answer`, chatMessageId: `${content}-answer` },
    ] });
    session = recorder.completeAnswer({ content: `${content} answer` });
    runs.push(recorder);
  }
  const first = runs[0];
  assert.ok(first);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  database.prepare('DELETE FROM chat_run_events WHERE operation_id=? AND sequence=2').run(first.operationId);
  const failed = reconcileChatSession(database, session.id).find(report => report.status === 'recovery_failed');
  assert.equal(failed?.operationId, first.operationId);
  assert.equal(failed?.issues[0]?.code, 'sequence_gap');
});

test('a durable Stop request survives a crash before terminal closure and aborts its pending approval', () => {
  const root = createManagedTempDir('chat-stop-intent-recovery-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.bindEngine({ requestId: 'request', repoAgentSessionId: randomUUID() });
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  const call = { toolCallId: 'native', displayToolCallId: 'display', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 2, promptTokenCount: 0, executionState: 'pending_approval' });
  const now = Date.now();
  recorder.recordApprovalRequested({ call, approvalId: randomUUID(), toolName: 'run', command: 'work', reviewPayload: null, mode: 'interactive',
    requestedAtUtc: new Date(now).toISOString(), expiresAtUtc: new Date(now + 600_000).toISOString() });
  recorder.requestUserStop();
  const databasePath = join(root, 'runtime.sqlite');
  const owner = ChatRuntimeOwner.acquire(databasePath, 'replacement');
  const database = getRuntimeDatabase(databasePath);
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  const store = new ChatJournalStore(database);
  assert.equal(store.readRun(recorder.operationId)?.terminalCause, 'user_stop');
  const events = store.readAfter(recorder.operationId, 0, 500);
  assert.equal(events.some(envelope => envelope.event.kind === 'tool_started'), false);
  const resolved = events.find(envelope => envelope.event.kind === 'approval_resolved')?.event;
  assert.equal(resolved?.kind === 'approval_resolved' ? resolved.outcome : null, 'aborted');
});

test('startup retries projection and queue cleanup after the terminal event already committed', () => {
  const root = createManagedTempDir('chat-terminal-recovery-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const databasePath = join(root, 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  const queue = new ChatMessageQueueStore(database);
  const id = randomUUID();
  recorder.bindEngine({ requestId: 'request', repoAgentSessionId: null });
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  queue.enqueue(session.id, { id, content: 'durable steering', images: [], options: { operationKind: 'repo-search' } });
  recorder.claimQueuedMessages(session.id, { requestId: 'request', turn: 1, ids: [id] }, session.modelPreset);
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  database.exec(`CREATE TRIGGER refuse_queue_projection BEFORE INSERT ON chat_messages WHEN NEW.content='durable steering'
    BEGIN SELECT RAISE(ABORT, 'queue projection blocked'); END;`);
  assert.throws(() => recorder.readSession(), /queue projection blocked/u);
  database.exec('DROP TRIGGER refuse_queue_projection');
  const owner = ChatRuntimeOwner.acquire(databasePath, 'replacement');
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  assert.equal(queue.listDelivered(session.id, 'request').length, 0);
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, 'completed');
  assert.equal(buildRecoveredChatHistory(database, session.id).messages.filter(message => message.content === 'durable steering').length, 1);
  assert.deepEqual(recoverInterruptedChatRuns(database, owner.ownerEpoch), []);
});

test('one corrupt orphan is reported without preventing healthy sessions from recovering', () => {
  const root = createManagedTempDir('chat-orphan-isolation-');
  const config = getDefaultConfigObject();
  const broken = createTestChatRunRecorder(root, { ...createTestChatSession(root), id: 'a-broken' }, config);
  broken.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'broken source' }] });
  broken.readSession();
  const healthy = createTestChatRunRecorder(root, { ...createTestChatSession(root), id: 'b-healthy' }, config);
  healthy.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'healthy source' }] });
  const databasePath = join(root, 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  database.prepare("UPDATE chat_run_events SET payload_digest='corrupt' WHERE operation_id=? AND kind='context_initialized'").run(broken.operationId);
  const owner = ChatRuntimeOwner.acquire(databasePath, 'replacement');
  const reports = recoverInterruptedChatRuns(database, owner.ownerEpoch);
  assert.ok(reports.some(report => report.operationId === broken.operationId && report.status === 'recovery_failed'));
  assert.equal(new ChatJournalStore(database).readRun(healthy.operationId)?.terminalCause, 'server_restart');
  assert.equal(new ChatJournalStore(database).readRun(broken.operationId)?.terminalCause, null);
  assert.ok(buildRecoveredChatHistory(database, 'b-healthy').messages.some(message => message.content === 'healthy source'));
});

test('server startup recovers an admitted orphan before serving its conversation', async t => {
  const harness = await startHarness('chat-startup-recovery-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'orphan' }) });
  assert.equal(created.statusCode, 200);
  const sessionId = String(asObject(created.body.session).id);
  const session = readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId));
  assert.ok(session);
  const databasePath = getRuntimeDatabasePath();
  const owner = ChatRuntimeOwnerSchema.parse(getRuntimeDatabase(databasePath).prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  const recorder = ChatRunRecorder.begin(databasePath, {
    operationId: randomUUID(), sessionId, ownerEpoch: `${owner.owner_id}:${owner.epoch}`, operationKind: 'message',
    userMessageId: randomUUID(), content: 'accepted before the server stopped', images: [], imageMeta: [], retainedHistoryRevision: 0,
    settings: buildChatRunSettings({ session, config: readConfig(getConfigPath()), operationKind: 'message', presetId: 'chat', repoRoot: session.planRepoRoot, approval: null, maxTurns: null, webSearchEnabled: false }),
    startedAtUtc: new Date().toISOString(),
  });
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0,
    messages: [{ role: 'user', content: 'accepted before the server stopped', chatMessageId: recorder.userMessageId }] });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'committed partial answer' } });
  const live = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(asObjectArray(asObject(live.body.session).messages).some(message => message.content === 'committed partial answer'), true,
    'GET must reconcile committed events before the operation finishes');
  await harness.restart();
  const store = new ChatJournalStore(getRuntimeDatabase(databasePath));
  assert.equal(store.readRun(recorder.operationId)?.terminalCause, 'server_restart');
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(response.statusCode, 200);
  assert.equal(asObjectArray(asObject(response.body.session).messages).filter(message => message.content === 'accepted before the server stopped').length, 1);
  assert.equal(buildRecoveredChatHistory(getRuntimeDatabase(databasePath), sessionId).messages[0]?.content, 'accepted before the server stopped');
  const attached = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  assert.equal(attached.status, 200, 'A finished journal run can be attached without an in-memory lease.');
  const frames = new SseFrameParser().push(await attached.text());
  const snapshot = frames.find(frame => frame.event === 'snapshot');
  assert.ok(snapshot);
  const view = ChatOperationSnapshotSchema.parse(JSON.parse(snapshot.data));
  assert.equal(view.terminalCause, 'server_restart');
  assert.ok(view.messages.some(message => message.content === 'committed partial answer'));
  assert.equal(frames.at(-1)?.event, 'ended');
});

test('startup closes an orphaned started tool as uncertain without losing its submission', () => {
  const root = createManagedTempDir('chat-orphan-recovery-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ messages: [{ role: 'user', content: 'find target' }], contextRevision: 0, turnBoundary: 0 });
  const call = { toolCallId: 'call-a', displayToolCallId: 'display-a', batchId: 'batch-a', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'potential effect' }, command: 'potential effect',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 2, promptTokenCount: 10, executionState: 'proposed' });
  recorder.recordToolStarted({ call, startedAtUtc: new Date().toISOString() });
  const databasePath = join(root, 'runtime.sqlite');
  const owner = ChatRuntimeOwner.acquire(databasePath, 'new-process');
  const database = getRuntimeDatabase(databasePath);
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  const store = new ChatJournalStore(database);
  assert.equal(store.readRun(recorder.operationId)?.terminalCause, 'server_restart');
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(history.messages[0]?.content, 'find target');
  assert.match(String(history.messages.find(message => message.role === 'tool')?.content), /Outcome uncertain/);
  const committed = store.readRun(recorder.operationId)?.latestSequence;
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  assert.equal(store.readRun(recorder.operationId)?.latestSequence, committed);
  assert.throws(() => recorder.recordToolStarted({ call, startedAtUtc: new Date().toISOString() }), /owner|fenced/u);
});
