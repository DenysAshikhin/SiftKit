import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorTask, OrchestratorTaskState, OrchestratorTaskStatus } from '@siftkit/contracts';
import { getActiveModelPreset } from '../src/config/getters.ts';
import { schedulePass } from '../src/orchestrator/scheduler.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const READ_A = makeOrchestratorTask({ id: 'read-a' });
const READ_B = makeOrchestratorTask({ id: 'read-b' });
const WRITE = makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] });
const WRITE_2 = makeOrchestratorTask({ id: 'write-2', workerPresetId: 'repo-agent', writePaths: ['src/b.ts'] });
const AFTER_WRITE = makeOrchestratorTask({ id: 'after-write', dependsOn: ['write'] });
const PLAN = makeOrchestratorPlan([READ_A, WRITE, WRITE_2, READ_B, AFTER_WRITE]);

/** The default config with every worker on the active model, which has `slots` parallel slots. */
function configWithSlots(slots: number) {
  const config = getDefaultConfig();
  getActiveModelPreset(config).ParallelSlots = slots;
  return config;
}

function states(overrides: Record<string, OrchestratorTaskStatus> = {}): OrchestratorTaskState[] {
  return PLAN.tasks.map((task) => ({ taskId: task.id, status: overrides[task.id] ?? 'pending', driftReview: null, reviewedDigests: [] }));
}

function pass(slots: number, active: OrchestratorTask[], overrides: Record<string, OrchestratorTaskStatus> = {}) {
  const running = Object.fromEntries(active.map((task) => [task.id, 'running' as const]));
  return schedulePass({ config: configWithSlots(slots), plan: PLAN, taskStates: states({ ...running, ...overrides }), active });
}

function start(slots: number, active: OrchestratorTask[], overrides: Record<string, OrchestratorTaskStatus> = {}): string[] {
  return pass(slots, active, overrides).start.map((task) => task.id);
}

test('tasks start up to the parallel slots of their worker model, one at a time with one slot', () => {
  assert.deepEqual(start(1, []), ['read-a']);
  assert.deepEqual(start(1, [READ_A]), []);
  assert.deepEqual(start(2, []), ['read-a', 'write']);
  assert.deepEqual(start(5, []), ['read-a', 'write', 'read-b']);
  assert.deepEqual(start(3, [READ_A]), ['write', 'read-b']);
});

test('one writer runs beside readers, but two writers never overlap', () => {
  assert.deepEqual(start(3, [WRITE]), ['read-a', 'read-b'], 'readers start beside the active writer');
  assert.deepEqual(start(3, [READ_A, READ_B], { 'write': 'completed' }), ['write-2'], 'a writer starts beside active readers');
  assert.deepEqual(start(5, [WRITE], { 'read-a': 'completed', 'read-b': 'completed' }), [], 'the second writer waits');
});

test('workers on different models count against their own model slots', () => {
  const config = configWithSlots(1);
  const alternate = { ...getActiveModelPreset(config), id: 'exl3-alt', ParallelSlots: 1 };
  config.Server.ModelPresets.Presets.push(alternate);
  const agent = config.Presets.find((preset) => preset.id === 'repo-agent');
  assert.ok(agent);
  agent.modelPresetId = alternate.id;
  const { start: started, schedule } = schedulePass({ config, plan: PLAN, taskStates: states(), active: [] });
  assert.deepEqual(started.map((task) => task.id), ['read-a', 'write'], 'one slot on each model');
  assert.deepEqual(schedule.models, [{ modelId: getActiveModelPreset(config).id, slots: 1, used: 1 }, { modelId: 'exl3-alt', slots: 1, used: 1 }]);
  assert.deepEqual(schedule.waits.find((entry) => entry.taskId === 'write-2')?.wait, { kind: 'writer_slot' });
});

test('a dependent starts only once its predecessor completed, not while it verifies or reviews drift', () => {
  const done = { 'read-a': 'completed', 'read-b': 'completed', 'write-2': 'completed' } as const;
  for (const status of ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending', 'failed'] as const) {
    assert.deepEqual(start(3, [], { ...done, write: status }), [], status);
  }
  assert.deepEqual(start(3, [], { ...done, write: 'completed' }), ['after-write']);
});

test('every pending task left waiting says why, in the order the scheduler checks', () => {
  const { schedule } = pass(2, [WRITE]);
  const model = getActiveModelPreset(configWithSlots(2)).id;
  assert.deepEqual(schedule.waits, [
    { taskId: 'write-2', wait: { kind: 'writer_slot' } },
    { taskId: 'read-b', wait: { kind: 'model_slot', modelId: model } },
    { taskId: 'after-write', wait: { kind: 'dependencies', taskIds: ['write'] } },
  ], 'read-a takes the second slot; dependencies are checked before slots');
});

test('the schedule reports every claim and the slots held after the pass', () => {
  const config = configWithSlots(3);
  const model = getActiveModelPreset(config);
  const { schedule } = pass(3, [WRITE]);
  assert.deepEqual(schedule.claims.map((claim) => [claim.taskId, claim.mutating]),
    [['read-a', false], ['write', true], ['write-2', true], ['read-b', false], ['after-write', false]]);
  assert.ok(schedule.claims.every((claim) => claim.modelId === model.id && claim.contextTokens === model.NumCtx));
  assert.deepEqual([schedule.models, schedule.writerUsed], [[{ modelId: model.id, slots: 3, used: 3 }], true],
    'the active writer and the two readers it started beside');
  assert.deepEqual(pass(3, [], Object.fromEntries(PLAN.tasks.map((task) => [task.id, 'completed']))).schedule.models,
    [{ modelId: model.id, slots: 3, used: 0 }], 'nothing is held once every task finished');
});
