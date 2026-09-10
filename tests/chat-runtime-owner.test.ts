import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ChatRuntimeOwner, CHAT_OWNER_LEASE_MS } from '../src/state/chat-runtime-owner.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

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
