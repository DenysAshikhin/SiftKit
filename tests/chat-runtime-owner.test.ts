import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ChatRuntimeOwner, CHAT_OWNER_LEASE_MS } from '../src/state/chat-runtime-owner.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { heartbeatChatRuntimeOwner } from '../src/status-server/chat-run-recovery.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { serverLogger } from '../src/status-server/server-logger.js';
import { randomUUID } from 'node:crypto';

test('another owner cannot acquire a live lease, including immediately before expiry', () => {
  const path = join(createManagedTempDir('chat-owner-live-'), 'runtime.sqlite');
  ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'first', 0);
  assert.throws(() => ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'second', CHAT_OWNER_LEASE_MS - 1), /owner|lease/u);
});

test('expiry advances the fence and the old writer cannot renew or authorize', () => {
  const path = join(createManagedTempDir('chat-owner-expired-'), 'runtime.sqlite');
  const first = ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'first', 0);
  const second = ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'second', CHAT_OWNER_LEASE_MS);
  assert.equal(second.epoch, first.epoch + 1);
  assert.throws(() => first.assertOwned(CHAT_OWNER_LEASE_MS), /owner|lease/u);
  assert.throws(() => first.renew(CHAT_OWNER_LEASE_MS), /owner|lease/u);
  second.assertOwned(CHAT_OWNER_LEASE_MS);
});

test('heartbeat extends the original lease and clean release permits a fenced restart', () => {
  const path = join(createManagedTempDir('chat-owner-renew-'), 'runtime.sqlite');
  const first = ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'first', 0);
  first.renew(5_000);
  assert.throws(() => ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'second', 30_000), /owner|lease/u);
  first.release(10_000);
  const second = ChatRuntimeOwner.acquire(getRuntimeDatabase(path), 'second', 10_000);
  assert.equal(second.epoch, first.epoch + 1);
  first.release(10_001);
  second.assertOwned(10_001);
});

function contextFor(root: string, owner: ChatRuntimeOwner, operations: ChatSessionOperationRegistry): ServerContext {
  return { ...createTestServerContext(join(root, 'config.json'), root),
    chatRuntimeOwner: owner, chatRunOwnerEpoch: owner.ownerEpoch, chatSessionOperations: operations };
}

/** One admitted, context-initialized run held by a live registry lease on a fresh runtime. */
function admittedRun(prefix: string) {
  const root = createManagedTempDir(prefix);
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  const operations = new ChatSessionOperationRegistry();
  const acquired = operations.acquire(session.id, 'repo-search', randomUUID(), Date.now());
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  acquired.lease.recorder = recorder;
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  return { root, recorder, operations, database };
}

test('a failed heartbeat aborts admitted work, then re-acquires a fresh epoch and closes the orphans', t => {
  const { root, recorder, operations, database } = admittedRun('chat-owner-heartbeat-reacquire-');
  const owner = ChatRuntimeOwner.acquire(database, 'owner');
  const ctx = contextFor(root, owner, operations);
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'renewed');
  assert.equal(recorder.abortSignal.aborted, false);
  owner.release(0);
  const errors = t.mock.method(serverLogger, 'error', () => {});
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'reacquired');
  assert.equal(recorder.abortSignal.aborted, true);
  assert.equal(errors.mock.calls[0]?.arguments[0]?.event, 'owner_lease_lost');
  assert.match(String(errors.mock.calls[0]?.arguments[0]?.fields), /expired|fenced/u);
  assert.equal(warnings.mock.calls[0]?.arguments[0]?.event, 'owner_lease_reacquired');
  assert.notEqual(ctx.chatRuntimeOwner, owner);
  assert.equal(ctx.chatRuntimeOwner.epoch, owner.epoch + 1);
  assert.equal(ctx.chatRunOwnerEpoch, ctx.chatRuntimeOwner.ownerEpoch);
  ctx.chatRuntimeOwner.assertOwned();
  assert.throws(() => owner.assertOwned(), /owner|lease/u);
  const run = new ChatJournalStore(database).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'storage_failure');
  assert.equal(run?.ownerEpoch, ctx.chatRunOwnerEpoch);
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'renewed');
});

test('a heartbeat fenced out by another live owner aborts admitted work and does not take the lease', t => {
  const { root, recorder, operations, database } = admittedRun('chat-owner-heartbeat-fenced-');
  const owner = ChatRuntimeOwner.acquire(database, 'owner');
  const ctx = contextFor(root, owner, operations);
  owner.release(0);
  const intruder = ChatRuntimeOwner.acquire(database, 'intruder');
  const errors = t.mock.method(serverLogger, 'error', () => {});
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'fenced');
  assert.equal(recorder.abortSignal.aborted, true);
  assert.deepEqual(errors.mock.calls.map(call => call.arguments[0]?.event), ['owner_lease_lost', 'owner_fenced']);
  assert.equal(ctx.chatRuntimeOwner, owner);
  assert.equal(ctx.chatRunOwnerEpoch, owner.ownerEpoch);
  intruder.assertOwned();
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, null);
});
