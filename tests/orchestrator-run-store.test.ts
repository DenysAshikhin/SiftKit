import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorChildWork, OrchestratorStartRequest } from '@siftkit/contracts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { seedRunLogThroughput } from './helpers/run-log-throughput.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

function openStore(t: TestContext): { store: OrchestratorRunStore; dbPath: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-orchestrator-store-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  return { store: new OrchestratorRunStore(getRuntimeDatabase(dbPath)), dbPath };
}

const REPO = createManagedTempDir('siftkit-orchestrator-store-repo-');

function startRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return { submissionId: randomUUID(), sessionId: null, repoRoot: REPO, presetId: 'orchestrator', approval: 'auto',
    task: 'Inspect the README.', planPath: null, ...overrides };
}

const PLAN = makeOrchestratorPlan([makeOrchestratorTask(), makeOrchestratorTask({ id: 'follow-up', dependsOn: ['inspect'] })]);

function work(kind: OrchestratorChildWork['kind'] = 'implementation', taskId = 'inspect'): OrchestratorChildWork {
  const task = PLAN.tasks.find((entry) => entry.id === taskId);
  assert.ok(task);
  return { kind, planPath: 'docs/plan.md', planHash: 'hash-1', task, instruction: kind === 'fix' ? 'Fix the finding.' : 'Implement it.' };
}

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
  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work()), /stale revision/u);
});

test('each purpose allows two attempts and implementation attempts never consume the correction pool', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  const firstAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.read(state.runId);
  const secondAttempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.read(state.runId);
  assert.equal(firstAttempt.attempt, 1);
  assert.equal(secondAttempt.attempt, 2);
  assert.notEqual(firstAttempt.childRunId, secondAttempt.childRunId);
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work()), /attempt limit/u);

  const firstFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'));
  state = store.read(state.runId);
  const secondFix = store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix'));
  state = store.read(state.runId);
  assert.deepEqual([firstFix.purpose, firstFix.attempt, secondFix.attempt], ['fix', 1, 2]);
  assert.equal(secondFix.work.instruction, 'Fix the finding.');
  assert.throws(() => store.reserveAttempt(state.runId, state.revision, 'inspect', work('fix')),
    /Task 'inspect' reached the fix attempt limit/u);
});

test('attempt results settle exactly once and must name a reserved child', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
  const result = { taskId: 'inspect', purpose: 'implementation' as const, attempt: 1, childRunId: attempt.childRunId,
    workerStatus: 'completed' as const, workerOutput: 'done', report: null, outcome: 'passed' as const, submissions: 1,
    passed: true, checks: [], findings: [],
    changedPaths: [], changeDigest: null };
  state = store.recordAttemptResult(state.runId, state.revision, result);
  assert.equal(state.attempts[0]?.status, 'settled');
  assert.equal(store.readEvents(state.runId, 0).at(-1)?.message, 'Settled implementation attempt 1: passed.');
  assert.throws(() => store.recordAttemptResult(state.runId, state.revision, result), /already settled/u);
  assert.throws(() => store.recordAttemptResult(state.runId, state.revision, { ...result, childRunId: randomUUID() }),
    /Unknown orchestrator child/u);
});

test('committed events replay in increasing sequence from any cursor', (t) => {
  const { store } = openStore(t);
  const state = planned(store);
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  const events = store.readEvents(state.runId, 0);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[2]?.childRunId, attempt.childRunId);
  assert.deepEqual(store.readEvents(state.runId, 2).map((event) => event.sequence), [3]);
});

test('a restart keeps both budgets; interrupted runs reject further changes', (t) => {
  const { store, dbPath } = openStore(t);
  let state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
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
  assert.throws(() => reopened.reserveAttempt(state.runId, state.revision, 'inspect', work()), /is interrupted/u);
});

test('a saved plan starts every task pending with no review, and keeps the state of tasks it still names', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  assert.deepEqual(state.tasks, [{ taskId: 'inspect', status: 'pending', review: null }, { taskId: 'follow-up', status: 'pending', review: null }]);
  state = store.update(state.runId, state.revision, { tasks: state.tasks.map((task) => (task.taskId === 'inspect'
    ? { ...task, status: 'completed' } : task)) }, { message: 'Task inspect: completed.' });
  const extended = makeOrchestratorPlan([...PLAN.tasks, makeOrchestratorTask({ id: 'last' })]);
  state = store.savePlan(state.runId, state.revision, extended, 'docs/plan.md', 'hash-2');
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['inspect', 'completed'], ['follow-up', 'pending'], ['last', 'pending']]);
});

test('a changed plan cannot drop or rename a task that already has attempts', (t) => {
  const { store } = openStore(t);
  const state = planned(store);
  store.reserveAttempt(state.runId, state.revision, 'inspect', work());
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

test('a stopped run aborts its open tasks and abandons unsettled attempts; untouched tasks stay pending', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  state = store.update(state.runId, state.revision, { tasks: state.tasks.map((task) => (task.taskId === 'inspect'
    ? { ...task, status: 'running' } : task)) }, { message: 'Task inspect: running.' });
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', work());
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);

  const aborted = store.update(state.runId, state.revision, { phase: 'aborted' }, { message: 'Aborted by user.' });

  assert.deepEqual(aborted.tasks.map((task) => [task.taskId, task.status]), [['inspect', 'aborted'], ['follow-up', 'pending']]);
  assert.deepEqual(aborted.attempts.map((entry) => entry.status), ['abandoned']);
});

// An orchestrator session has no chat turns; its speed is its own conversation's and children's inference.
test('a run reports the merged throughput of its own conversation runs and its children, ignoring unrelated runs', (t) => {
  const { store, dbPath } = openStore(t);
  const state = planned(store);
  const parentRunId = randomUUID();
  store.update(state.runId, state.revision, { parentRunIds: [parentRunId] }, { message: 'Parent run recorded.' });
  const attempt = store.reserveAttempt(state.runId, state.revision + 1, 'inspect', work());
  const database = getRuntimeDatabase(dbPath);
  seedRunLogThroughput(database, parentRunId, [1_000, 1_000], [100, 2_000]);
  seedRunLogThroughput(database, attempt.childRunId, [3_000, 1_000], [300, 2_000]);
  seedRunLogThroughput(database, randomUUID(), [9_000, 1], [9_000, 1]);

  const throughput = store.readThroughput(state.runId);
  assert.equal(throughput.pp.tokenCount, 4_000);
  assert.equal(throughput.pp.durationMs, 2_000);
  assert.equal(throughput.decode.tokenCount, 400);
  assert.equal(throughput.decode.durationMs, 4_000);
});
