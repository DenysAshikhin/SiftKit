import { ChatMessageQueue } from '../src/status-server/chat-message-queue.js';
import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import type { ChatOperationFrame } from '../src/status-server/chat-operation-broadcast.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CHAT_QUEUE_MAX_PENDING, ChatMessageQueueResponseSchema } from '@siftkit/contracts';

import { ChatMessageQueueStore, type ChatQueueEnqueueInput } from '../src/state/chat-message-queue.js';
import { deleteChatSession, saveChatSession, type ChatSession } from '../src/state/chat-sessions.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { recoverInterruptedChatRuns } from '../src/status-server/chat-run-recovery.js';
import { ChatRuntimeOwner, ChatRuntimeOwnerSchema } from '../src/state/chat-runtime-owner.js';
import { ChatRunRecorder, buildChatRunSettings } from '../src/status-server/chat-run-recorder.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { randomUUID } from 'node:crypto';
import type { ChatQueueClaimInput } from '../src/state/chat-message-queue.js';
import { readChatSessionFromPath, getChatSessionPath } from '../src/state/chat-sessions.js';

function recordedClaim(runtimeRoot: string, sessionId: string, input: ChatQueueClaimInput) {
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  const prior = new ChatJournalStore(database).listSessionRuns(sessionId).find(run => run.requestId === input.requestId);
  const saved = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
  assert.ok(saved);
  if (prior) return ChatRunRecorder.resume(databasePath, prior.operationId, prior.ownerEpoch).claimQueuedMessages(sessionId, input, saved.modelPreset);
  const initial = new ChatMessageQueueStore(database).listPending(sessionId).find(message => input.ids === null || input.ids.includes(message.id));
  assert.ok(initial);
  const recorder = ChatRunRecorder.begin(databasePath, {
    operationId: randomUUID(), sessionId, ownerEpoch: 'old-process', operationKind: 'message', userMessageId: initial.id,
    content: initial.content, images: initial.images, imageMeta: [], retainedHistoryRevision: 0, startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({ session: saved, config: getDefaultConfigObject(), operationKind: 'message', presetId: 'chat', repoRoot: saved.planRepoRoot, approval: null, maxTurns: null, webSearchEnabled: false }),
  });
  recorder.bindEngine({ requestId: input.requestId, repoAgentSessionId: null });
  return recorder.claimQueuedMessages(sessionId, input, saved.modelPreset);
}

function recoverRecordedQueue(runtimeRoot: string): void {
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get();
  const owner = row === undefined ? null : ChatRuntimeOwnerSchema.parse(row);
  const epoch = owner ? `${owner.owner_id}:${owner.epoch}` : ChatRuntimeOwner.acquire(databasePath, 'new-process').ownerEpoch;
  recoverInterruptedChatRuns(database, epoch);
}

test('restart fails an unfinished Force intent and preserves its pending messages', t => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('chat-force-restart-');
  enqueued(store, 's1', entry(1));
  store.beginForce('s1', { id: uuid(90), operationId: uuid(91) }, uuid(92));
  recoverRecordedQueue(runtimeRoot);
  assert.equal(store.state('s1').force?.phase, 'failed');
  assert.equal(store.state('s1').paused, true);
  assert.deepEqual(store.listPending('s1').map(message => message.id), [uuid(1)]);
  const revision = store.state('s1').revision;
  recoverRecordedQueue(runtimeRoot);
  assert.equal(store.state('s1').revision, revision);
});

