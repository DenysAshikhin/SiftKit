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
import type { SiftConfig } from '../src/config/types.ts';
import { fitsBeside, planDispatch, type DispatchRequest } from '../src/orchestrator/scheduler.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const READ_A = makeOrchestratorTask({ id: 'read-a' });
const READ_B = makeOrchestratorTask({ id: 'read-b' });
const WRITE = makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] });
const WRITE_2 = makeOrchestratorTask({ id: 'write-2', workerPresetId: 'repo-agent', writePaths: ['src/b.ts'] });
const AFTER_WRITE = makeOrchestratorTask({ id: 'after-write', dependsOn: ['write'] });
const PLAN = makeOrchestratorPlan([READ_A, WRITE, WRITE_2, READ_B, AFTER_WRITE]);

/** The default config with every worker on the active model, which has `slots` parallel slots. */
function configWithSlots(slots: number): SiftConfig {
  const config = getDefaultConfig();
  getActiveModelPreset(config).ParallelSlots = slots;
  return config;
}

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

function dispatch(input: { slots?: number; config?: SiftConfig; requested: DispatchRequest[];
  statuses?: Record<string, OrchestratorTaskStatus>; attempts?: OrchestratorAttempt[] }) {
  return planDispatch({ config: input.config ?? configWithSlots(input.slots ?? 3), plan: PLAN, taskStates: states(input.statuses),
    attempts: input.attempts ?? [], requested: input.requested });
}

const implement = (...tasks: OrchestratorTask[]): DispatchRequest[] => tasks.map((task) => ({ task, purpose: 'implementation' }));

test('children start together only within the parallel slots of their worker model; the rest queue with a warning', () => {
  const together = dispatch({ slots: 2, requested: implement(READ_A, WRITE) });
  assert.deepEqual([together.problems, together.start.map(({ task }) => task.id), together.queued, together.warnings],
    [[], ['read-a', 'write'], [], []]);
  const model = getActiveModelPreset(configWithSlots(1)).id;
  const { problems, start, queued, warnings, schedule } = dispatch({ slots: 1, requested: implement(READ_A, READ_B) });
  assert.deepEqual(problems, []);
  assert.deepEqual([start.map(({ task }) => task.id), queued.map(({ task }) => task.id)], [['read-a'], ['read-b']]);
  assert.deepEqual(warnings, [`Model ${model} has only 1 parallel slot, so read-a, read-b ran in sequence, not in parallel.`]);
  assert.deepEqual(schedule.waits.find((entry) => entry.taskId === 'read-b')?.wait, { kind: 'model_slot', modelId: model },
    'a queued child shows why it waits');
});

test('a queued child starts once a running child frees its model slot', () => {
  const config = configWithSlots(1);
  assert.equal(fitsBeside(config, READ_B, [READ_A]), false);
  assert.equal(fitsBeside(config, READ_B, []), true);
  assert.equal(fitsBeside(configWithSlots(2), READ_B, [READ_A]), true);
});

test('one writer runs beside a reader, but two writers never start together', () => {
  assert.deepEqual(dispatch({ requested: implement(WRITE, READ_A) }).problems, []);
  assert.deepEqual(dispatch({ requested: implement(WRITE, WRITE_2) }).problems,
    ["Task 'write-2' cannot start: another task in this dispatch already changes files."]);
});

test('workers on different models count against their own model slots', () => {
  const config = configWithSlots(1);
  const alternate = { ...getActiveModelPreset(config), id: 'exl3-alt', ParallelSlots: 1 };
  config.Server.ModelPresets.Presets.push(alternate);
  const agent = config.Presets.find((preset) => preset.id === 'repo-agent');
  assert.ok(agent);
  agent.modelPresetId = alternate.id;
  const { problems, schedule } = dispatch({ config, requested: implement(READ_A, WRITE) });
  assert.deepEqual(problems, [], 'one slot on each model');
  assert.deepEqual(schedule.models, [{ modelId: getActiveModelPreset(config).id, slots: 1, used: 1 }, { modelId: 'exl3-alt', slots: 1, used: 1 }]);
  assert.deepEqual(schedule.waits.find((entry) => entry.taskId === 'write-2')?.wait, { kind: 'writer_slot' });
});

