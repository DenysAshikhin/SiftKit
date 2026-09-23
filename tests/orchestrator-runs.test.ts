import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorRunState } from '@siftkit/contracts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import {
  OrchestratorRunRegistry,
  RepositoryGate,
  type OrchestratorLiveRun,
  type RepositoryLease,
} from '../src/status-server/orchestrator-runs.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function openStore(t: TestContext): OrchestratorRunStore {
  const dbPath = path.join(createManagedTempDir('siftkit-orchestrator-runs-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  return new OrchestratorRunStore(getRuntimeDatabase(dbPath));
}

function createRun(store: OrchestratorRunStore): OrchestratorRunState {
  return store.create({ submissionId: randomUUID(), repoRoot: 'C:/repo', presetId: 'orchestrator',
    approval: 'auto', task: 'Inspect the README.', planPath: null });
}

/** Resolves on the next macrotask so any already-granted lease has settled. */
async function settle<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);
}

class FakeLiveRun implements OrchestratorLiveRun {
  abortReason: string | null = null;
  private finish: () => void = () => {};
  readonly settled = new Promise<void>((resolve) => { this.finish = resolve; });
  constructor(readonly runId: string, private readonly onAbort: () => void = () => {}) {}
  abort(reason: string): void {
    this.abortReason = reason;
    this.onAbort();
    this.finish();
  }
}

test('shared leases overlap; an exclusive waits for them and blocks later readers until it releases', async () => {
  const repo = createManagedTempDir('siftkit-gate-');
  const gate = new RepositoryGate();
  const signal = new AbortController().signal;
  const readerA = await gate.acquire(repo, 'shared', signal);
  const readerB = await gate.acquire(repo, 'shared', signal);
  const writer = gate.acquire(repo, 'exclusive', signal);
  const lateReader = gate.acquire(repo, 'shared', signal);
  assert.equal(await settle(writer), 'pending');
  readerA.release();
  assert.equal(await settle(writer), 'pending');
  readerB.release();
  const writerLease = await writer;
  assert.equal(await settle(lateReader), 'pending', 'a reader queued behind the writer waits');
  writerLease.release();
  writerLease.release();
  (await lateReader).release();
});

test('path aliases share one repository key and an unknown root fails loudly', async () => {
  const repo = createManagedTempDir('siftkit-gate-alias-');
  const link = `${repo}-link`;
  fs.symlinkSync(repo, link, 'junction');
  const gate = new RepositoryGate();
  const signal = new AbortController().signal;
  const writer = await gate.acquire(repo, 'exclusive', signal);
  const alias = `${repo.replace(/\\/gu, '/')}/sub/..`;
  for (const candidate of [alias, link]) {
    assert.equal(await settle(gate.acquire(candidate, 'shared', signal).then((lease: RepositoryLease) => {
      lease.release();
      return 'granted';
    })), 'pending', candidate);
  }
  writer.release();
  fs.rmSync(link, { force: true, recursive: true });
  await assert.rejects(gate.acquire(path.join(repo, 'missing'), 'shared', signal), /ENOENT/u);
});

test('an aborted waiter leaves the queue without ever holding the repository', async () => {
  const repo = createManagedTempDir('siftkit-gate-abort-');
  const gate = new RepositoryGate();
  const writer = await gate.acquire(repo, 'exclusive', new AbortController().signal);
  const controller = new AbortController();
  const waiting = gate.acquire(repo, 'exclusive', controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/u);
  writer.release();
  const next = await gate.acquire(repo, 'exclusive', new AbortController().signal);
  next.release();
});

test('startup marks every stored nonterminal parent interrupted and never redispatches it', (t) => {
  const store = openStore(t);
  const active = createRun(store);
  const registry = new OrchestratorRunRegistry(store);
  assert.deepEqual(registry.reconcileOnStartup(), [active.runId]);
  const state = store.read(active.runId);
  assert.equal(state.phase, 'interrupted');
  assert.match(state.failure?.message ?? '', /server restarted/iu);
  assert.deepEqual(registry.reconcileOnStartup(), []);
});

test('shutdown stops scheduling, aborts live parents, waits for them, and interrupts the unsettled', async (t) => {
  const store = openStore(t);
  const registry = new OrchestratorRunRegistry(store);
  const first = createRun(store);
  const second = createRun(store);
  const settledRun = new FakeLiveRun(first.runId, () => {
    store.update(first.runId, store.read(first.runId).revision, { phase: 'aborted' }, { message: 'Run aborted.' });
  });
  const unsettledRun = new FakeLiveRun(second.runId);
  registry.register(settledRun);
  registry.register(unsettledRun);
  assert.throws(() => registry.register(new FakeLiveRun(first.runId)), /already live/u);

  await registry.shutdown();
  assert.equal(settledRun.abortReason, 'The server is shutting down.');
  assert.equal(store.read(first.runId).phase, 'aborted');
  assert.equal(store.read(second.runId).phase, 'interrupted');
  assert.equal(registry.get(first.runId), undefined);
  assert.throws(() => registry.register(new FakeLiveRun(randomUUID())), /shutting down/u);
});

test('subscribers receive each committed state until they detach', (t) => {
  const store = openStore(t);
  const registry = new OrchestratorRunRegistry(store);
  const run = createRun(store);
  const seen: string[] = [];
  const detach = registry.subscribe(run.runId, (state) => seen.push(state.phase));
  registry.publish(store.update(run.runId, run.revision, { phase: 'validating_plan' }, { message: 'Validating plan.' }));
  detach();
  registry.publish(store.read(run.runId));
  assert.deepEqual(seen, ['validating_plan']);
});
