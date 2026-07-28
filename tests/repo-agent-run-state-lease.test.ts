import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import type { ProcessInspector } from '../src/lib/process-inspector.js';
import { RepoAgentRunStateLease } from '../src/repo-agent/run-state-lease.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  'repo-agent-safety-refactor',
  `lease-tests-${process.pid}`,
);

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
  first.release();

  assert.equal(existsSync(lockPath), false);
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