test('a dependent starts only once its predecessor completed, not while it runs, awaits review, or failed', () => {
  for (const status of ['pending', 'running', 'reviewing', 'failed'] as const) {
    assert.deepEqual(dispatch({ requested: implement(AFTER_WRITE), statuses: { write: status } }).problems,
      ["Task 'after-write' cannot start: its dependencies are not complete: write."], status);
  }
  assert.deepEqual(dispatch({ requested: implement(AFTER_WRITE), statuses: { write: 'completed' } }).problems, []);
});

test('an implementation needs a pending or reviewed task and an attempt left', () => {
  assert.deepEqual(dispatch({ requested: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled')] }).problems, [], 'a retry after a failed review');
  assert.deepEqual(dispatch({ requested: implement(WRITE), statuses: { write: 'completed' } }).problems,
    ["Task 'write' is completed; implementation work needs it pending or reviewing."]);
  assert.deepEqual(dispatch({ requested: implement(WRITE), statuses: { write: 'reviewing' },
    attempts: [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')] }).problems,
  ["Task 'write' used all 2 implementation attempts."]);
});

test('a fix needs a reviewed or completed task with a settled attempt, and has its own attempt budget', () => {
  const fix: DispatchRequest[] = [{ task: WRITE, purpose: 'fix' }];
  const settled = [attempt(WRITE, 'implementation', 1, 'settled'), attempt(WRITE, 'implementation', 2, 'settled')];
  assert.deepEqual(dispatch({ requested: fix, statuses: { write: 'completed' }, attempts: settled }).problems, [],
    'implementation attempts never consume the fix budget');
  assert.deepEqual(dispatch({ requested: fix, statuses: { write: 'pending' } }).problems,
    ["Task 'write' is pending; fix work needs it reviewing or completed."]);
  assert.deepEqual(dispatch({ requested: fix, statuses: { write: 'reviewing' }, attempts: [attempt(WRITE, 'implementation', 1, 'abandoned')] }).problems,
    ["Task 'write' has no settled attempt to fix."]);
  assert.deepEqual(dispatch({ requested: fix, statuses: { write: 'reviewing' },
    attempts: [...settled, attempt(WRITE, 'fix', 1, 'settled'), attempt(WRITE, 'fix', 2, 'settled')] }).problems,
  ["Task 'write' used all 2 fix attempts."]);
});

test('a task appears once per dispatch', () => {
  assert.deepEqual(dispatch({ requested: implement(READ_A, READ_A) }).problems, ["Task 'read-a' appears twice in this dispatch."]);
});

test('the schedule records every claim, the slots this dispatch holds, and why each other pending task waits', () => {
  const config = configWithSlots(2);
  const model = getActiveModelPreset(config);
  const { schedule } = dispatch({ config, requested: implement(WRITE, READ_A) });
  assert.deepEqual(schedule.claims.map((claim) => [claim.taskId, claim.mutating]),
    [['read-a', false], ['write', true], ['write-2', true], ['read-b', false], ['after-write', false]]);
  assert.ok(schedule.claims.every((claim) => claim.modelId === model.id && claim.contextTokens === model.NumCtx));
  assert.deepEqual([schedule.models, schedule.writerUsed], [[{ modelId: model.id, slots: 2, used: 2 }], true]);
  assert.deepEqual(schedule.waits, [
    { taskId: 'write-2', wait: { kind: 'writer_slot' } },
    { taskId: 'read-b', wait: { kind: 'model_slot', modelId: model.id } },
    { taskId: 'after-write', wait: { kind: 'dependencies', taskIds: ['write'] } },
  ], 'dependencies are checked before slots; requested tasks never wait');
});
