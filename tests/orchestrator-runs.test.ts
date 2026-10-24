import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorActivity, OrchestratorRunState } from '@siftkit/contracts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import {
  OrchestratorRunRegistry,
  RepositoryGate,
  type OrchestratorLiveRun,
  type RepositoryLease,
} from '../src/status-server/orchestrator-runs.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const NO_CHILDREN = { markNotResumable: (_runId: string) => undefined };

function openStore(t: TestContext): OrchestratorRunStore {
  const dbPath = path.join(createManagedTempDir('siftkit-orchestrator-runs-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  return new OrchestratorRunStore(getRuntimeDatabase(dbPath));
}

function createRun(store: OrchestratorRunStore): OrchestratorRunState {
  return store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-orchestrator-runs-repo-'), presetId: 'orchestrator',
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
  readonly runId: string;
  private readonly onAbort: () => void;

  constructor(runId: string, onAbort: () => void = () => {}) {
    this.runId = runId;
    this.onAbort = onAbort;
  }
  abort(reason: string): void {
    this.abortReason = reason;
    this.onAbort();
    this.finish();
  }
  decide(): boolean {
    return false;
  }
  activitySnapshot(): OrchestratorActivity {
    return { runId: this.runId, schedule: null, parent: null, children: [] };
  }
}

test('shared leases overlap; an exclusive waits for them and blocks later readers until it releases', async () => {
  const repo = createManagedTempDir('siftkit-gate-');
  const gate = new RepositoryGate();
  const signal = new AbortController().signal;
  const readerA = await gate.acquire(repo, 'shared', null, signal);
  const readerB = await gate.acquire(repo, 'shared', null, signal);
  const writer = gate.acquire(repo, 'exclusive', null, signal);
  const lateReader = gate.acquire(repo, 'shared', null, signal);
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

test('an owned exclusive lease overlaps only its own run\'s readers; other owners and a second exclusive wait', async () => {
  const repo = createManagedTempDir('siftkit-gate-owned-');
  const gate = new RepositoryGate();
  const signal = new AbortController().signal;
  const writer = await gate.acquire(repo, 'exclusive', 'run-a', signal);
  const ownReader = await settle(gate.acquire(repo, 'shared', 'run-a', signal));
  assert.notEqual(ownReader, 'pending', 'the same run reads beside its writer');
  const otherReader = gate.acquire(repo, 'shared', 'run-b', signal);
  assert.equal(await settle(otherReader), 'pending', 'another run never reads beside this writer');
  writer.release();
  if (ownReader !== 'pending') ownReader.release();
  const otherLease = await otherReader;
  const secondWriter = gate.acquire(repo, 'exclusive', 'run-a', signal);
  assert.equal(await settle(secondWriter), 'pending', 'a writer waits for another owner\'s reader');
  otherLease.release();
  const secondLease = await secondWriter;
  const thirdWriter = gate.acquire(repo, 'exclusive', 'run-a', signal);
  assert.equal(await settle(thirdWriter), 'pending', 'two exclusive leases never overlap, even in one run');
  const unowned = gate.acquire(repo, 'shared', null, signal);
  secondLease.release();
  const thirdLease = await thirdWriter;
  assert.equal(await settle(unowned), 'pending', 'an unowned reader never shares with an exclusive lease');
  thirdLease.release();
  (await unowned).release();
});

test('path aliases share one repository key and an unknown root fails loudly', async () => {
  const repo = createManagedTempDir('siftkit-gate-alias-');
  const link = `${repo}-link`;
  fs.symlinkSync(repo, link, 'junction');
  const gate = new RepositoryGate();
  const signal = new AbortController().signal;
  const writer = await gate.acquire(repo, 'exclusive', null, signal);
  const alias = `${repo.replace(/\\/gu, '/')}/sub/..`;
  for (const candidate of [alias, link]) {
    assert.equal(await settle(gate.acquire(candidate, 'shared', null, signal).then((lease: RepositoryLease) => {
      lease.release();
      return 'granted';
    })), 'pending', candidate);
  }
  writer.release();
  fs.rmSync(link, { force: true, recursive: true });
  await assert.rejects(gate.acquire(path.join(repo, 'missing'), 'shared', null, signal), /ENOENT/u);
});

test('an aborted waiter leaves the queue without ever holding the repository', async () => {
  const repo = createManagedTempDir('siftkit-gate-abort-');
  const gate = new RepositoryGate();
  const writer = await gate.acquire(repo, 'exclusive', null, new AbortController().signal);
  const controller = new AbortController();
  const waiting = gate.acquire(repo, 'exclusive', null, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/u);
  writer.release();
  const next = await gate.acquire(repo, 'exclusive', null, new AbortController().signal);
  next.release();
});

test('startup marks every stored nonterminal parent interrupted and never redispatches it', (t) => {
  const store = openStore(t);
  const active = createRun(store);
  const registry = new OrchestratorRunRegistry(store);
  assert.deepEqual(registry.reconcileOnStartup(NO_CHILDREN), [active.runId]);
  const state = store.read(active.runId);
  assert.equal(state.phase, 'interrupted');
  assert.match(state.failure?.message ?? '', /server restarted/iu);
  assert.deepEqual(registry.reconcileOnStartup(NO_CHILDREN), []);
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
  registry.publish(store.update(run.runId, run.revision, { phase: 'executing' }, { message: 'Executing.' }));
  detach();
  registry.publish(store.read(run.runId));
  assert.deepEqual(seen, ['executing']);
});

test('startup marks the running children of an interrupted parent not resumable', (t) => {
  const store = openStore(t);
  const created = createRun(store);
  const plan = makeOrchestratorPlan([makeOrchestratorTask()]);
  let state = store.savePlan(created.runId, created.revision, plan, 'docs/plan.md', 'hash');
  const task = plan.tasks[0];
  assert.ok(task);
  const attempt = store.reserveAttempt(state.runId, state.revision, task.id,
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task, instruction: 'Implement it.' });
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
  const marked: string[] = [];

  new OrchestratorRunRegistry(store).reconcileOnStartup({ markNotResumable: (runId: string) => { marked.push(runId); } });

  assert.deepEqual(marked, [attempt.childRunId]);
  assert.deepEqual(store.read(state.runId).attempts.map((entry) => entry.status), ['abandoned']);
});

test('activity reaches only its own run\'s subscribers, until they detach', (t) => {
  const registry = new OrchestratorRunRegistry(openStore(t));
  const runA = randomUUID();
  const runB = randomUUID();
  const seen: string[] = [];
  const detach = registry.subscribeActivity(runA, (activity) => seen.push(activity.runId));
  registry.publishActivity({ runId: runA, schedule: null, parent: null, children: [] });
  registry.publishActivity({ runId: runB, schedule: null, parent: null, children: [] });
  detach();
  registry.publishActivity({ runId: runA, schedule: null, parent: null, children: [] });
  assert.deepEqual(seen, [runA]);
});
