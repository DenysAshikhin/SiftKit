import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { OrchestratorAttemptSchema, OrchestratorDriftReviewSchema, OrchestratorRunStateSchema, type OrchestratorDriftFinding, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';
import { fireEvent, render, screen } from './react-test-environment.js';
import { OrchestratorRunPanel } from '../src/components/OrchestratorRunPanel';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000003';
const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const TASK = {
  id: 'add-greeting', title: 'Add greeting', dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
  steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Greets.'], temporaryPaths: [],
};

function runState(overrides: Partial<OrchestratorRunState>): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: RUN_ID,
    request: { submissionId: RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: 'Greet', planPath: null },
    revision: 3, phase: 'executing', planPath: 'C:/repo/.siftkit/orchestrator/plan.md', planHash: 'h',
    plan: { goal: 'Greet', constraints: [], tasks: [TASK], finalVerification: [CHECK] },
    tasks: [{ taskId: TASK.id, status: 'running', driftReview: null, reviewedDigests: [] }],
    attempts: [], phaseRunIds: [], approval: null, failure: null, createdAtUtc: AT, updatedAtUtc: AT,
    ...overrides,
  });
}

function attempt(purpose: 'implementation' | 'drift_fix', number: 1 | 2, passed: boolean | null) {
  return OrchestratorAttemptSchema.parse({
    taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK },
    status: passed === null ? 'running' : 'settled',
    result: passed === null ? null : {
      taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, workerStatus: 'completed', workerOutput: 'done',
      passed, checks: [{ check: CHECK, executed: true, exitCode: passed ? 0 : 1, timedOut: false, output: 'boom' }],
      findings: [], changedPaths: ['src/a.ts'], scopeViolations: [], changeDigest: 'd',
    },
  });
}

function finding(index: number): OrchestratorDriftFinding {
  return {
    id: `f${index}`, title: `Finding ${index}`, purpose: 'p', directive: 'd', impact: 'i', fix: 'f',
    evidence: [{ path: 'src/a.ts', line: 1, snippet: 's' }], affectedPaths: ['src/a.ts'], verification: [CHECK],
  };
}

function renderPanel(state: OrchestratorRunState) {
  const decisions: RepoAgentDecision[] = [];
  let aborts = 0;
  render(<OrchestratorRunPanel state={state} lastMessage="Working." onDecide={(decision) => decisions.push(decision)} onAbort={() => { aborts += 1; }} />);
  return { decisions, aborts: () => aborts };
}

test('a running task shows its phase, plan path, and current implementation attempt, and Stop aborts', () => {
  const view = renderPanel(runState({ attempts: [attempt('implementation', 1, false), attempt('implementation', 2, null)] }));
  screen.getByText('executing');
  screen.getByText('C:/repo/.siftkit/orchestrator/plan.md');
  screen.getByText('Add greeting');
  screen.getByText('Implementation attempt 2 of 2');
  screen.getByText('Working.');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.equal(view.aborts(), 1);
});

test('a failed attempt lists its failed checks', () => {
  renderPanel(runState({ attempts: [attempt('implementation', 1, false)] }));
  screen.getByText('Implementation attempt 1 of 2');
  screen.getByText('Failed: npm test (exit 1)');
});

test('drift correction shows its own attempt count and the top three findings with the remainder', () => {
  const review = OrchestratorDriftReviewSchema.parse({ taskId: TASK.id, changeDigest: 'd', scopePaths: [], resolutions: [], status: 'actionable', findings: [1, 2, 3, 4, 5].map(finding) });
  renderPanel(runState({
    tasks: [{ taskId: TASK.id, status: 'correcting_drift', driftReview: review, reviewedDigests: ['d'] }],
    attempts: [attempt('implementation', 1, true), attempt('drift_fix', 1, null)],
  }));
  screen.getByText('Drift correction 1 of 2');
  for (const title of ['Finding 1', 'Finding 2', 'Finding 3']) screen.getByText(title);
  assert.equal(screen.queryByText('Finding 4'), null);
  screen.getByText('+2 more findings');
});

test('a clean drift review says there is no actionable drift', () => {
  const review = OrchestratorDriftReviewSchema.parse({ taskId: TASK.id, changeDigest: 'd', scopePaths: [], resolutions: [], status: 'clean', findings: [] });
  renderPanel(runState({ tasks: [{ taskId: TASK.id, status: 'completed', driftReview: review, reviewedDigests: ['d'] }] }));
  screen.getByText('No actionable drift');
});

test('a pending approval can be approved, denied only with a reason, or aborted', () => {
  const view = renderPanel(runState({
    phase: 'approval_required',
    approval: { target: { kind: 'child', childRunId: CHILD_ID }, taskId: TASK.id,
      approval: { approvalId: APPROVAL_ID, toolName: 'run', command: 'rm -rf build', reviewPayload: null } },
  }));
  screen.getByText('rm -rf build');
  const deny = screen.getByRole('button', { name: 'Deny' });
  assert.ok(deny instanceof window.HTMLButtonElement);
  assert.equal(deny.disabled, true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Deny reason' }), { target: { value: 'Out of scope.' } });
  fireEvent.click(deny);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'Abort run' }));
  assert.deepEqual(view.decisions, [{ decision: 'deny', reason: 'Out of scope.' }, { decision: 'approve' }, { decision: 'abort' }]);
});

test('a terminal run shows its failure and no Stop button', () => {
  renderPanel(runState({
    phase: 'failed',
    failure: { code: 'implementation_failed', message: 'Task add-greeting failed twice.', taskId: TASK.id, purpose: 'implementation', findingIds: [] },
  }));
  screen.getByText('Task add-greeting failed twice.');
  assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
});
