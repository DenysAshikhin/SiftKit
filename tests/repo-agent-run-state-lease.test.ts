import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import type { ProcessInspector } from '../src/lib/process-inspector.ts';
import {
  STALE_RECOVERY_CLAIM_MS,
  RepoAgentRunStateLease,
} from '../src/repo-agent/run-state-lease.ts';

const TEMP_ROOT = join(tmpdir(), `siftkit-lease-tests-${process.pid}`);

class FixedProcessInspector implements ProcessInspector {
  private readonly alive: boolean;

  constructor(alive: boolean) {
    this.alive = alive;
  }

  isAlive(_pid: number): boolean {
    return this.alive;
  }
}

before(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeLockPath(): string {
  const directory = join(TEMP_ROOT, crypto.randomUUID());
  mkdirSync(directory);
  return join(directory, 'state.lock');
}

test('a live owner prevents a second state lease', () => {
  const lockPath = makeLockPath();
  const first = new RepoAgentRunStateLease(lockPath);
  const second = new RepoAgentRunStateLease(lockPath);

  first.acquire();
  assert.throws(
    () => second.acquire(),
    /state transition is already active/iu,
  );
  assert.equal(existsSync(`${lockPath}.recovery`), false);
  first.release();

  assert.equal(existsSync(lockPath), false);
});

test('acquire and release reject duplicate lifecycle calls', () => {
  const lockPath = makeLockPath();
  const lease = new RepoAgentRunStateLease(lockPath);

  lease.acquire();
  assert.throws(() => lease.acquire(), /already acquired/iu);
  lease.release();
  assert.throws(() => lease.release(), /not acquired/iu);
});

test('an active recovery claim fails closed', () => {
  const lockPath = makeLockPath();
  writeFileSync(`${lockPath}.recovery`, `${JSON.stringify({
    pid: process.pid,
    createdAtUtc: new Date().toISOString(),
  })}\n`, 'utf8');
  const lease = new RepoAgentRunStateLease(lockPath);

  assert.throws(
    () => lease.acquire(),
    /state transition is already active/iu,
  );
  assert.equal(existsSync(lockPath), false);
});

test('a stale recovery claim from a dead owner is cleared', () => {
  const lockPath = makeLockPath();
  writeFileSync(`${lockPath}.recovery`, `${JSON.stringify({
    pid: 424242,
    createdAtUtc: new Date().toISOString(),
  })}\n`, 'utf8');
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(false),
  );

  lease.acquire();
  lease.release();

  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(`${lockPath}.recovery`), false);
});

test('an unreadable recovery claim fails closed while young and clears when stale', () => {
  const lockPath = makeLockPath();
  const recoveryPath = `${lockPath}.recovery`;
  writeFileSync(recoveryPath, '', 'utf8');
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(false),
  );

  assert.throws(
    () => lease.acquire(),
    /state transition is already active/iu,
  );
  assert.equal(existsSync(recoveryPath), true);

  const staleTime = new Date(Date.now() - STALE_RECOVERY_CLAIM_MS - 1000);
  utimesSync(recoveryPath, staleTime, staleTime);
  lease.acquire();
  lease.release();

  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(recoveryPath), false);
});

test('a live recovery owner fails closed and keeps its claim', () => {
  const lockPath = makeLockPath();
  writeFileSync(`${lockPath}.recovery`, `${JSON.stringify({
    pid: 424242,
    createdAtUtc: new Date().toISOString(),
  })}\n`, 'utf8');
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(true),
  );

  assert.throws(
    () => lease.acquire(),
    /state transition is already active/iu,
  );
  assert.equal(existsSync(`${lockPath}.recovery`), true);
});

test('filesystem errors other than contention are surfaced', () => {
  const lockPath = join(TEMP_ROOT, crypto.randomUUID(), 'state.lock');
  const lease = new RepoAgentRunStateLease(lockPath);

  assert.throws(() => lease.acquire(), /ENOENT|no such file/iu);
  assert.equal(existsSync(lockPath), false);
});

test('constructor rejects an empty lock path', () => {
  assert.throws(() => new RepoAgentRunStateLease(''));
});

test('a dead owner lease is recovered', () => {
  const lockPath = makeLockPath();
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 424242,
    createdAtUtc: new Date().toISOString(),
  })}\n`, 'utf8');
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(false),
  );

  lease.acquire();
  lease.release();

  assert.equal(existsSync(lockPath), false);
});

test('a malformed lease fails closed', () => {
  const lockPath = makeLockPath();
  writeFileSync(lockPath, '{bad', 'utf8');
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(false),
  );

  assert.throws(() => lease.acquire(), /malformed state lease/iu);
  assert.equal(existsSync(lockPath), true);
});

test('release refuses to remove another owner lease', () => {
  const lockPath = makeLockPath();
  const lease = new RepoAgentRunStateLease(lockPath);
  lease.acquire();
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid + 1,
    createdAtUtc: new Date().toISOString(),
  })}\n`, 'utf8');

  assert.throws(() => lease.release(), /owned by process/iu);
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath, { force: true });
});
