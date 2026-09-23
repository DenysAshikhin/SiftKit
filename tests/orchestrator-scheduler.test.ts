import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorTaskState, OrchestratorTaskStatus } from '@siftkit/contracts';
import { selectTasksToStart } from '../src/orchestrator/scheduler.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.js';

const CONFIG = getDefaultConfig();
const READ_A = makeOrchestratorTask({ id: 'read-a' });
const READ_B = makeOrchestratorTask({ id: 'read-b' });
const READ_C = makeOrchestratorTask({ id: 'read-c' });
const WRITE = makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] });
const AFTER_WRITE = makeOrchestratorTask({ id: 'after-write', dependsOn: ['write'] });
const PLAN = makeOrchestratorPlan([READ_A, READ_B, WRITE, READ_C, AFTER_WRITE]);

function states(overrides: Record<string, OrchestratorTaskStatus> = {}): OrchestratorTaskState[] {
  return PLAN.tasks.map((task) => ({ taskId: task.id, status: overrides[task.id] ?? 'pending', driftReview: null, reviewedDigests: [] }));
}

function start(maxSubagents: number, active: { taskId: string; mutating: boolean }[], overrides: Record<string, OrchestratorTaskStatus> = {}): string[] {
  return selectTasksToStart({ config: CONFIG, plan: PLAN, taskStates: states(overrides), active, maxSubagents })
    .map((task) => task.id);
}

test('the default cap admits one task and a cap of three overlaps independent readers only', () => {
  assert.deepEqual(start(1, []), ['read-a']);
  assert.deepEqual(start(3, []), ['read-a', 'read-b', 'read-c']);
  assert.deepEqual(start(3, [{ taskId: 'read-a', mutating: false }], { 'read-a': 'running' }), ['read-b', 'read-c']);
});

test('a mutating task starts only alone and blocks every other start while it owns the repository', () => {
  const readersDone = { 'read-a': 'completed', 'read-b': 'completed', 'read-c': 'completed' } as const;
  assert.deepEqual(start(3, [], readersDone), ['write']);
  assert.deepEqual(start(3, [{ taskId: 'read-c', mutating: false }], { ...readersDone, 'read-c': 'running' }), [],
    'the writer waits for the active reader');
  assert.deepEqual(start(3, [{ taskId: 'write', mutating: true }], { 'write': 'running' }), [],
    'no reader starts beside the writer');
});

test('a dependent starts only once its predecessor completed, not while it verifies or reviews drift', () => {
  const done = { 'read-a': 'completed', 'read-b': 'completed', 'read-c': 'completed' } as const;
  for (const status of ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending', 'failed'] as const) {
    assert.deepEqual(start(3, [], { ...done, write: status }), [], status);
  }
  assert.deepEqual(start(3, [], { ...done, write: 'completed' }), ['after-write']);
});
