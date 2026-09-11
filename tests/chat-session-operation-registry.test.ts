import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatOperationClosure } from '../src/status-server/chat-operation-broadcast.js';

import {
  ChatSessionOperationRegistry,
  type ChatSessionOperation,
  type ChatSessionOperationAcquireResult,
} from '../src/status-server/chat-session-operation-registry.js';

const OPERATION_A = '4f9c1f9a-0000-4000-8000-000000000000';
const OPERATION_B = '4f9c1f9a-0000-4000-8000-000000000001';

function requireAcquired(result: ChatSessionOperationAcquireResult): ChatSessionOperation {
  if (result.kind === 'conflict') {
    throw new Error(`Expected acquired lease, active session was ${result.active.sessionId}.`);
  }
  return result.lease;
}

test('one session rejects a second lease while another session remains available', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = registry.acquire('session-a', 'message', OPERATION_A, 1_000);
  assert.equal(first.kind, 'acquired');
  assert.equal(registry.acquire('session-a', 'plan', OPERATION_B, 1_100).kind, 'conflict');
  assert.equal(registry.acquire('session-b', 'repo-search', OPERATION_B, 1_200).kind, 'acquired');
});

test('a stale lease cannot finish a newer operation', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = requireAcquired(registry.acquire('session-a', 'message', OPERATION_A, 1_000));
  assert.equal(registry.finish(first, { kind: 'completed' }), true);
  const second = requireAcquired(registry.acquire('session-a', 'plan', OPERATION_B, 2_000));
  assert.equal(registry.finish(first, { kind: 'completed' }), false);
  assert.equal(registry.getActiveOperation('session-a')?.token, second.token);
});

test('empty session ids are rejected', () => {
  const registry = new ChatSessionOperationRegistry();
  assert.throws(() => registry.acquire('', 'message', OPERATION_A, 1_000), /session id/i);
  assert.throws(() => registry.getActiveOperation(''), /session id/i);
});

test('all operation kinds retain conflict metadata', () => {
  const registry = new ChatSessionOperationRegistry();
  const operationKinds = ['message', 'plan', 'repo-search'] as const;
  for (let index = 0; index < operationKinds.length; index += 1) {
    const sessionId = `session-${index}`;
    const operationKind = operationKinds[index];
    const operationId = `4f9c1f9a-0000-4000-8000-00000000000${index}`;
    const lease = requireAcquired(registry.acquire(sessionId, operationKind, operationId, 1_000 + index));
    const conflict = registry.acquire(sessionId, 'message', OPERATION_B, 2_000 + index);
    assert.equal(conflict.kind, 'conflict');
    if (conflict.kind === 'conflict') {
      assert.equal(conflict.active.sessionId, sessionId);
      assert.equal(conflict.active.operationKind, operationKind);
      assert.equal(conflict.active.startedAtMs, 1_000 + index);
      assert.equal(conflict.active.token, lease.token);
      assert.equal(conflict.active.operationId, operationId);
    }
  }
  assert.equal(registry.getActiveCount(), operationKinds.length);
});

test('exact-token completion updates active count and missing sessions stay absent', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'repo-search', OPERATION_A, 1_000));
  assert.equal(registry.getActiveCount(), 1);
  assert.equal(registry.finish(lease, { kind: 'completed' }), true);
  assert.equal(registry.getActiveCount(), 0);
  assert.equal(registry.getActiveOperation('missing'), null);
  assert.equal(registry.finish(lease, { kind: 'completed' }), false);
});

async function remainsPending<T>(completion: Promise<T>): Promise<boolean> {
  const pending = Symbol('pending');
  return await Promise.race([completion, Promise.resolve(pending)]) === pending;
}

test('completion remains pending until finish and settles exactly once', async () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'message', OPERATION_A, 1_000));
  const waiting = registry.waitForCompletion(lease);
  assert.equal(await remainsPending(waiting), true);
  assert.equal(registry.finish(lease, { kind: 'completed' }), true);
  assert.deepEqual(await waiting, { kind: 'completed' });
  assert.equal(registry.finish(lease, { kind: 'failed', error: 'late' }), false);
});

test('completion rejects foreign leases and preserves failure details', async () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'message', OPERATION_A, 1_000));
  await assert.rejects(
    registry.waitForCompletion({ ...lease, token: 'foreign' }),
    /active chat operation/u,
  );
  const waiting = registry.waitForCompletion(lease);
  assert.equal(registry.finish(lease, { kind: 'failed', error: 'persistence failed' }), true);
  assert.deepEqual(await waiting, { kind: 'failed', error: 'persistence failed' });
});

test('leases retain the client operation id used for Stop ownership', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'repo-agent', OPERATION_A, 1_000));
  assert.equal(lease.operationId, OPERATION_A);
  assert.equal(registry.getActiveOperation('session-a')?.operationId, OPERATION_A);
});

test('each active operation exposes a broadcast that closes when the lease finishes', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'message', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  assert.equal(broadcast.isClosed(), false);
  broadcast.publish();
  registry.finish(lease, { kind: 'completed' });
  assert.equal(broadcast.isClosed(), true);
  assert.equal(registry.getBroadcast('session-a'), null);
});

test('a failed lease closes its broadcast with the failure the run never reported itself', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'plan', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  const closures: ChatOperationClosure[] = [];
  broadcast.attach({ onPublished: () => {}, onHistoryRevised: () => {}, onClosed: closure => closures.push(closure) });
  registry.finish(lease, { kind: 'failed', error: 'engine exploded' });
  assert.deepEqual(closures, [{ failure: 'engine exploded' }]);
});

test('a completed lease closes its broadcast cleanly; the journal supplies the terminal record', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'condense', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  const closures: ChatOperationClosure[] = [];
  broadcast.attach({ onPublished: () => {}, onHistoryRevised: () => {}, onClosed: closure => closures.push(closure) });
  registry.finish(lease, { kind: 'completed' });
  assert.deepEqual(closures, [{ failure: null }]);
});

test('a failure the run already reported is the one the closing notice carries', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'plan', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  const closures: ChatOperationClosure[] = [];
  broadcast.attach({ onPublished: () => {}, onHistoryRevised: () => {}, onClosed: closure => closures.push(closure) });
  broadcast.fail('already reported');
  registry.finish(lease, { kind: 'failed', error: 'engine exploded' });
  assert.deepEqual(closures, [{ failure: 'already reported' }]);
});

test('listActive returns every session that currently holds a lease', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'message', OPERATION_A, 1_000);
  registry.acquire('session-b', 'repo-agent', OPERATION_B, 1_100);
  const active = registry.listActive()
    .map((lease) => `${lease.sessionId}:${lease.operationKind}`)
    .sort();
  assert.deepEqual(active, ['session-a:message', 'session-b:repo-agent']);
});
