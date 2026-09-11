import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ChatRuntimeOwner, CHAT_OWNER_LEASE_MS } from '../src/state/chat-runtime-owner.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { renewChatRuntimeOwner } from '../src/status-server/chat-run-recovery.js';
import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { serverLogger } from '../src/status-server/server-logger.js';
import { randomUUID } from 'node:crypto';

test('another owner cannot acquire a live lease, including immediately before expiry', () => {
  const path = join(createManagedTempDir('chat-owner-live-'), 'runtime.sqlite');
  ChatRuntimeOwner.acquire(path, 'first', 0);
  assert.throws(() => ChatRuntimeOwner.acquire(path, 'second', CHAT_OWNER_LEASE_MS - 1), /owner|lease/u);
});

test('expiry advances the fence and the old writer cannot renew or authorize', () => {
  const path = join(createManagedTempDir('chat-owner-expired-'), 'runtime.sqlite');
  const first = ChatRuntimeOwner.acquire(path, 'first', 0);
  const second = ChatRuntimeOwner.acquire(path, 'second', CHAT_OWNER_LEASE_MS);
  assert.equal(second.epoch, first.epoch + 1);
  assert.throws(() => first.assertOwned(CHAT_OWNER_LEASE_MS), /owner|lease/u);
  assert.throws(() => first.renew(CHAT_OWNER_LEASE_MS), /owner|lease/u);
  second.assertOwned(CHAT_OWNER_LEASE_MS);
});

test('heartbeat extends the original lease and clean release permits a fenced restart', () => {
  const path = join(createManagedTempDir('chat-owner-renew-'), 'runtime.sqlite');
  const first = ChatRuntimeOwner.acquire(path, 'first', 0);
  first.renew(5_000);
  assert.throws(() => ChatRuntimeOwner.acquire(path, 'second', 30_000), /owner|lease/u);
  first.release(10_000);
  const second = ChatRuntimeOwner.acquire(path, 'second', 10_000);
  assert.equal(second.epoch, first.epoch + 1);
  first.release(10_001);
  second.assertOwned(10_001);
});

test('a failed owner heartbeat reports the failure and aborts admitted work without an engine callback', t => {
  const root = createManagedTempDir('chat-owner-heartbeat-failure-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const operations = new ChatSessionOperationRegistry();
  const acquired = operations.acquire(session.id, 'repo-search', randomUUID(), Date.now());
  assert.equal(acquired.kind, 'acquired');
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  acquired.lease.recorder = recorder;
  const owner = ChatRuntimeOwner.acquire(join(root, 'runtime.sqlite'), 'owner');
  assert.equal(renewChatRuntimeOwner(owner, operations), true);
  assert.equal(recorder.abortSignal.aborted, false);
  owner.release(0);
  const errors = t.mock.method(serverLogger, 'error', () => {});
  assert.equal(renewChatRuntimeOwner(owner, operations), false);
  assert.equal(recorder.abortSignal.aborted, true);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0]?.arguments[0]?.event, 'owner_lease_lost');
  assert.match(String(errors.mock.calls[0]?.arguments[0]?.fields), /expired|fenced/u);
});
