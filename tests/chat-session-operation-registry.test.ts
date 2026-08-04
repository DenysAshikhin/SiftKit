import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatSessionOperationRegistry,
  type ChatSessionOperation,
  type ChatSessionOperationAcquireResult,
} from '../src/status-server/chat-session-operation-registry.js';

function requireAcquired(result: ChatSessionOperationAcquireResult): ChatSessionOperation {
  if (result.kind === 'conflict') {
    throw new Error(`Expected acquired lease, active session was ${result.active.sessionId}.`);
  }
  return result.lease;
}

test('one session rejects a second lease while another session remains available', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = registry.acquire('session-a', 'message', 1_000);
  assert.equal(first.kind, 'acquired');
  assert.equal(registry.acquire('session-a', 'plan', 1_100).kind, 'conflict');
  assert.equal(registry.acquire('session-b', 'repo-search', 1_200).kind, 'acquired');
});

test('a stale lease cannot release a newer operation', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = requireAcquired(registry.acquire('session-a', 'message', 1_000));
  assert.equal(registry.release(first), true);
  const second = requireAcquired(registry.acquire('session-a', 'plan', 2_000));
  assert.equal(registry.release(first), false);
  assert.equal(registry.getActiveOperation('session-a')?.token, second.token);
});

test('empty session ids are rejected', () => {
  const registry = new ChatSessionOperationRegistry();
  assert.throws(() => registry.acquire('', 'message', 1_000), /session id/i);
  assert.throws(() => registry.getActiveOperation(''), /session id/i);
});

test('all operation kinds retain conflict metadata', () => {
  const registry = new ChatSessionOperationRegistry();
  const operationKinds = ['message', 'plan', 'repo-search'] as const;
  for (let index = 0; index < operationKinds.length; index += 1) {
    const sessionId = `session-${index}`;
    const operationKind = operationKinds[index];
    const lease = requireAcquired(registry.acquire(sessionId, operationKind, 1_000 + index));
    const conflict = registry.acquire(sessionId, 'message', 2_000 + index);
    assert.equal(conflict.kind, 'conflict');
    if (conflict.kind === 'conflict') {
      assert.equal(conflict.active.sessionId, sessionId);
      assert.equal(conflict.active.operationKind, operationKind);
      assert.equal(conflict.active.startedAtMs, 1_000 + index);
      assert.equal(conflict.active.token, lease.token);
    }
  }
  assert.equal(registry.getActiveCount(), operationKinds.length);
});

test('exact-token release updates active count and missing sessions stay absent', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'repo-search', 1_000));
  assert.equal(registry.getActiveCount(), 1);
  assert.equal(registry.release(lease), true);
  assert.equal(registry.getActiveCount(), 0);
  assert.equal(registry.getActiveOperation('missing'), null);
  assert.equal(registry.release(lease), false);
});
