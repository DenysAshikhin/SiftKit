import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorChildWork, OrchestratorStartRequest } from '@siftkit/contracts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function openStore(t: TestContext): { store: OrchestratorRunStore; dbPath: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-orchestrator-store-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  return { store: new OrchestratorRunStore(getRuntimeDatabase(dbPath)), dbPath };
}

const REPO = createManagedTempDir('siftkit-orchestrator-store-repo-');

function startRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return { submissionId: randomUUID(), repoRoot: REPO, presetId: 'orchestrator', approval: 'auto',
    task: 'Inspect the README.', planPath: null, ...overrides };
}

const PLAN = makeOrchestratorPlan([makeOrchestratorTask(), makeOrchestratorTask({ id: 'follow-up', dependsOn: ['inspect'] })]);

function implementationWork(taskId = 'inspect'): OrchestratorChildWork {
  const task = PLAN.tasks.find((entry) => entry.id === taskId);
  assert.ok(task);
  return { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash-1', task };
}

const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const DRIFT_WORK: OrchestratorChildWork = {
  kind: 'drift_fix', taskId: 'inspect', objective: 'Remove the duplicated path.', changeDigest: 'digest-1',
  findings: [{ id: 'D1', title: 'Duplicate', purpose: 'One path', directive: 'Keep logic DRY.',
    evidence: [{ path: 'src/a.ts', line: 1, snippet: 'x()' }], impact: 'Divergence.', fix: 'Merge them.',
    affectedPaths: ['src/a.ts'], verification: [CHECK] }],
  allowedPaths: ['src/a.ts'], verification: [CHECK],
};

function planned(store: OrchestratorRunStore, request = startRequest()) {
  const created = store.create(request);
  return store.savePlan(created.runId, created.revision, PLAN, 'docs/plan.md', 'hash-1');
}

test('the same submission and payload returns the same parent; a different payload is rejected', (t) => {
  const { store } = openStore(t);
  const request = startRequest();
  const first = store.create(request);
  const second = store.create(request);
  assert.equal(second.runId, first.runId);
  assert.equal(second.revision, first.revision);
  assert.throws(() => store.create({ ...request, task: 'Something else.' }), /already used for a different orchestrator request/u);
});

test('two reservations against one revision cannot both succeed', (t) => {
  const { store } = openStore(t);
  const state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork()), /stale revision/u);
});

test('each purpose allows two attempts and implementation attempts never consume the correction pool', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  const firstAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  state = store.read(state.runId);
  const secondAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  state = store.read(state.runId);
  assert.equal(firstAttempt.attempt, 1);
  assert.equal(secondAttempt.attempt, 2);
  assert.notEqual(firstAttempt.childRunId, secondAttempt.childRunId);
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork()), /attempt limit/u);

  const firstFix = store.reserveAttempt(state.runId, state.revision, 'inspect', DRIFT_WORK);
  state = store.read(state.runId);
  const secondFix = store.reserveAttempt(state.runId, state.revision, 'inspect', { ...DRIFT_WORK, changeDigest: 'digest-2' });
  state = store.read(state.runId);
  assert.deepEqual([firstFix.purpose, firstFix.attempt, secondFix.attempt], ['drift_fix', 1, 2]);
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', { ...DRIFT_WORK, changeDigest: 'digest-3' }),
    /Task 'inspect' reached the drift_fix attempt limit/u);
});

test('attempt results settle exactly once and must name a reserved child', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
  const result = { taskId: 'inspect', purpose: 'implementation' as const, attempt: 1, childRunId: attempt.childRunId,
    workerStatus: 'completed' as const, workerOutput: 'done', passed: true, checks: [], findings: [],
    changedPaths: [], scopeViolations: [], changeDigest: null };
  state = store.recordAttemptResult(state.runId, state.revision, result);
  assert.equal(state.attempts[0]?.status, 'settled');
  assert.throws(() => store.recordAttemptResult(state.runId, state.revision, result), /already settled/u);
  assert.throws(() => store.recordAttemptResult(state.runId, state.revision, { ...result, childRunId: randomUUID() }),
    /Unknown orchestrator child/u);
});

test('committed events replay in increasing sequence from any cursor', (t) => {
  const { store } = openStore(t);
  const state = planned(store);
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  const events = store.readEvents(state.runId, 0);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[2]?.childRunId, attempt.childRunId);
  assert.deepEqual(store.readEvents(state.runId, 2).map((event) => event.sequence), [3]);
});

test('a restart keeps both budgets; interrupted runs reject further changes', (t) => {
  const { store, dbPath } = openStore(t);
  let state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  closeAllRuntimeDatabases();
  const reopened = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  state = reopened.read(state.runId);
  assert.equal(state.attempts.length, 1);
  assert.deepEqual(reopened.listActive().map((entry) => entry.runId), [state.runId]);
  state = reopened.markInterrupted(state.runId, state.revision, 'Server restarted during the run.');
  assert.equal(state.phase, 'interrupted');
  assert.equal(state.failure?.code, 'interrupted');
  assert.equal(state.attempts.length, 1, 'an uncertain attempt is kept, never redispatched');
  assert.deepEqual(reopened.listActive(), []);
  assert.throws(() => reopened.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork()), /is interrupted/u);
});

test('a changed plan cannot drop or rename a task that already has attempts', (t) => {
  const { store } = openStore(t);
  const state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  const current = store.read(state.runId);
  const renamed = makeOrchestratorPlan([makeOrchestratorTask({ id: 'inspect-renamed' })]);
  assert.throws(() => store.savePlan(current.runId, current.revision, renamed, 'docs/plan.md', 'hash-2'),
    /Plan changed: task 'inspect' already has attempts; start a new run/u);
});

test('a malformed stored row fails loudly instead of reading as a default', (t) => {
  const { store, dbPath } = openStore(t);
  const state = planned(store);
  getRuntimeDatabase(dbPath).prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?').run('{"phase":"nope"}', state.runId);
  assert.throws(() => store.read(state.runId));
  assert.throws(() => store.read(randomUUID()), /Unknown orchestrator run/u);
});

test('recent runs are found by repository identity, not by how its path is spelled', (t) => {
  const { store } = openStore(t);
  const first = store.create(startRequest());
  store.create(startRequest({ repoRoot: createManagedTempDir('siftkit-orchestrator-store-other-') }));
  const second = store.create(startRequest({ repoRoot: `${REPO}${path.sep}` }));
  const spelled = `${REPO}${path.sep}.${path.sep}`;
  assert.deepEqual(store.listRecent(spelled, 10).map((state) => state.runId), [second.runId, first.runId]);
  assert.deepEqual(store.listRecent(REPO, 1).map((state) => state.runId), [second.runId]);
  assert.throws(() => store.create(startRequest({ repoRoot: path.join(REPO, 'missing') })), /ENOENT/u);
});