test('restart preserves journaled deliveries once and never requeues interrupted execution', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-recovery-');
  enqueued(store, 's1', entry(1));
  recordedClaim(runtimeRoot, 's1', { requestId: 'interrupted', turn: 2, ids: null });
  enqueued(store, 's1', entry(2));
  recoverRecordedQueue(runtimeRoot);
  recoverRecordedQueue(runtimeRoot);
  const saved = readChatSessionFromPath(getChatSessionPath(runtimeRoot, 's1'));
  assert.deepEqual(saved?.messages?.filter((row) => row.role === 'user').map((row) => row.id), [uuid(1)]);
  assert.equal(new ChatJournalStore(getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'))).listSessionRuns('s1')[0]?.terminalCause, 'server_restart');
  assert.deepEqual(store.listPending('s1').map((row) => row.id), [uuid(2)]);
  assert.equal(store.listDelivered('s1', 'interrupted').length, 0);
  assert.equal(store.state('s1').paused, true);
});

test('force snapshot cannot be edited or removed while settlement is pending', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-force-freeze-');
  enqueued(store, 's1', entry(1));
  store.beginForce('s1', { id: uuid(90), operationId: uuid(91) }, uuid(92));
  assert.equal(store.edit('s1', uuid(1), 'changed', 1).kind, 'not_pending');
  assert.equal(store.remove('s1', uuid(1)).kind, 'not_pending');
  assert.equal(store.listPending('s1')[0]?.content, 'message 1');
});

test('force rejects empty snapshots and conflicting retry operation identities', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-force-boundaries-');
  assert.equal(store.beginForce('s1', { id: uuid(90), operationId: uuid(91) }, uuid(92)).kind, 'empty');
  enqueued(store, 's1', entry(1));
  assert.equal(store.beginForce('s1', { id: uuid(90), operationId: uuid(91) }, uuid(92)).kind, 'started');
  assert.equal(store.beginForce('s1', { id: uuid(90), operationId: null }, uuid(92)).kind, 'conflict');
});

test('a fixed claim with missing or duplicate IDs leaves every row pending', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-claim-boundaries-');
  enqueued(store, 's1', entry(1));
  assert.throws(() => store.claim('s1', { requestId: 'run', turn: 1, ids: [uuid(1), uuid(2)] }), /snapshot/u);
  assert.throws(() => store.claim('s1', { requestId: 'run', turn: 1, ids: [uuid(1), uuid(1)] }), /duplicate/iu);
  assert.equal(store.get('s1', uuid(1))?.state, 'pending');
});

test('cleanup of a partially incorporated ledger rolls back as a whole', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-cleanup-atomic-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's1', entry(2));
  store.claim('s1', { requestId: 'run', turn: 0, ids: null });
  const saved = session('s1');
  saved.messages = [{ id: uuid(1), role: 'user', kind: 'user_text', content: entry(1).content, inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: saved.createdAtUtc ?? new Date().toISOString() }];
  saveChatSession(runtimeRoot, saved);
  assert.throws(() => store.deleteIncorporated('s1', 'run'), /Unincorporated/u);
  assert.deepEqual(store.listDelivered('s1', 'run').map((row) => row.id), [uuid(1), uuid(2)]);
});

const IMAGE = 'data:image/png;base64,AA==';

