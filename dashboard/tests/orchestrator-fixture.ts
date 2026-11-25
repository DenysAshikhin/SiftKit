import {
  DEFAULT_ORCHESTRATOR_BUDGET,
  OrchestratorRunStateSchema,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';

const FIXTURE_RUN_ID = '00000000-0000-4000-8000-000000000001';
const FIXTURE_AT = '2026-10-11T12:00:00.000Z';

/** A start request as a stored run records it; a test overrides only what it asserts on. */
export function orchestratorRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return { submissionId: FIXTURE_RUN_ID, sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive',
    task: 'Greet', planPath: null, budget: DEFAULT_ORCHESTRATOR_BUDGET, ...overrides };
}

export function orchestratorTaskState(taskId: string, status: OrchestratorTaskStatus = 'pending',
  overrides: Partial<OrchestratorTaskState> = {}): OrchestratorTaskState {
  return { taskId, status, review: null, approach: 1, ...overrides };
}

export function orchestratorRunState(overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: FIXTURE_RUN_ID, request: orchestratorRequest(), revision: 1, phase: 'executing', planPath: null, planHash: null,
    plan: null, tasks: [], attempts: [], parentRunIds: [], approval: null, failure: null,
    approaches: [], retiredTasks: [], statusLines: [], createdAtUtc: FIXTURE_AT, updatedAtUtc: FIXTURE_AT, ...overrides,
  });
}
