import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLease,
  releaseLease,
  heartbeatLease,
  isLeaseStale,
  resolveActiveLease,
} from '../src/status-server/core/lease-handlers.js';
import type { ExecutionLease } from '../src/status-server/server-types.js';

const STALE = 10_000;

test('acquireLease grants a lease when the slot is free', () => {
  const result = acquireLease(null, 'tok-a', 1_000, STALE);
  assert.equal(result.acquired, true);
  assert.deepEqual(result.lease, { token: 'tok-a', heartbeatAt: 1_000 });
});

test('acquireLease denies when an active lease is held by another token', () => {
  const held: ExecutionLease = { token: 'tok-b', heartbeatAt: 1_000 };
  const result = acquireLease(held, 'tok-a', 2_000, STALE);
  assert.equal(result.acquired, false);
  assert.equal(result.lease, held);
});

test('acquireLease grants when the held lease is stale', () => {
  const held: ExecutionLease = { token: 'tok-b', heartbeatAt: 1_000 };
  const result = acquireLease(held, 'tok-a', 1_000 + STALE, STALE);
  assert.equal(result.acquired, true);
  assert.deepEqual(result.lease, { token: 'tok-a', heartbeatAt: 1_000 + STALE });
});

test('isLeaseStale crosses at exactly staleMs', () => {
  const lease: ExecutionLease = { token: 't', heartbeatAt: 0 };
  assert.equal(isLeaseStale(lease, STALE - 1, STALE), false);
  assert.equal(isLeaseStale(lease, STALE, STALE), true);
});

test('resolveActiveLease returns null for absent or stale, the lease otherwise', () => {
  assert.equal(resolveActiveLease(null, 1_000, STALE), null);
  const lease: ExecutionLease = { token: 't', heartbeatAt: 0 };
  assert.equal(resolveActiveLease(lease, STALE, STALE), null);
  assert.equal(resolveActiveLease(lease, 5_000, STALE), lease);
});

test('releaseLease succeeds only for the active holder', () => {
  const held: ExecutionLease = { token: 'tok-b', heartbeatAt: 1_000 };
  assert.equal(releaseLease(held, 'tok-b', 2_000, STALE), true);
  assert.equal(releaseLease(held, 'tok-a', 2_000, STALE), false);
  assert.equal(releaseLease(null, 'tok-b', 2_000, STALE), false);
  assert.equal(releaseLease(held, 'tok-b', 1_000 + STALE, STALE), false);
});

test('heartbeatLease refreshes only for the active holder', () => {
  const held: ExecutionLease = { token: 'tok-b', heartbeatAt: 1_000 };
  assert.deepEqual(heartbeatLease(held, 'tok-b', 5_000, STALE), { token: 'tok-b', heartbeatAt: 5_000 });
  assert.equal(heartbeatLease(held, 'tok-a', 5_000, STALE), null);
  assert.equal(heartbeatLease(null, 'tok-b', 5_000, STALE), null);
  assert.equal(heartbeatLease(held, 'tok-b', 1_000 + STALE, STALE), null);
});
