import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { OrchestratorAttemptSchema, OrchestratorDriftReviewSchema, OrchestratorRunStateSchema, type OrchestratorActivity, type OrchestratorChildActivity, type OrchestratorDriftFinding, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';
import { fireEvent, render, screen } from './react-test-environment.ts';
import { OrchestratorRunPanel } from '../src/components/OrchestratorRunPanel.tsx';

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

const EVIDENCE = { kind: 'evidence', instruction: 'Confirm the greeting.', paths: ['src/a.ts'] } as const;
const UNREVIEWED_EVIDENCE = { check: EVIDENCE, executed: false, exitCode: null, timedOut: false, output: '' };

function attempt(purpose: 'implementation' | 'drift_fix', number: 1 | 2, passed: boolean | null, extraChecks: object[] = []) {
  return OrchestratorAttemptSchema.parse({
    taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, reservedAtUtc: AT,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK },
    status: passed === null ? 'running' : 'settled',
    result: passed === null ? null : {
      taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, workerStatus: 'completed', workerOutput: 'done',
      passed, checks: [{ check: CHECK, executed: true, exitCode: passed ? 0 : 1, timedOut: false, output: 'boom' }, ...extraChecks],
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

function renderPanel(state: OrchestratorRunState, activity: OrchestratorActivity | null = null, workPhase: OrchestratorRunState['phase'] | null = null) {
  const decisions: RepoAgentDecision[] = [];
  let aborts = 0;
  render(<OrchestratorRunPanel state={state} activity={activity} workPhase={workPhase} lastMessage="Working."
    onDecide={(decision) => decisions.push(decision)} onAbort={() => { aborts += 1; }} />);
  return { decisions, aborts: () => aborts };
}

const LIVE_CHILD: OrchestratorChildActivity = {
  childRunId: CHILD_ID, taskId: TASK.id, waitingForModel: false, turn: 9, maxTurns: 40, promptTokens: 1240,
  tools: [
    { toolCallId: 't1', turn: 8, activityKind: 'edit', command: 'write src/a.ts', status: 'succeeded' },
    { toolCallId: 't2', turn: 9, activityKind: 'command', command: 'npm test', status: 'running' },
  ],
};

const CLAIM = { taskId: TASK.id, modelId: 'exl3-main', mutating: true, contextTokens: 4000 };

function liveActivity(children: OrchestratorChildActivity[]): OrchestratorActivity {
  return { runId: RUN_ID, children,
    schedule: { claims: [CLAIM], models: [{ modelId: 'exl3-main', slots: 2, used: 1 }], writerUsed: true, waits: [] } };
}

test('a running task shows its phase, plan path, and attempts, and Stop aborts', () => {
  const view = renderPanel(runState({ attempts: [attempt('implementation', 1, false), attempt('implementation', 2, null)] }));
  screen.getByText('executing');
  screen.getByText('C:/repo/.siftkit/orchestrator/plan.md');
  screen.getByText('Add greeting');
  screen.getByText('impl 2/2');
  screen.getByText('Working.');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.equal(view.aborts(), 1);
});

test('a failed attempt lists its failed checks and never an unexecuted evidence check', () => {
  renderPanel(runState({ attempts: [attempt('implementation', 1, false, [UNREVIEWED_EVIDENCE])] }));
  screen.getByText('impl 1/2');
  screen.getByText('Check `npm test` exited 1; expected 0.');
  assert.equal(screen.queryByText(/Confirm the greeting/u), null);
});

test('drift correction shows its own attempt count and the top three findings with the remainder', () => {
  const review = OrchestratorDriftReviewSchema.parse({ taskId: TASK.id, changeDigest: 'd', scopePaths: [], resolutions: [], status: 'actionable', findings: [1, 2, 3, 4, 5].map(finding) });
  renderPanel(runState({
    tasks: [{ taskId: TASK.id, status: 'correcting_drift', driftReview: review, reviewedDigests: ['d'] }],
    attempts: [attempt('implementation', 1, true), attempt('drift_fix', 1, null)],
  }));
  screen.getByText('impl 1/2 · fix 1/2');
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
    approval: { kind: 'child', approvalId: APPROVAL_ID, childRunId: CHILD_ID, taskId: TASK.id, toolName: 'run',
      command: 'rm -rf build', reviewPayload: null },
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
    phase: 'failed', updatedAtUtc: '2026-09-23T12:14:02.000Z',
    failure: { code: 'implementation_failed', message: 'Task add-greeting failed twice.', taskId: TASK.id, purpose: 'implementation', findingIds: [] },
  }));
  screen.getByText('Task add-greeting failed twice.');
  screen.getByText('14m 02s');
  assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
});

test('an orchestrator check approval names the command and its working directory', () => {
  renderPanel(runState({
    phase: 'approval_required',
    approval: { kind: 'check', approvalId: APPROVAL_ID, taskId: null, command: 'npm run lint', cwd: 'packages/app' },
  }));
  screen.getByText('npm run lint');
  screen.getByText(/Orchestrator check in packages\/app/u);
});

test('a running task opens its agent card with turn, context, recent tool calls, write scope, and a transcript link', () => {
  renderPanel(runState({ attempts: [attempt('implementation', 1, null)] }), liveActivity([LIVE_CHILD]));
  screen.getByLabelText(`Agent ${CHILD_ID}`);
  screen.getByText('command npm test');
  screen.getByText('write src/a.ts');
  screen.getByText('31%');
  screen.getByText('src/a.ts', { selector: 'code' });
  const transcript = screen.getByRole('link', { name: 'Transcript' });
  assert.ok(transcript instanceof window.HTMLAnchorElement);
  assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
  screen.getByText(`${TASK.id} · repo-agent · writer`);
});

test('the slot meter shows held scheduler slots, and a pending task says why it waits', () => {
  const second = { ...TASK, id: 'second', title: 'Second write' };
  const state = runState({
    plan: { goal: 'Greet', constraints: [], tasks: [TASK, second], finalVerification: [CHECK] },
    tasks: [{ taskId: TASK.id, status: 'running', driftReview: null, reviewedDigests: [] },
      { taskId: 'second', status: 'pending', driftReview: null, reviewedDigests: [] }],
  });
  const activity: OrchestratorActivity = { runId: RUN_ID, children: [LIVE_CHILD], schedule: {
    claims: [CLAIM, { ...CLAIM, taskId: 'second' }], models: [{ modelId: 'exl3-main', slots: 2, used: 1 }], writerUsed: true,
    waits: [{ taskId: 'second', wait: { kind: 'writer_slot' } }],
  } };
  renderPanel(state, activity);
  screen.getByTitle('writer slot in use');
  screen.getByTitle('1 of 2 exl3-main slots in use');
  screen.getByText('waiting for writer slot');
});

test('the phase stepper marks where the run is, even while paused for approval', () => {
  renderPanel(runState({ phase: 'approval_required' }), null, 'executing');
  const steps = screen.getAllByRole('listitem', { name: /step$/u });
  assert.deepEqual(steps.map((step) => step.getAttribute('data-status')), ['done', 'done', 'now', 'todo', 'todo']);
});

test('a row opens when its task starts and stays as the user left it when the task settles', () => {
  const view = (status: 'pending' | 'running' | 'completed') => (
    <OrchestratorRunPanel state={runState({ tasks: [{ taskId: TASK.id, status, driftReview: null, reviewedDigests: [] }] })}
      activity={null} workPhase={null} lastMessage={null} onDecide={() => undefined} onAbort={() => undefined} />
  );
  const details = () => {
    const element = screen.getByText('Add greeting').closest('details');
    assert.ok(element instanceof window.HTMLDetailsElement);
    return element;
  };
  const { rerender } = render(view('pending'));
  assert.equal(details().open, false);
  rerender(view('running'));
  assert.equal(details().open, true, 'a task that starts opens');
  rerender(view('completed'));
  assert.equal(details().open, true, 'settling does not collapse what the user is reading');
  fireEvent.click(screen.getByText('Add greeting'));
  assert.equal(details().open, false, 'the user can close it');
});
