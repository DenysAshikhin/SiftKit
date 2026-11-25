import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ORCHESTRATOR_BUDGET,
  OrchestratorNewTaskSchema,
  OrchestratorPlanSchema,
  OrchestratorRunStateSchema,
  OrchestratorStartRequestSchema,
  type OrchestratorNewTask,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTask,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';

import { startPlan, type PlanTransition } from '../../src/orchestrator/plan-state.ts';
import type { OrchestratorRunStore } from '../../src/orchestrator/run-store.ts';

export function makeOrchestratorTask(overrides: Partial<OrchestratorNewTask> = {}): OrchestratorNewTask {
  return OrchestratorNewTaskSchema.parse({
    id: 'inspect', title: 'Inspect README', why: 'Make sure the install steps work.', dependsOn: [],
    workerPresetId: 'repo-agent', readPaths: ['README.md'], writePaths: ['README.md'],
    steps: [{ instruction: 'Read README.md and report its installation commands.',
      expectedResult: 'Commands with file and line evidence.' }],
    verification: [{ kind: 'evidence', instruction: 'Verify each reported command in README.md.',
      paths: ['README.md'] }],
    acceptance: ['Every reported command is supported by the current README.'],
    temporaryPaths: [], ...overrides,
  });
}

export function makeOrchestratorPlan(tasks: OrchestratorTask[]): OrchestratorPlan {
  return OrchestratorPlanSchema.parse({
    goal: 'Exercise the orchestrator.', constraints: [], tasks,
    finalVerification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }],
  });
}

const FIXTURE_AT = '2026-10-11T12:00:00.000Z';

/** A start request with a fresh submission; a test overrides only what it asserts on. */
export function makeOrchestratorRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return OrchestratorStartRequestSchema.parse({
    submissionId: randomUUID(), sessionId: null, repoRoot: process.cwd(), presetId: 'orchestrator', approval: 'auto',
    task: 'Inspect the README.', planPath: null, budget: DEFAULT_ORCHESTRATOR_BUDGET, ...overrides,
  });
}

export function makeTaskState(taskId: string, status: OrchestratorTaskStatus = 'pending',
  overrides: Partial<OrchestratorTaskState> = {}): OrchestratorTaskState {
  return { taskId, status, review: null, approach: 1, ...overrides };
}

/** A whole run state for tests that render or parse one without a store. */
export function makeOrchestratorRunState(overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: randomUUID(), request: makeOrchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
    plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
    approaches: [], retiredTasks: [], statusLines: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
  });
}

/** Stores a plan transition the way the run does; a refused transition fails the test. */
export function storeTransition(store: OrchestratorRunStore, state: OrchestratorRunState, transition: PlanTransition,
  contentHash = 'hash'): OrchestratorRunState {
  assert.ok(transition.ok, transition.ok ? '' : transition.problems.join(' '));
  const { plan } = transition.next;
  assert.ok(plan);
  return store.savePlan(state.runId, state.revision, { ...transition.next, plan }, 'docs/plan.md', contentHash);
}

/** Saves `plan` as the run's first plan. */
export function savePlanned(store: OrchestratorRunStore, state: OrchestratorRunState, plan: OrchestratorPlan,
  contentHash = 'hash'): OrchestratorRunState {
  return storeTransition(store, state, startPlan(state, plan, new Date().toISOString()), contentHash);
}
