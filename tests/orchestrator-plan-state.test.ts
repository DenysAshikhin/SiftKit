import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt, type OrchestratorTask, type OrchestratorTaskStatus } from '@siftkit/contracts';
import { activeApproach, changeApproach, finishProblem, reviseTasks, startPlan, type PlanState, type PlanTransition } from '../src/orchestrator/plan-state.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const AT = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T11:00:00.000Z';
const A = makeOrchestratorTask({ id: 'a', title: 'Task A' });
const B = makeOrchestratorTask({ id: 'b', title: 'Task B', dependsOn: ['a'] });
const C = makeOrchestratorTask({ id: 'c', title: 'Task C' });
const EMPTY: PlanState = { plan: null, tasks: [], approaches: [], retiredTasks: [] };

function attempt(task: OrchestratorTask, number = 1): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose: 'implementation', attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`,
    status: 'settled', result: null, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

/** The state a transition produced; a refused transition fails the test with its problems. */
function applied(transition: PlanTransition): PlanState {
  assert.ok(transition.ok, transition.ok ? '' : transition.problems.join(' '));
  return transition.next;
}

function planned(): PlanState {
  return applied(startPlan(EMPTY, makeOrchestratorPlan([A, B]), AT));
}

function withStatus(state: PlanState, taskId: string, status: OrchestratorTaskStatus): PlanState {
  return { ...state, tasks: state.tasks.map((task) => (task.taskId === taskId ? { ...task, status } : task)) };
}

test('the first plan opens approach 1 with every task pending, and a second plan is refused', () => {
  const state = planned();
  assert.deepEqual(state.approaches, [{ number: 1, title: 'Initial plan', startedAtUtc: AT, outcome: null }]);
  assert.deepEqual(state.tasks, [
    { taskId: 'a', status: 'pending', review: null, approach: 1 }, { taskId: 'b', status: 'pending', review: null, approach: 1 }]);
  assert.equal(activeApproach(state)?.number, 1);
  assert.equal(activeApproach(EMPTY), null);
  assert.deepEqual(startPlan(state, makeOrchestratorPlan([A]), LATER),
    { ok: false, problems: ['A plan is already saved; change it with update_tasks.'] });
});

test('update_tasks patches by id, adds tasks to the active approach, and refuses unknown and reused ids', () => {
  const state = applied(reviseTasks(planned(), { update: [{ taskId: 'a', set: { title: 'Renamed' } }], add: [C], retire: [] }, [], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.title]), [['a', 'Renamed'], ['b', 'Task B'], ['c', 'Task C']]);
  assert.deepEqual(state.tasks.at(-1), { taskId: 'c', status: 'pending', review: null, approach: 1 });
  assert.deepEqual(
    reviseTasks(planned(), { update: [{ taskId: 'nowhere', set: {} }], add: [A], retire: [{ taskId: 'gone', reason: 'x' }] }, [], LATER),
    { ok: false, problems: ["Task 'nowhere' is not in the saved plan.", "Task 'gone' is not in the saved plan.",
      "Task id 'a' was already used in this run; give the new task a new id."] });
  assert.deepEqual(reviseTasks(EMPTY, { update: [], add: [A], retire: [] }, [], LATER),
    { ok: false, problems: ['Save a plan first with save_plan.'] });
});

test('a retired task that ran stays on record with its reason, one that never ran is dropped, and a dependent must follow or be re-pointed', () => {
  const failed = withStatus(planned(), 'a', 'failed');
  assert.deepEqual(reviseTasks(failed, { update: [], add: [], retire: [{ taskId: 'a', reason: 'Wrong file.' }] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task 'b' depends on a, which this call retires: retire it too, or set its dependsOn."] });
  const replacement = makeOrchestratorTask({ id: 'a-2', title: 'Task A again' });
  const state = applied(reviseTasks(failed, { update: [{ taskId: 'b', set: { dependsOn: ['a-2'] } }], add: [replacement],
    retire: [{ taskId: 'a', reason: 'Wrong file.' }] }, [attempt(A)], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.dependsOn]), [['b', ['a-2']], ['a-2', []]]);
  assert.deepEqual(state.retiredTasks,
    [{ taskId: 'a', title: 'Task A', approach: 1, status: 'failed', reason: 'Wrong file.', retiredAtUtc: LATER }]);
  assert.deepEqual(reviseTasks(state, { update: [], add: [A], retire: [] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task id 'a' was already used in this run; give the new task a new id."] });
  const dropped = applied(reviseTasks(planned(), { update: [], add: [], retire: [{ taskId: 'b', reason: 'Not needed.' }] }, [], LATER));
  assert.deepEqual([dropped.plan?.tasks.map((task) => task.id), dropped.retiredTasks], [['a'], []]);
});

test('keeping an approach closes its completed tasks and carries the rest into the next one', () => {
  const state = applied(changeApproach(withStatus(planned(), 'a', 'completed'),
    { lesson: 'A works; B needs another design.', rollback: false, title: 'Second design' }, [attempt(A)], LATER));
  assert.deepEqual(state.approaches, [
    { number: 1, title: 'Initial plan', startedAtUtc: AT,
      outcome: { kind: 'kept', lesson: 'A works; B needs another design.', endedAtUtc: LATER } },
    { number: 2, title: 'Second design', startedAtUtc: LATER, outcome: null }]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['a', 'completed', 1], ['b', 'pending', 2]]);
  assert.deepEqual([state.plan?.tasks.length, state.retiredTasks], [2, []]);
  assert.deepEqual(reviseTasks(state, { update: [{ taskId: 'a', set: { title: 'x' } }], add: [], retire: [] }, [attempt(A)], LATER),
    { ok: false, problems: ["Task 'a' was completed in approach 1, which has ended; it can no longer change. Add a task instead."] });
});

test('rolling back an approach drops all its tasks, records those that ran with the lesson, and keeps earlier approaches', () => {
  const kept = applied(changeApproach(withStatus(planned(), 'a', 'completed'),
    { lesson: 'A works.', rollback: false, title: 'Second' }, [attempt(A)], LATER));
  const second = applied(reviseTasks(kept, { update: [], add: [C], retire: [] }, [attempt(A)], LATER));
  const state = applied(changeApproach(withStatus(second, 'b', 'failed'),
    { lesson: 'B cannot work this way.', rollback: true, title: 'Third' }, [attempt(A), attempt(B, 2)], LATER));
  assert.deepEqual(state.plan?.tasks.map((task) => task.id), ['a']);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.approach]), [['a', 1]]);
  assert.deepEqual(state.retiredTasks,
    [{ taskId: 'b', title: 'Task B', approach: 2, status: 'failed', reason: 'B cannot work this way.', retiredAtUtc: LATER }]);
  assert.deepEqual(state.approaches.map((approach) => [approach.number, approach.outcome?.kind ?? 'active']),
    [[1, 'kept'], [2, 'rolled_back'], [3, 'active']]);
  assert.deepEqual(changeApproach(EMPTY, { lesson: 'x', rollback: true, title: 'y' }, [], LATER),
    { ok: false, problems: ['Save a plan first with save_plan.'] });
});

test('a finish needs a plan, at least one task, and every task complete', () => {
  assert.equal(finishProblem(EMPTY), 'No plan is saved; there is nothing to finish.');
  const state = withStatus(planned(), 'a', 'completed');
  assert.equal(finishProblem(withStatus(state, 'b', 'failed')),
    'Not every task is complete: b (failed). Retire a task that cannot be completed with update_tasks and add its replacement.');
  assert.equal(finishProblem(withStatus(state, 'b', 'completed')), null);
  const emptied = applied(changeApproach(planned(), { lesson: 'Nothing held.', rollback: true, title: 'Again' }, [], LATER));
  assert.equal(finishProblem(emptied), 'The plan has no tasks: add the next tasks with update_tasks.');
});
