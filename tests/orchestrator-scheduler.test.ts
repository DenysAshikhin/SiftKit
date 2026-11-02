import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrchestratorAttemptSchema,
  type OrchestratorAttempt,
  type OrchestratorChildPurpose,
  type OrchestratorTask,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';
import { getActiveModelPreset } from '../src/config/getters.ts';
import { describeSchedule, dispatchProblem, orchestratorWorkers, type DispatchRequest } from '../src/orchestrator/scheduler.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const WRITE = makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] });
const WRITE_2 = makeOrchestratorTask({ id: 'write-2', workerPresetId: 'repo-agent', writePaths: ['src/b.ts'] });
const AFTER_WRITE = makeOrchestratorTask({ id: 'after-write', dependsOn: ['write'], workerPresetId: 'repo-agent', writePaths: ['src/c.ts'] });
const PLAN = makeOrchestratorPlan([WRITE, WRITE_2, AFTER_WRITE]);
const CONFIG = getDefaultConfig();

function states(overrides: Record<string, OrchestratorTaskStatus> = {}): OrchestratorTaskState[] {
  return PLAN.tasks.map((task) => ({ taskId: task.id, status: overrides[task.id] ?? 'pending', review: null }));
}

function attempt(task: OrchestratorTask, purpose: OrchestratorChildPurpose, number: number, status: OrchestratorAttempt['status']): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose, attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`, status, result: null,
    reservedAtUtc: '2026-10-11T12:00:00.000Z',
    work: { kind: purpose, planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

function dispatch(input: { request: DispatchRequest; statuses?: Record<string, OrchestratorTaskStatus>; attempts?: OrchestratorAttempt[] }) {
  return dispatchProblem({ taskStates: states(input.statuses), attempts: input.attempts ?? [], request: input.request });
}

const implement = (task: OrchestratorTask): DispatchRequest => ({ task, purpose: 'implementation' });

test('a dependent starts only once its predecessor completed, not while it runs, awaits review, or failed', () => {
  for (const status of ['pending', 'running', 'reviewing', 'failed'] as const) {
    assert.equal(dispatch({ request: implement(AFTER_WRITE), statuses: { write: status } }),
      "Task 'after-write' cannot start: its dependencies are not complete: write.", status);
  }
  assert.equal(dispatch({ request: implement(AFTER_WRITE), statuses: { write: 'completed' } }), null);
});

test('an implementation needs a pending or reviewed task and an attempt left', () => {
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled')] }), null, 'a retry after a failed review');
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'completed' } }),
    "Task 'write' is completed; implementation work needs it pending or reviewing.");
  assert.equal(dispatch({ request: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')] }),
  "Task 'write' used all 2 implementation attempts.");
});

test('a fix needs a reviewed or completed task with a settled attempt, and has its own attempt budget', () => {
  const fix: DispatchRequest = { task: WRITE, purpose: 'fix' };
  const settled = [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')];
  assert.equal(dispatch({ request: fix, statuses: { write: 'completed' }, attempts: settled }), null,
    'implementation attempts never consume the fix budget');
  assert.equal(dispatch({ request: fix, statuses: { write: 'pending' } }),
    "Task 'write' is pending; fix work needs it reviewing or completed.");
  assert.equal(dispatch({ request: fix, statuses: { write: 'reviewing' }, attempts: [attempt(WRITE, 'implementation', 1, 'abandoned')] }),
    "Task 'write' has no settled attempt to fix.");
  assert.equal(dispatch({ request: fix, statuses: { write: 'reviewing' },
    attempts: [...settled, attempt(WRITE, 'fix', 1, 'settled'), attempt(WRITE, 'fix', 2, 'settled')] }),
  "Task 'write' used all 2 fix attempts.");
});

test('workers are the repo-agent presets that can change files, never a read-only or orchestrator preset', () => {
  const model = getActiveModelPreset(CONFIG);
  assert.deepEqual(orchestratorWorkers(CONFIG).map((worker) => [worker.preset.id, worker.model.id]), [['repo-agent', model.id]]);
});

test('the schedule records the claim of every task on its worker model and the unmet dependencies of each pending task', () => {
  const model = getActiveModelPreset(CONFIG);
  const schedule = describeSchedule(orchestratorWorkers(CONFIG), PLAN, states({ 'write-2': 'running' }));
  assert.deepEqual(schedule, {
    claims: PLAN.tasks.map((task) => ({ taskId: task.id, modelId: model.id, contextTokens: model.NumCtx })),
    waits: [{ taskId: 'after-write', dependencies: ['write'] }],
  }, 'a task whose dependencies are met waits for nothing but its dispatch');
});

test('a task whose preset is not a worker fails the schedule loudly', () => {
  assert.throws(() => describeSchedule([], PLAN, states()), /Task 'write' selects preset 'repo-agent', which is not a worker\./u);
});
