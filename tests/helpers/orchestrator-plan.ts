import { OrchestratorPlanSchema, OrchestratorTaskSchema, type OrchestratorPlan, type OrchestratorTask } from '@siftkit/contracts';

export function makeOrchestratorTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return OrchestratorTaskSchema.parse({
    id: 'inspect', title: 'Inspect README', dependsOn: [],
    workerPresetId: 'repo-search', readPaths: ['README.md'], writePaths: [],
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
