import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ChatRuntimeOwner, CHAT_OWNER_LEASE_MS } from '../src/state/chat-runtime-owner.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { heartbeatChatRuntimeOwner } from '../src/status-server/chat-run-recovery.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { admittedChatRun } from './helpers/chat-run-recorder.js';
import { serverLogger } from '../src/status-server/server-logger.js';

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

test('a failed heartbeat aborts admitted work, then re-acquires a fresh epoch and closes the orphans', async t => {
  const { recorder, database, chatRuntimeOwner: owner, ctx } = admittedChatRun('chat-owner-heartbeat-reacquire-');
  assert.equal(await heartbeatChatRuntimeOwner(ctx), 'renewed');
  assert.equal(recorder.abortSignal.aborted, false);
  owner.release(0);
  const errors = t.mock.method(serverLogger, 'error', () => {});
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  // Re-acquiring returns before the abandoned journals are replayed: closing them is unbounded work
  // and must not spend the tick that has to renew this same lease again in 5 s.
  const tick = heartbeatChatRuntimeOwner(ctx);
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, null);
  assert.equal(await tick, 'reacquired');
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
  assert.equal(await heartbeatChatRuntimeOwner(ctx), 'renewed');
});

test('a heartbeat fenced out by another live owner aborts admitted work and does not take the lease', async t => {
  const { recorder, database, chatRuntimeOwner: owner, ctx } = admittedChatRun('chat-owner-heartbeat-fenced-');
  owner.release(0);
  const intruder = ChatRuntimeOwner.acquire(database, 'intruder');
  const errors = t.mock.method(serverLogger, 'error', () => {});
  assert.equal(await heartbeatChatRuntimeOwner(ctx), 'fenced');
  assert.equal(recorder.abortSignal.aborted, true);
  assert.deepEqual(errors.mock.calls.map(call => call.arguments[0]?.event), ['owner_lease_lost', 'owner_fenced']);
  assert.equal(ctx.chatRuntimeOwner, owner);
  assert.equal(ctx.chatRunOwnerEpoch, owner.ownerEpoch);
  intruder.assertOwned();
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, null);
});