function uuid(index: number): string {
  return `4f9c1f9a-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function session(id: string): ChatSession {
  const createdAtUtc = '2026-09-09T00:00:00.000Z';
  return {
    id,
    title: id,
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed.exl3', NumCtx: 8192 }),
    planRepoRoot: 'C:/repo',
    presetId: 'chat',
    mode: 'chat',
    createdAtUtc,
    updatedAtUtc: createdAtUtc,
    messages: [],
  };
}

function entry(index: number, content = `message ${index}`): ChatQueueEnqueueInput {
  return { id: uuid(index), content, images: [], options: { operationKind: 'message' } };
}

function openStore(prefix: string): { store: ChatMessageQueueStore; runtimeRoot: string } {
  const runtimeRoot = createManagedTempDir(prefix);
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  saveChatSession(runtimeRoot, session('s1'));
  saveChatSession(runtimeRoot, session('s2'));
  return { store: new ChatMessageQueueStore(database), runtimeRoot };
}

function enqueued(store: ChatMessageQueueStore, sessionId: string, input: ChatQueueEnqueueInput): string {
  const result = store.enqueue(sessionId, input);
  assert.equal(result.kind, 'enqueued');
  return input.id;
}

test('enqueue keeps submission order and isolates sessions', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-fifo-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's1', entry(2, 'second'));
  enqueued(store, 's2', entry(3));
  assert.deepEqual(store.listPending('s1').map((message) => [message.id, message.content, message.state, message.revision]), [
    [uuid(1), 'message 1', 'pending', 1],
    [uuid(2), 'second', 'pending', 1],
  ]);
  assert.deepEqual(store.listPending('s2').map((message) => message.id), [uuid(3)]);
  assert.equal(store.enqueue('missing', entry(4)).kind, 'missing_session');
});

test('a retried enqueue is idempotent and a reused id with a different body is a conflict', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-idempotent-');
  const original = store.enqueue('s1', { ...entry(1), images: [IMAGE] });
  assert.equal(original.kind, 'enqueued');
  const retried = store.enqueue('s1', { ...entry(1), images: [IMAGE] });
  assert.equal(retried.kind, 'duplicate');
  assert.equal(retried.kind === 'duplicate' && retried.message.id, uuid(1));
  const conflicting = store.enqueue('s1', entry(1, 'different text'));
  assert.equal(conflicting.kind, 'conflict');
  assert.equal(store.listPending('s1').length, 1);
  assert.equal(store.listPending('s1')[0]?.content, 'message 1');
  assert.deepEqual(store.listPending('s1')[0]?.images, [IMAGE]);
});

test('an overflowing enqueue is rejected and the existing queue is untouched', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-overflow-');
  for (let index = 1; index <= CHAT_QUEUE_MAX_PENDING; index += 1) {
    enqueued(store, 's1', entry(index));
  }
  const overflow = store.enqueue('s1', entry(CHAT_QUEUE_MAX_PENDING + 1));
  assert.deepEqual(overflow, { kind: 'overflow', pendingCount: CHAT_QUEUE_MAX_PENDING });
  assert.equal(store.listPending('s1').length, CHAT_QUEUE_MAX_PENDING);
  assert.equal(store.enqueue('s2', entry(CHAT_QUEUE_MAX_PENDING + 2)).kind, 'enqueued');
});

test('edit and remove operate only on pending rows at the revision the editor saw', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-edit-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's1', entry(2));
  const edited = store.edit('s1', uuid(1), 'edited text', 1);
  assert.equal(edited.kind, 'applied');
  assert.equal(edited.kind === 'applied' && edited.message.revision, 2);
  const stale = store.edit('s1', uuid(1), 'stale edit', 1);
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.kind === 'stale' && stale.message.content, 'edited text');
  assert.equal(store.edit('s1', uuid(9), 'nothing', 1).kind, 'not_found');

  const claimed = store.claim('s1', { requestId: 'run-1', turn: 2, ids: [uuid(1)] });
  assert.deepEqual(claimed.map((message) => [message.id, message.state, message.deliveredRequestId, message.deliveredTurn]), [
    [uuid(1), 'delivered', 'run-1', 2],
  ]);
  const editDelivered = store.edit('s1', uuid(1), 'too late', 2);
  assert.equal(editDelivered.kind, 'not_pending');
  assert.equal(editDelivered.kind === 'not_pending' && editDelivered.message.state, 'delivered');
  assert.equal(store.remove('s1', uuid(1)).kind, 'not_pending');
  assert.equal(store.remove('s1', uuid(2)).kind, 'applied');
  assert.equal(store.remove('s1', uuid(2)).kind, 'not_found');
  assert.deepEqual(store.listPending('s1'), []);
  assert.equal(store.list('s1').length, 1);
});

test('claim takes the FIFO snapshot, later arrivals wait, and incorporation is required for cleanup', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-claim-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's1', entry(2));
  enqueued(store, 's2', entry(3));
  const claimed = recordedClaim(runtimeRoot, 's1', { requestId: 'run-1', turn: 2, ids: null });
  assert.deepEqual(claimed.map((message) => message.id), [uuid(1), uuid(2)]);
  enqueued(store, 's1', entry(4));
  assert.deepEqual(store.listPending('s1').map((message) => message.id), [uuid(4)]);
  assert.deepEqual(store.listDelivered('s1', 'run-1').map((message) => message.id), [uuid(1), uuid(2)]);
  assert.deepEqual(store.listDelivered('s2', 'run-1'), []);
  assert.deepEqual(recordedClaim(runtimeRoot, 's1', { requestId: 'run-1', turn: 3, ids: null }).map((message) => message.id), [uuid(4)]);

  assert.throws(() => store.deleteIncorporated('s1', 'run-1'), /Unincorporated/u);
  assert.equal(store.listDelivered('s1', 'run-1').length, 3);
  recoverRecordedQueue(runtimeRoot);
  assert.deepEqual(store.list('s1'), []);
  assert.deepEqual(readChatSessionFromPath(getChatSessionPath(runtimeRoot, 's1'))?.messages?.filter((message) => message.role === 'user').map((message) => message.id), [uuid(1), uuid(2), uuid(4)]);
  assert.equal(store.list('s2').length, 1);
});

test('startup recovery incorporates delivered users and retains only unsent pending users', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-recover-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's1', entry(2));
  enqueued(store, 's2', entry(3));
  recordedClaim(runtimeRoot, 's1', { requestId: 'run-1', turn: 2, ids: [uuid(2)] });
  recordedClaim(runtimeRoot, 's2', { requestId: 'run-2', turn: 0, ids: null });
  recoverRecordedQueue(runtimeRoot);
  assert.deepEqual(store.listPending('s1').map((message) => message.id), [uuid(1)]);
  assert.deepEqual(store.listPending('s2'), []);
  recoverRecordedQueue(runtimeRoot);
  assert.equal(readChatSessionFromPath(getChatSessionPath(runtimeRoot, 's2'))?.messages?.filter((message) => message.role === 'user').length, 1);
});

test('deleting a session removes its queue rows', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-cascade-');
  enqueued(store, 's1', entry(1));
  enqueued(store, 's2', entry(2));
  deleteChatSession(runtimeRoot, 's1');
  assert.deepEqual(store.list('s1'), []);
  assert.equal(store.list('s2').length, 1);
});

test('direct storage validates content and image limits before changing the queue', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-validation-');
  assert.throws(() => store.enqueue('s1', entry(1, 'x'.repeat(200_001))));
  assert.throws(() => store.enqueue('s1', { ...entry(1), images: Array.from({ length: 9 }, () => IMAGE) }));
  assert.throws(() => store.enqueue('s1', entry(1, '  ')));
  enqueued(store, 's1', entry(1));
  assert.throws(() => store.edit('s1', uuid(1), '', 1));
  assert.equal(store.listPending('s1')[0]?.content, 'message 1');
});

test('queue revision and paused state survive reopening and increase after removal', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-revision-');
  enqueued(store, 's1', entry(1));
  const revision = store.state('s1').revision;
  store.remove('s1', uuid(1));
  store.setPaused('s1', true);
  closeRuntimeDatabase();
  const reopened = new ChatMessageQueueStore(getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')));
  assert.ok(reopened.state('s1').revision > revision);
  assert.equal(reopened.state('s1').paused, true);
});

test('canonical stable IDs prevent duplicate delivery after queue ledger cleanup', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-persisted-');
  const original = entry(1);
  enqueued(store, 's1', original);
  store.claim('s1', { requestId: 'run', turn: 1, ids: null });
  const saved = session('s1');
  saved.messages = [{ id: original.id, role: 'user', kind: 'user_text', content: original.content, inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: saved.createdAtUtc ?? new Date().toISOString() }];
  saveChatSession(runtimeRoot, saved);
  store.deleteIncorporated('s1', 'run');
  assert.equal(store.enqueue('s1', original).kind, 'already_persisted');
  assert.equal(store.enqueue('s1', entry(1, 'different')).kind, 'persisted_conflict');
  assert.deepEqual(store.list('s1'), []);
});



test('queue owner broadcasts current state to idle clients and active operation readers', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-store-broadcast-');
  const registry = new ChatSessionOperationRegistry();
  const owner = new ChatMessageQueue(store, registry);
  const idle: string[] = [];
  const active: string[] = [];
  const subscriber = { onFrame(frame: ChatOperationFrame) { idle.push(frame.data); }, onHistoryRevised() {}, onClosed() {} };
  owner.attach('s1', subscriber);
  assert.equal(ChatMessageQueueResponseSchema.parse({ queue: JSON.parse(idle[0] ?? '{}') }).queue.revision, 0);
  registry.acquire('s1', 'message', uuid(8), Date.now());
  registry.getBroadcast('s1')?.attach({ onFrame(frame: ChatOperationFrame) { active.push(frame.data); }, onHistoryRevised() {}, onClosed() {} });
  enqueued(store, 's1', entry(1));
  owner.publish('s1');
  assert.equal(idle.length, 2);
  assert.deepEqual(active, idle.slice(1));
  owner.detach('s1', subscriber);
  owner.publish('s1');
  assert.equal(idle.length, 2);
});



test('delivery recovery advances the durable revision and invalid claims fail', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-store-ledger-revision-');
  enqueued(store, 's1', entry(1));
  assert.throws(() => store.claim('s1', { requestId: '', turn: -1, ids: null }));
  recordedClaim(runtimeRoot, 's1', { requestId: 'run', turn: 1, ids: null });
  const claimedRevision = store.state('s1').revision;
  recoverRecordedQueue(runtimeRoot);
  assert.ok(store.state('s1').revision > claimedRevision);
  assert.deepEqual(store.listDelivered('s1', 'run'), []);
});

test('queue previews retain only the newest fifty delivered rows alongside every pending row', (t) => {
  t.after(closeRuntimeDatabase);
  const { store } = openStore('siftkit-queue-preview-bound-');
  for (let index = 1; index <= 120; index += 1) {
    enqueued(store, 's1', entry(index));
    store.claim('s1', { requestId: 'run', turn: index, ids: null });
  }
  for (let index = 121; index <= 170; index += 1) enqueued(store, 's1', entry(index));
  const previews = store.state('s1').messages;
  assert.equal(previews.length, 100);
  assert.deepEqual(previews.map((message) => message.id), Array.from({ length: 100 }, (_, index) => uuid(index + 71)));
  assert.equal(previews.filter((message) => message.state === 'pending').length, 50);
  assert.equal(store.listDelivered('s1', 'run').length, 120);
});

test('state-specific reads do not decode unrelated full delivery payloads', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-filtered-reads-');
  enqueued(store, 's1', entry(1));
  store.claim('s1', { requestId: 'other-run', turn: 1, ids: null });
  enqueued(store, 's1', entry(2));
  store.claim('s1', { requestId: 'this-run', turn: 2, ids: null });
  enqueued(store, 's1', entry(3));
  getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')).prepare('UPDATE chat_pending_messages SET options_json = ? WHERE id = ?').run('corrupt unrelated payload', uuid(1));
  assert.deepEqual(store.listPending('s1').map((message) => message.id), [uuid(3)]);
  assert.deepEqual(store.listDelivered('s1', 'this-run').map((message) => message.id), [uuid(2)]);
  assert.throws(() => store.listDelivered('s1', 'other-run'));
});

test('deleting and recreating a session discards its paused queue metadata', (t) => {
  t.after(closeRuntimeDatabase);
  const { store, runtimeRoot } = openStore('siftkit-queue-delete-metadata-');
  enqueued(store, 's1', entry(1));
  store.setPaused('s1', true);
  deleteChatSession(runtimeRoot, 's1');
  saveChatSession(runtimeRoot, session('s1'));
  assert.deepEqual(store.state('s1'), { sessionId: 's1', revision: 0, paused: false, force: null, messages: [] });
});
