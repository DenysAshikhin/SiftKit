import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { OrchestratorAttemptSchema, type OrchestratorActivity, type OrchestratorChildActivity, type OrchestratorParentActivity, type OrchestratorReviewRecord, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';
import { fireEvent, render, screen } from './react-test-environment.ts';
import { OrchestratorRunPanel } from '../src/components/OrchestratorRunPanel.tsx';
import { orchestratorRequest, orchestratorRunState, orchestratorTaskState } from './orchestrator-fixture.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000003';
const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const TASK = {
  id: 'add-greeting', title: 'Add greeting', why: 'Greet people the same way everywhere.', dependsOn: [], workerPresetId: 'repo-agent', readPaths: [], writePaths: ['src/a.ts'],
  steps: [{ instruction: 'Write it.', expectedResult: 'It exists.' }], verification: [CHECK], acceptance: ['Greets.'], temporaryPaths: [],
};

function runState(overrides: Partial<OrchestratorRunState>): OrchestratorRunState {
  return orchestratorRunState({
    runId: RUN_ID, revision: 3, planPath: 'C:/repo/.siftkit/orchestrator/plan.md', planHash: 'h',
    plan: { goal: 'Greet', constraints: [], tasks: [TASK], finalVerification: [CHECK] },
    tasks: [orchestratorTaskState(TASK.id, 'running')], createdAtUtc: AT, updatedAtUtc: AT,
    ...overrides,
  });
}

const EVIDENCE = { kind: 'evidence', instruction: 'Confirm the greeting.', paths: ['src/a.ts'] } as const;
const UNREVIEWED_EVIDENCE = { check: EVIDENCE, executed: false, exitCode: null, timedOut: false, output: '', digest: null };

function attempt(purpose: 'implementation' | 'fix', number: 1 | 2, passed: boolean | null, extraChecks: object[] = []) {
  return OrchestratorAttemptSchema.parse({
    taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, reservedAtUtc: AT,
    work: { kind: purpose, planPath: 'plan.md', planHash: 'h', task: TASK, instruction: 'Add the greeting.' },
    status: passed === null ? 'running' : 'settled',
    result: passed === null ? null : {
      taskId: TASK.id, purpose, attempt: number, childRunId: CHILD_ID, workerStatus: 'completed', workerOutput: 'done',
      report: null, outcome: passed ? 'passed' : 'checks_failed', submissions: passed ? 1 : 3, passed, checks: [{ check: CHECK, executed: true, exitCode: passed ? 0 : 1, timedOut: false, output: 'boom', digest: null }, ...extraChecks],
      findings: [], changedPaths: ['src/a.ts'], changeDigest: 'd',
    },
  });
}

function finding(index: number) {
  return { path: 'src/a.ts', line: index, issue: `Finding ${index}` };
}

function renderPanel(state: OrchestratorRunState, activity: OrchestratorActivity | null = null, workPhase: OrchestratorRunState['phase'] | null = null) {
  const decisions: RepoAgentDecision[] = [];
  let aborts = 0;
  render(<OrchestratorRunPanel state={state} activity={activity} workPhase={workPhase} lastMessage="Working."
    onDecide={(decision) => decisions.push(decision)} onAbort={() => { aborts += 1; }} />);
  return { decisions, aborts: () => aborts };
}

const LIVE_CHILD: OrchestratorChildActivity = {
  childRunId: CHILD_ID, taskId: TASK.id, waitingForModel: false, turn: 9, maxTurns: 40, promptTokens: 1240, updates: [],
  tools: [
    { toolCallId: 't1', turn: 8, activityKind: 'edit', command: 'write src/a.ts', status: 'succeeded' },
    { toolCallId: 't2', turn: 9, activityKind: 'command', command: 'npm test', status: 'running' },
  ],
};

const CLAIM = { taskId: TASK.id, modelId: 'exl3-main', contextTokens: 4000 };

function liveActivity(children: OrchestratorChildActivity[]): OrchestratorActivity {
  return { runId: RUN_ID, children, parent: null,
    schedule: { claims: [CLAIM], waits: [] } };
}

test('a running task shows its phase, plan path, and attempts, and Stop aborts', () => {
  const view = renderPanel(runState({ attempts: [attempt('implementation', 1, false), attempt('implementation', 2, null)] }));
  screen.getByText('executing');
  screen.getByText('C:/repo/.siftkit/orchestrator/plan.md');
  screen.getByText('Add greeting');
  screen.getByText('impl 2/2');
  screen.getByText('Working.');
  assert.equal(screen.queryByRole('list', { name: 'Earlier approaches' }), null);
  assert.equal(screen.queryByRole('list', { name: 'Retired tasks' }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.equal(view.aborts(), 1);
});

test('a failed attempt lists its failed checks and never an unexecuted evidence check', () => {
  renderPanel(runState({ attempts: [attempt('implementation', 1, false, [UNREVIEWED_EVIDENCE])] }));
  screen.getByText('impl 1/2');
  screen.getByText('Check `npm test` exited 1; expected 0.');
  assert.equal(screen.queryByText(/Confirm the greeting/u), null);
});

test('a failed review shows its verdict, the unmet criteria, and the top three findings with the remainder', () => {
  const review: OrchestratorReviewRecord = { attempt: 1, purpose: 'implementation', verdict: 'fail', criteria: [{ index: 0, met: false, evidence: [] }],
    findings: [1, 2, 3, 4, 5].map(finding) };
  renderPanel(runState({
    tasks: [orchestratorTaskState(TASK.id, 'running', { review })],
    attempts: [attempt('implementation', 1, true), attempt('fix', 1, null)],
  }));
  screen.getByText('impl 1/2 · fix 1/2');
  screen.getByText('Review failed: 0 of 1 criteria met');
  for (const title of ['src/a.ts:1 Finding 1', 'src/a.ts:2 Finding 2', 'src/a.ts:3 Finding 3']) screen.getByText(title);
  assert.equal(screen.queryByText('src/a.ts:4 Finding 4'), null);
  screen.getByText('+2 more findings');
});

test('a passing review says every criterion was met, and a settled attempt states its outcome and submissions', () => {
  const review: OrchestratorReviewRecord = { attempt: 1, purpose: 'implementation', verdict: 'pass',
    criteria: [{ index: 0, met: true, evidence: [{ path: 'src/a.ts', line: 1, snippet: 'greet' }] }], findings: [] };
  renderPanel(runState({ tasks: [orchestratorTaskState(TASK.id, 'completed', { review })], attempts: [attempt('implementation', 1, false)] }));
  screen.getByText('Review passed: 1 of 1 criteria met');
  screen.getByText('Attempt 1: checks failed after 3 submissions');
});

const PARENT: OrchestratorParentActivity = {
  waitingForModel: false, parked: true, promptTokens: 52_000, contextTokens: 200_000, turnCount: 14,
  prompt: { system: 'You are the SiftKit orchestrator.', user: 'Requested task: Greet' },
  turns: [{ turn: 14, thinking: 'The greeting task is next.', text: '',
    tools: [{ toolCallId: 'p1', command: 'dispatch', status: 'running', output: '' }] },
  { turn: 13, thinking: 'Review the survey.', text: '',
    tools: [{ toolCallId: 'p0', command: 'record_review taskId=survey verdict=pass', status: 'succeeded', output: 'Recorded pass for survey.' }] }],
};

test('the orchestrator view shows its prompt, its latest thinking, and every tool call with its result', () => {
  renderPanel(runState({}), { ...liveActivity([LIVE_CHILD]), parent: PARENT });
  const view = screen.getByRole('region', { name: 'Orchestrator' });
  assert.ok(view.textContent?.includes('released its model while children work'));
  screen.getByText('context 52,000 / 200,000 (26%)');
  screen.getByText('turn 14');
  screen.getByText('You are the SiftKit orchestrator.');
  screen.getByText('Requested task: Greet');
  screen.getByText('The greeting task is next.');
  screen.getByText('dispatch');
  screen.getByText('record_review taskId=survey verdict=pass');
  screen.getByText('Recorded pass for survey.');
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
    failure: { code: 'blocked', message: 'Task add-greeting failed twice.', taskId: TASK.id },
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
  screen.getByText('command · turn 9');
  const calls = screen.getByText('Latest calls (2)').closest('details');
  assert.ok(calls instanceof window.HTMLDetailsElement);
  assert.equal(calls.open, false, 'the rows are folded');
  screen.getByText('write src/a.ts');
  screen.getByText('31%');
  screen.getByText('src/a.ts', { selector: 'code' });
  const transcript = screen.getByRole('link', { name: 'Transcript' });
  assert.ok(transcript instanceof window.HTMLAnchorElement);
  assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
  screen.getByText('Greet people the same way everywhere.');
  assert.match(screen.getByLabelText(`Agent ${CHILD_ID}`).textContent ?? '', /^repo-agent 00000000/u);
  assert.equal(screen.queryByText(new RegExp(TASK.id, 'u')), null, 'the row names the task, not its id');
});

test('a pending task says which dependencies it waits for, and the panel shows no slot meter', () => {
  const second = { ...TASK, id: 'second', title: 'Second write' };
  const state = runState({
    plan: { goal: 'Greet', constraints: [], tasks: [TASK, second], finalVerification: [CHECK] },
    tasks: [orchestratorTaskState(TASK.id, 'running'), orchestratorTaskState('second')],
  });
  const activity: OrchestratorActivity = { runId: RUN_ID, children: [LIVE_CHILD], parent: null, schedule: {
    claims: [CLAIM, { ...CLAIM, taskId: 'second' }],
    waits: [{ taskId: 'second', dependencies: [TASK.id] }],
  } };
  renderPanel(state, activity);
  screen.getByText(`needs ${TASK.id}`);
  assert.equal(screen.queryByLabelText('Scheduler slots'), null);
});

test('the phase stepper marks where the run is, even while paused for approval', () => {
  renderPanel(runState({ phase: 'approval_required' }), null, 'executing');
  const steps = screen.getAllByRole('listitem', { name: /step$/u });
  assert.deepEqual(steps.map((step) => step.getAttribute('data-status')), ['done', 'now', 'todo', 'todo']);
});

test('a row opens when its task starts and stays as the user left it when the task settles', () => {
  const view = (status: 'pending' | 'running' | 'completed') => (
    <OrchestratorRunPanel state={runState({ tasks: [orchestratorTaskState(TASK.id, status)] })}
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

test('the panel shows the budget used, the active approach, what earlier approaches taught, and the retired tasks', () => {
  renderPanel(runState({
    phase: 'completed', updatedAtUtc: '2026-09-23T12:14:02.000Z',
    request: orchestratorRequest({ budget: { minutes: 90, dispatches: 12 } }),
    attempts: [attempt('implementation', 1, true)],
    tasks: [orchestratorTaskState(TASK.id, 'completed', { approach: 2 })],
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  }));
  screen.getByText('1/12 dispatches · 14/90 min');
  screen.getByText('2 · Cache the index');
  assert.match(screen.getByRole('list', { name: 'Earlier approaches' }).textContent ?? '',
    /1\. Initial plan\s+rolled back: Response caching cannot see headers\./u);
  assert.match(screen.getByRole('list', { name: 'Retired tasks' }).textContent ?? '',
    /cache\s+Cache responses · approach 1 · failed: Out of attempts\./u);
});

test('a task saved without a reason shows its title alone', () => {
  renderPanel(runState({ plan: { goal: 'Greet', constraints: [], tasks: [{ ...TASK, why: null }], finalVerification: [CHECK] } }));
  assert.equal(screen.getByText('Add greeting').closest('.orch-task-name')?.textContent, 'Add greeting');
});

function statusLines(count: number): OrchestratorRunState['statusLines'] {
  return Array.from({ length: count }, (_, index) => ({ text: `Line ${index + 1}.`, atUtc: AT }));
}

test('a finished run shows its final answer as markdown above the panes', () => {
  renderPanel(runState({ phase: 'completed', summary: 'Found **34** flaws.' }));
  const answer = screen.getByRole('region', { name: 'Final answer' });
  assert.equal(answer.querySelector('p')?.textContent, 'Found 34 flaws.');
  assert.equal(answer.querySelector('strong')?.textContent, '34');
  const panes = document.querySelector('.orch-panes');
  assert.ok(panes);
  assert.equal(answer.compareDocumentPosition(panes), window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('a run without a summary shows no final answer', () => {
  renderPanel(runState({ phase: 'failed' }));
  assert.equal(screen.queryByRole('region', { name: 'Final answer' }), null);
});

function shownLines(): string[] {
  return [...screen.getByRole('region', { name: 'Where the run is' }).querySelectorAll('p')].map((line) => line.textContent ?? '');
}

test('the run-wide bar shows the goal, then the current line with at most three past ones above it', () => {
  const view = (count: number) => (
    <OrchestratorRunPanel state={runState({ statusLines: statusLines(count) })} activity={null} workPhase={null} lastMessage={null}
      onDecide={() => undefined} onAbort={() => undefined} />
  );
  const { rerender } = render(view(0));
  assert.deepEqual(shownLines(), ['Greet']);
  rerender(view(1));
  assert.deepEqual(shownLines(), ['Line 1.']);
  rerender(view(4));
  assert.deepEqual(shownLines(), ['Line 1.', 'Line 2.', 'Line 3.', 'Line 4.']);
  assert.equal(screen.queryByRole('button', { name: /updates/u }), null, 'nothing is hidden');
  rerender(view(100));
  assert.deepEqual(shownLines(), ['Line 97.', 'Line 98.', 'Line 99.', 'Line 100.']);
  fireEvent.click(screen.getByRole('button', { name: 'Show all 100 updates' }));
  assert.equal(shownLines().length, 100);
  rerender(view(99));
  assert.equal(shownLines().length, 99, 'a new frame leaves it expanded');
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
  assert.deepEqual(shownLines(), ['Line 96.', 'Line 97.', 'Line 98.', 'Line 99.']);
});

test('a run with no plan and no line has no run-wide bar', () => {
  renderPanel(runState({ plan: null, planPath: null, planHash: null, tasks: [] }));
  assert.equal(screen.queryByRole('region', { name: 'Where the run is' }), null);
});

function parentTurn(turn: number, calls: number): OrchestratorParentActivity['turns'][number] {
  return { turn, thinking: `Thinking ${turn}.`, text: '',
    tools: Array.from({ length: calls }, (_, index) => ({ toolCallId: `c${turn}-${index}`, command: `call ${turn}.${index}`, status: 'succeeded' as const, output: '' })) };
}

test('the conversation shows three turns and three calls each, folds the rest, and links to the whole transcript', () => {
  const turns = Array.from({ length: 12 }, (_, index) => parentTurn(index + 21, index === 11 ? 5 : 1));
  renderPanel(runState({ parentRunIds: [CHILD_ID] }), { ...liveActivity([]), parent: { ...PARENT, turnCount: 32, turns } });
  const pane = screen.getByRole('region', { name: 'Orchestrator' });
  assert.deepEqual([...pane.querySelectorAll('.orch-parent-turn-head')].map((head) => head.textContent), ['turn 30', 'turn 31', 'turn 32']);
  assert.deepEqual([...pane.querySelectorAll('details')].filter((fold) => fold.open), [], 'every fold starts closed, the newest thinking too');
  const older = screen.getByText('Earlier turns (9)').closest('details');
  assert.deepEqual([...older?.querySelectorAll('.orch-older-turn > summary') ?? []].map((turn) => turn.textContent).slice(0, 2),
    ['turn 21 · 1 call', 'turn 22 · 1 call']);
  assert.deepEqual([...screen.getByText('2 earlier calls').closest('details')?.querySelectorAll('.orch-tool-command') ?? []].map((call) => call.textContent),
    ['call 32.0', 'call 32.1']);
  const transcript = screen.getByRole('link', { name: 'Full transcript (20 older turns)' });
  assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
});

test('a fold the user opened stays open when the next turn arrives', () => {
  const view = (last: number) => (
    <OrchestratorRunPanel state={runState({})} activity={{ ...liveActivity([LIVE_CHILD]), parent: { ...PARENT, turnCount: last,
      turns: Array.from({ length: 12 }, (_, index) => parentTurn(last - 11 + index, 1)) } }}
    workPhase={null} lastMessage={null} onDecide={() => undefined} onAbort={() => undefined} />
  );
  const isOpen = (summary: string): boolean => {
    const fold = screen.getByText(summary).closest('details');
    assert.ok(fold instanceof window.HTMLDetailsElement);
    return fold.open;
  };
  const { rerender } = render(view(12));
  fireEvent.click(screen.getByText('Earlier turns (9)'));
  fireEvent.click(screen.getByText('Latest calls (2)'));
  rerender(view(13));
  assert.deepEqual([isOpen('Earlier turns (9)'), isOpen('Latest calls (2)')], [true, true]);
});

test('an agent card leads with its current update, earlier ones folded above it and its calls below', () => {
  const update = (index: number, callsSince: number) => ({ updateId: `4f9c1f9a-0000-4000-8000-0000000000c${index}`, text: `Update ${index}.`,
    createdAtUtc: '2026-11-24T09:00:00.000Z', callsSince });
  const state = runState({ attempts: [attempt('implementation', 1, null)] });
  const panel = (updates: ReturnType<typeof update>[]) => (
    <OrchestratorRunPanel state={state} activity={liveActivity([{ ...LIVE_CHILD, updates }])} workPhase={null} lastMessage={null} onDecide={() => undefined} onAbort={() => undefined} />
  );
  const { rerender } = render(panel([]));
  const card = screen.getByLabelText(`Agent ${CHILD_ID}`);
  assert.equal(card.querySelector('.status-updates'), null);
  rerender(panel([update(1, 0)]));
  assert.equal(card.querySelector('.status-updates details'), null);
  assert.equal(card.querySelector('.status-update')?.className, 'status-update');
  rerender(panel([update(1, 5), update(2, 3)]));
  const fold = screen.getByText('Earlier updates (1)').closest('details');
  assert.ok(fold instanceof window.HTMLDetailsElement);
  assert.equal(fold.open, false);
  assert.deepEqual([...fold.querySelectorAll('li')].map((item) => item.textContent), ['Update 1.']);
  assert.equal(card.querySelector('.status-update.past')?.textContent, 'Update 2.');
  screen.getByText('3 tool calls ago');
  fireEvent.click(screen.getByText('Earlier updates (1)'));
  rerender(panel([update(1, 5), update(2, 3), update(3, 0)]));
  assert.ok(fold.open, 'a new update never folds what the reader opened');
  const order = [...card.querySelectorAll('summary, .status-update')].map((element) => element.textContent);
  assert.deepEqual(order, ['Earlier updates (2)', 'Update 3.', 'Latest calls (2)']);
});
