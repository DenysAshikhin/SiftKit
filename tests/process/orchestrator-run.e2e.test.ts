import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import {
  ChatSessionSummarySchema,
  ORCHESTRATOR_ACTIVITY_FRAME,
  OrchestratorActivitySchema,
  OrchestratorProgressSchema,
  OrchestratorRunStateSchema,
  type ApprovalMode,
  type OrchestratorChildPurpose,
  type OrchestratorPlan,
  type OrchestratorRecordReviewArgs,
  type OrchestratorRunState,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';
import { runCli } from '../../src/cli/dispatch.ts';
import { parseJsonText, parseJsonValueText } from '../../src/lib/json.ts';
import type { JsonObject } from '../../src/lib/json-types.ts';
import { z } from '../../src/lib/zod.ts';
import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import type { RepoSearchExecutionRequest } from '../../src/repo-search/types.ts';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from '../helpers/dashboard-model-queue-harness.ts';
import { requestJson } from '../helpers/dashboard-http.ts';
import { readStatusModelRequests } from '../helpers/model-request-status.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from '../helpers/orchestrator-plan.ts';
import { APPROVING_VERDICT, ESCALATING_VERDICTS, ScriptedEngineService, type ParentTurn } from '../helpers/scripted-engine-service.ts';
import { requestSse } from '../helpers/sse-http.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

const MODEL_A = 'exl3-main';
const RUN_TIMEOUT_MS = 120_000;
const TARGET = 'src/greeting.ts';
const GREETING = 'export const greeting = "hi";\n';
const TARGET_EXISTS: OrchestratorVerificationCheck = {
  kind: 'command', command: `if (Test-Path ${TARGET}) { exit 0 } else { exit 1 }`, cwd: '.', expectedExitCode: 0,
};
const PASSING_CHECK: OrchestratorVerificationCheck = { kind: 'command', command: 'exit 0', cwd: '.', expectedExitCode: 0 };

function makeRepo(): string {
  const root = createManagedTempDir('siftkit-orchestrated-repo-');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
  return root;
}

const WRITE_TASK = makeOrchestratorTask({ id: 'greeting', title: 'Add the greeting module', workerPresetId: 'repo-agent',
  readPaths: ['src/app.ts'], writePaths: [TARGET], verification: [TARGET_EXISTS],
  steps: [{ instruction: `Create ${TARGET} exporting greeting.`, expectedResult: 'The module exists.' }],
  acceptance: ['src/greeting.ts exports greeting.'] });
const READ_TASK = makeOrchestratorTask({ id: 'read-app', readPaths: ['src/app.ts'], verification: [PASSING_CHECK],
  steps: [{ instruction: 'Report the value of app in src/app.ts.', expectedResult: 'The value.' }],
  acceptance: ['The report states the value of app.'] });

function planOf(tasks = [WRITE_TASK], finalVerification = [PASSING_CHECK]): OrchestratorPlan {
  return { ...makeOrchestratorPlan(tasks), finalVerification };
}

// ---- the orchestrator's turns ----

function tool(name: string, args: JsonObject): MockPlannerResponseInput {
  return { toolCalls: [{ name, arguments: args }] };
}

const savePlan = (plan: OrchestratorPlan = planOf()) => tool('save_plan', { plan });

function dispatch(...children: { taskId: string; purpose?: OrchestratorChildPurpose; instruction?: string }[]) {
  return tool('dispatch', { children: children.map((child) => ({ taskId: child.taskId, purpose: child.purpose ?? 'implementation',
    instruction: child.instruction ?? `Do task ${child.taskId}.` })) });
}

const GREETING_EVIDENCE = { path: TARGET, line: 1, snippet: 'export const greeting' };
const APP_EVIDENCE = { path: 'src/app.ts', line: 1, snippet: 'export const app = 1;' };

function review(taskId: string, verdict: 'pass' | 'fail', overrides: Partial<OrchestratorRecordReviewArgs> = {}) {
  const evidence = taskId === 'greeting' ? GREETING_EVIDENCE : APP_EVIDENCE;
  return tool('record_review', { taskId, verdict, criteria: [{ index: 0, met: verdict === 'pass', evidence: verdict === 'pass' ? [evidence] : [] }],
    findings: verdict === 'pass' ? [] : [{ path: 'src/app.ts', line: 1, issue: 'The greeting is not exported.' }], ...overrides });
}

const COMPLETE: MockPlannerResponseInput = { content: '{"status":"completed","summary":"Added the greeting module."}' };

/** decide on the approval the previous tool result announced. */
function decideAnnounced(decision: 'approve' | 'deny' | 'escalate'): ParentTurn {
  return (output) => {
    const approvalId = /approvalId "([0-9a-f-]{36})"/u.exec(output)?.[1];
    if (approvalId === undefined) throw new Error(`No announced approval in: ${output.slice(0, 400)}`);
    return tool('decide', { approvalId, decision, reason: 'Creates the planned file inside its scope.' });
  };
}

// ---- the children's turns ----

function writeFile(content: string, file = TARGET): MockPlannerResponseInput {
  return { toolCalls: [{ name: 'write', arguments: { path: file, content } }] };
}

const AGENT_REPORT: MockPlannerResponseInput = { content: JSON.stringify({ kind: 'agent', status: 'completed', deviations: [] }) };

const SEARCH_REPORT: MockPlannerResponseInput = { content: JSON.stringify({ kind: 'search',
  findings: [{ claim: 'app is 1.', evidence: [{ path: 'src/app.ts', line: 1 }] }], unknowns: [] }) };

/** A writer that creates the greeting, approved by its own reviewer, and reports. */
const WRITER: MockPlannerResponseInput[] = [writeFile(GREETING), APPROVING_VERDICT, AGENT_REPORT];

/** A reader that looks at app.ts first, so its finish carries repository evidence. */
const READER: MockPlannerResponseInput[] = [tool('read', { path: 'src/app.ts' }), SEARCH_REPORT];

// ---- the harness ----

type Harness = { harness: DashboardModelQueueHarness; engine: ScriptedEngineService; repo: string; baseUrl: string };

async function startHarness(t: TestContext, prefix: string): Promise<Harness> {
  const engine = new ScriptedEngineService();
  const harness = new DashboardModelQueueHarness(prefix, { exl3ActivePreset: true, parallelSlots: 1, alternateModel: true, engineService: engine });
  t.after(() => harness.close());
  await harness.start();
  await harness.assignOperationModel('orchestrator', MODEL_A);
  await harness.assignOperationModel('repo-agent', ALTERNATE_MODEL_PRESET_ID);
  return { harness, engine, repo: makeRepo(), baseUrl: harness.getBaseUrl() };
}

async function startRun(context: Harness, approval: ApprovalMode, submissionId = randomUUID()): Promise<OrchestratorRunState> {
  const response = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId, sessionId: null, repoRoot: context.repo, presetId: 'orchestrator', approval, task: 'Add a greeting module.', planPath: null,
  }) });
  assert.equal(response.statusCode, 202, JSON.stringify(response.body));
  return OrchestratorRunStateSchema.parse(response.body);
}

async function followRun(context: Harness, runId: string) {
  const response = await requestSse(`${context.baseUrl}/orchestrator/events`, { body: { runId, afterSequence: 0 }, timeoutMs: RUN_TIMEOUT_MS });
  assert.equal(response.errorMessage, null, response.rawBody);
  return { state: OrchestratorRunStateSchema.parse(response.result),
    events: response.progress.flatMap((frame) => OrchestratorProgressSchema.parse(frame).events) };
}

async function readRun(context: Harness, runId: string): Promise<OrchestratorRunState> {
  const response = await requestJson(`${context.baseUrl}/orchestrator/status?runId=${runId}`);
  return OrchestratorRunStateSchema.parse(response.body);
}

/** The next pending approval, or null once the run is terminal. */
async function waitForApprovalOrEnd(context: Harness, runId: string): Promise<OrchestratorRunState | null> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readRun(context, runId);
    if (state.phase === 'approval_required' && state.approval !== null) return state;
    if (['completed', 'failed', 'aborted', 'interrupted'].includes(state.phase)) return null;
    await delay(25);
  }
  throw new Error('Timed out waiting for an orchestrator approval.');
}

async function waitForApproval(context: Harness, runId: string): Promise<OrchestratorRunState> {
  const state = await waitForApprovalOrEnd(context, runId);
  if (state === null) throw new Error(`Run ${runId} ended before an approval: ${JSON.stringify((await readRun(context, runId)).failure)}`);
  return state;
}

/** A completed run; otherwise the failure and every tool result the orchestrator read, to show where it went wrong. */
function assertCompleted(state: OrchestratorRunState, engine: ScriptedEngineService): void {
  assert.equal(state.phase, 'completed', [JSON.stringify(state.failure), ...engine.parentToolOutputs()].join('\n---\n'));
}

test('one conversation plans, dispatches a writer, reviews it, and finishes; the parent releases its model while the child works',
  async (t) => {
    const context = await startHarness(t, 'siftkit-orchestrator-happy-');
    const { engine } = context;
    engine.parent.push([savePlan(), dispatch({ taskId: 'greeting', instruction: 'Create src/greeting.ts exporting greeting.' }),
      review('greeting', 'pass'), COMPLETE]);
    engine.children.push(WRITER);

    const started = await startRun(context, 'off');
    const { state, events } = await followRun(context, started.runId);

    assertCompleted(state, engine);
    assert.deepEqual(context.harness.loadedModelNames, ['model-a', 'model-b', 'model-a'],
      'the parent on A, its child on B, then the parent resumes on A');
    assert.equal(engine.prompts('parent').length, 1, 'the whole run is one orchestrator conversation');
    assert.equal(state.parentRunIds.length, 1);
    assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt, attempt.status, attempt.result?.outcome]),
      [['implementation', 1, 'settled', 'passed']]);
    assert.equal(state.tasks[0]?.review?.verdict, 'pass');
    assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), GREETING);
    assert.ok(fs.existsSync(path.join(context.repo, state.planPath ?? 'missing')));
    const child = engine.prompts('children')[0] ?? '';
    assert.match(child, /Instruction from the orchestrator:\nCreate src\/greeting\.ts exporting greeting\./u);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.some((event) => event.message === 'Task greeting: review pass.'));
    const childRequests = engine.repoSearchRequests.filter((request) => request.taskKind !== 'orchestrator');
    assert.deepEqual([...new Set(childRequests.map((request) => request.requestId))], [state.attempts[0]?.childRunId],
      'the child transcript is keyed by its reserved child run ID');

    // The run belongs to the one chat session that shows it; the workers it dispatched belong to none.
    const rail = z.object({ sessions: z.array(ChatSessionSummarySchema) }).parse(
      (await requestJson(`${context.baseUrl}/dashboard/chat/sessions`)).body);
    assert.deepEqual(rail.sessions.filter((session) => session.orchestratorRunId !== null)
      .map((session) => session.orchestratorRunId), [started.runId], 'one run, one session showing it');
    assert.equal(rail.sessions.some((session) => state.attempts.some((attempt) =>
      attempt.childRunId === session.id || attempt.childRunId === session.orchestratorRunId)), false,
    'a worker run gets no chat session of its own');
  });

test('failing checks go back to the same child, which fixes them and resubmits inside its one session', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-resubmit-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push([tool('read', { path: 'src/app.ts' }), AGENT_REPORT, ...WRITER]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.equal(engine.prompts('children').length, 1, 'the resubmission is the same child, not a new one');
  assert.deepEqual(state.attempts.map((attempt) => [attempt.attempt, attempt.result?.outcome, attempt.result?.submissions]), [[1, 'passed', 2]]);
  assert.match(engine.parentToolOutputs()[1] ?? '', /## greeting \(implementation attempt 1\): passed, worker completed, 2 submission\(s\)/u);
  assert.match(engine.parentToolOutputs()[1] ?? '', /- src\/greeting\.ts \+\d+ -0 \(new\)/u, 'the parent reads a measured diffstat');
  assert.doesNotMatch(engine.parentToolOutputs()[1] ?? '', /^@@ /mu, 'and no diff hunks');
});

test('a writer that edits a test outside its writePaths reaches the orchestrator as a host finding naming that test', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-out-of-scope-test-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), { content: '{"status":"blocked","reason":"Stop after the report."}' }]);
  engine.children.push([writeFile(GREETING), APPROVING_VERDICT, writeFile('// allow-listed\n', 'tests/audit.test.ts'), APPROVING_VERDICT,
    writeFile('export const other = 2;\n', 'src/other.ts'), APPROVING_VERDICT, AGENT_REPORT]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.failure?.code, 'blocked', [JSON.stringify(state.failure), ...engine.parentToolOutputs()].join('\n---\n'));
  const report = engine.parentToolOutputs()[1] ?? '';
  assert.match(report, /Host findings:\n- Changed test files outside this task's writePaths: tests\/audit\.test\.ts\./u);
  assert.equal(report.includes('writePaths: src/other.ts'), false, 'a source file outside writePaths is not a test finding');
});

test('a child out of resubmits reports its failing checks, and the orchestrator dispatches a fresh second attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-retry-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'fail'),
    dispatch({ taskId: 'greeting', instruction: 'Write src/greeting.ts itself; the last attempt never created it.' }),
    review('greeting', 'pass'), COMPLETE]);
  engine.children.push([tool('read', { path: 'src/app.ts' }), AGENT_REPORT, AGENT_REPORT, AGENT_REPORT], WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt, attempt.result?.outcome, attempt.result?.submissions]),
    [['implementation', 1, 'checks_failed', 3], ['implementation', 2, 'passed', 1]]);
  const reported = engine.parentToolOutputs()[1] ?? '';
  assert.match(reported, /## greeting \(implementation attempt 1\): checks_failed/u);
  assert.match(reported, /- FAIL `if \(Test-Path src\/greeting\.ts\)[^\n]*exited 1\n/u, 'the parent reads the failing check output');
  assert.match(engine.parentToolOutputs()[2] ?? '', /Recorded fail for greeting; it is now reviewing\./u);
  const [, second] = engine.prompts('children');
  assert.match(second ?? '', /implementation attempt 2 of 2/u);
  assert.match(second ?? '', /Write src\/greeting\.ts itself; the last attempt never created it\./u, 'the retry carries the orchestrator\'s new instruction');
});

/** Waits up to 20 s for the writer's file, so the reader can settle only once both tasks overlapped. */
const WAIT_FOR_TARGET: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0,
  command: `$deadline = (Get-Date).AddSeconds(20); while (-not (Test-Path ${TARGET})) { if ((Get-Date) -gt $deadline) { exit 1 }; `
    + 'Start-Sleep -Milliseconds 50 }; exit 0' };

test('a writer and a reader dispatched together run at once and the reader is never charged with the write', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-parallel-');
  const { engine } = context;
  await context.harness.updateParallelSlots(2);
  await context.harness.assignOperationModel('repo-agent', MODEL_A);
  const reader = { ...READ_TASK, verification: [WAIT_FOR_TARGET] };
  engine.parent.push([savePlan(planOf([WRITE_TASK, reader])), dispatch({ taskId: 'greeting' }, { taskId: 'read-app' }),
    review('greeting', 'pass'), COMPLETE]);
  // The two children may reach the engine in either order, so each answers by its own prompt.
  const child = (request: RepoSearchExecutionRequest) => (request.prompt.includes('Report the value of app') ? READER : WRITER);
  engine.children.push(child, child);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const firstSettled = events.findIndex((event) => event.message.startsWith('Settled'));
  const started = events.slice(0, firstSettled).filter((event) => / running\.$/u.test(event.message)).map((event) => event.taskId);
  assert.deepEqual(started.sort(), ['greeting', 'read-app'], 'both tasks were running before either settled');
  const readAttempt = state.attempts.find((attempt) => attempt.taskId === 'read-app');
  assert.deepEqual(readAttempt?.result?.changedPaths, []);
  const reports = engine.parentToolOutputs()[1] ?? '';
  assert.ok(reports.includes('## greeting (implementation') && reports.includes('## read-app (implementation'), 'one batch carries both reports');
  assert.match(engine.prompts('parent')[0] ?? '', /2 parallel slots/u);
});

test('code refuses an invalid plan or dispatch in the tool result, and the conversation goes on until it finishes blocked', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-refusals-');
  const { engine } = context;
  // A name no machine resolves; a live run failed the same way on `grep`, which some PATHs do provide.
  const missingTool: OrchestratorVerificationCheck = { kind: 'command', command: 'node --version | siftkit-missing-tool v', cwd: '.',
    expectedExitCode: 0 };
  const second = makeOrchestratorTask({ ...WRITE_TASK, id: 'farewell', writePaths: ['src/farewell.ts'] });
  const dependent = { ...READ_TASK, dependsOn: ['greeting'] };
  engine.parent.push([savePlan(planOf([{ ...WRITE_TASK, verification: [missingTool] }])), savePlan(planOf([WRITE_TASK, second, dependent])),
    dispatch({ taskId: 'greeting' }, { taskId: 'farewell' }), dispatch({ taskId: 'read-app' }), dispatch({ taskId: 'nowhere' }),
    { content: '{"status":"blocked","reason":"The greeting cannot be written."}' }]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.failure, { code: 'blocked', message: 'The orchestrator stopped: The greeting cannot be written.', taskId: null });
  const [badPlan, goodPlan, twoWriters, unmet, unknown] = engine.parentToolOutputs();
  assert.match(badPlan ?? '', /^Not done:\n- Check `node --version \| siftkit-missing-tool v` cannot run in PowerShell/u);
  assert.match(goodPlan ?? '', /^Plan saved to .*plan\.md with 3 task\(s\)\./u);
  assert.match(twoWriters ?? '', /Task 'farewell' cannot start: another task in this dispatch already changes files\./u);
  assert.match(unmet ?? '', /Task 'read-app' cannot start: its dependencies are not complete: greeting\./u);
  assert.match(unknown ?? '', /Task 'nowhere' is not in the saved plan\./u);
  assert.equal(engine.prompts('children').length, 0, 'no refused dispatch started a child');
  assert.match(engine.prompts('parent')[0] ?? '', /Command checks run in PowerShell \(Windows, powershell\.exe\)/u);
});

test('update_tasks revises the saved plan and its Markdown, and save_plan only makes the first plan', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-update-tasks-');
  const { engine } = context;
  engine.parent.push([savePlan(),
    tool('update_tasks', { update: [{ taskId: 'greeting', set: { title: 'Write the greeting module' } }], add: [READ_TASK] }),
    savePlan(), tool('update_tasks', { remove: ['nowhere'] }), dispatch({ taskId: 'read-app' }),
    { content: '{"status":"blocked","reason":"Stop after the reader."}' }]);
  engine.children.push(READER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  const [, updated, replaced, unknown] = engine.parentToolOutputs();
  assert.match(updated ?? '', /^Plan updated: .*plan\.md now has 2 task\(s\)\./u);
  assert.match(replaced ?? '', /A plan is already saved; change it with update_tasks\./u);
  assert.match(unknown ?? '', /Task 'nowhere' is not in the saved plan\./u);
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.title]), [['greeting', 'Write the greeting module'], ['read-app', READ_TASK.title]]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['greeting', 'pending'], ['read-app', 'completed']]);
  assert.ok(state.planPath);
  assert.match(fs.readFileSync(path.join(context.repo, state.planPath ?? ''), 'utf8'), /Write the greeting module/u);
});

test('a read-only task is decided by its checks: a pass completes it unreviewed, a failure returns it for one more attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-read-only-');
  const { engine } = context;
  const failing = { ...READ_TASK, id: 'read-fail', verification: [{ ...PASSING_CHECK, command: 'exit 1' }] };
  engine.parent.push([savePlan(planOf([READ_TASK, failing])), dispatch({ taskId: 'read-app' }), review('read-app', 'pass'),
    dispatch({ taskId: 'read-fail' }), dispatch({ taskId: 'read-fail' }),
    { content: '{"status":"blocked","reason":"The failing survey never passed."}' }]);
  const failingReader = [tool('read', { path: 'src/app.ts' }), SEARCH_REPORT, SEARCH_REPORT, SEARCH_REPORT];
  engine.children.push(READER, failingReader, failingReader);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.failure?.code, 'blocked', [JSON.stringify(state.failure), ...engine.parentToolOutputs()].join('\n---\n'));
  const [, passed, refused, firstFailure, lastFailure] = engine.parentToolOutputs();
  assert.match(passed ?? '', /- read-app: completed \(implementation 1\/2/u);
  assert.match(refused ?? '', /Task 'read-app' is read-only; its checks decide it, so it takes no review\./u);
  assert.match(firstFailure ?? '', /- read-fail: pending \(implementation 1\/2/u);
  assert.match(lastFailure ?? '', /- read-fail: failed \(implementation 2\/2/u);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.review]), [['read-app', 'completed', null], ['read-fail', 'failed', null]]);
  assert.equal(events.some((event) => / reviewing\.$/u.test(event.message)), false, 'no read-only task waits for a review');
});

test('a child releases its model while its submission checks run, and the checks carry no nested-run marker', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-lease-');
  const { engine } = context;
  const signals = createManagedTempDir('siftkit-orchestrator-check-signals-');
  const started = path.join(signals, 'started.txt');
  const released = path.join(signals, 'released.txt');
  const holdingCheck: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0, command: [
    `Set-Content -Path '${started}' -Value "$env:SIFTKIT_AGENT_RUN_ID|$env:SIFTKIT_AGENT_SERVER_URL"`,
    `$deadline = (Get-Date).AddSeconds(30); while (-not (Test-Path '${released}') -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }`,
    'exit 0',
  ].join('; ') };
  engine.parent.push([savePlan(planOf([{ ...WRITE_TASK, verification: [holdingCheck] }])), dispatch({ taskId: 'greeting' }),
    review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const run = startRun(context, 'off').then((state) => followRun(context, state.runId));
  while (!fs.existsSync(started)) await delay(50);
  const { activeRequests } = await readStatusModelRequests(context.baseUrl);
  fs.writeFileSync(released, '');
  const { state } = await run;

  assertCompleted(state, engine);
  assert.deepEqual(activeRequests, [], 'neither the parked parent nor the checking child holds a model');
  assert.equal(fs.readFileSync(started, 'utf8').trim(), '|', 'the check sees no nested-run marker');
});

test('a supplied plan is quoted to the orchestrator, and a missing one fails before the conversation starts', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-supplied-');
  const { engine } = context;
  fs.mkdirSync(path.join(context.repo, 'docs'));
  fs.writeFileSync(path.join(context.repo, 'docs', 'plan.md'), '# Greeting plan\nWrite src/greeting.ts.\n');
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);
  const start = (planPath: string) => requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId: randomUUID(), sessionId: null, repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: null, planPath }) });

  const { state } = await followRun(context, OrchestratorRunStateSchema.parse((await start('docs/plan.md')).body).runId);
  assertCompleted(state, engine);
  assert.ok((engine.prompts('parent')[0] ?? '').includes('Supplied plan (docs/plan.md):\n<<<PLAN\n# Greeting plan\nWrite src/greeting.ts.\n\nPLAN>>>'));

  const missing = await followRun(context, OrchestratorRunStateSchema.parse((await start('docs/missing.md')).body).runId);
  assert.equal(missing.state.failure?.code, 'plan_not_found');
  assert.equal(engine.prompts('parent').length, 1, 'no conversation for a missing plan');
  const rejected = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId: randomUUID(), sessionId: null, repoRoot: context.repo, presetId: 'repo-agent', approval: 'off', task: 'x', planPath: null }) });
  assert.equal(rejected.statusCode, 400);
  assert.match(String(rejected.body.error), /not an orchestrator/u);
});

const ESCALATING_WRITER: MockPlannerResponseInput[] = [writeFile(GREETING), ...ESCALATING_VERDICTS, AGENT_REPORT];

test('with approval off a child escalation is approved without waking the orchestrator', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-approval-off-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(context.harness.loadedModelNames, ['model-a', 'model-b', 'model-a'], 'no swap back to the orchestrator for the approval');
  assert.equal(engine.parentToolOutputs().some((output) => output.includes('Approval needed')), false);
  assert.equal(events.some((event) => event.message.startsWith('Approval requested')), false);
});

test('with approval auto the orchestrator decides a child escalation in its own conversation and the same child continues', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-approval-auto-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), decideAnnounced('approve'), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);

  const { state, events } = await followRun(context, (await startRun(context, 'auto')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(context.harness.loadedModelNames, ['model-a', 'model-b', 'model-a', 'model-b', 'model-a'],
    'plan on A, child on B, the decision on A, the same child resumes on B, review on A');
  const [, announced, resumed] = engine.parentToolOutputs();
  assert.match(announced ?? '', /## Approval needed: child for greeting \(implementation attempt 1\)\nTool: write/u);
  assert.match(resumed ?? '', /## greeting \(implementation attempt 1\): passed/u, 'decide waits for the child to report');
  assert.equal(engine.prompts('children').length, 1, 'the approval continues the same child');
  assert.ok(events.some((event) => event.message.startsWith('Orchestrator approve: write')));
  assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), GREETING);
});

test('with approval auto an escalation the orchestrator cannot judge goes to the person', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-approval-escalate-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), decideAnnounced('escalate'), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);
  const started = await startRun(context, 'auto');
  const following = followRun(context, started.runId);

  const pending = await waitForApproval(context, started.runId);
  assert.equal(pending.approval?.kind, 'child');
  const decided = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
    body: JSON.stringify({ runId: started.runId, approvalId: pending.approval?.approvalId, decision: 'approve' }) });
  assert.equal(decided.statusCode, 200, JSON.stringify(decided.body));

  const { state } = await following;
  assertCompleted(state, engine);
  assert.equal(await waitForApprovalOrEnd(context, started.runId), null, 'checks never ask the person in an auto run');
});

test('interactive runs forward child approvals and every check to the person, by exact approval ID', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-interactive-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);
  const started = await startRun(context, 'interactive');
  const following = followRun(context, started.runId);

  const childApproval = await waitForApproval(context, started.runId);
  const wrong = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
    body: JSON.stringify({ runId: started.runId, approvalId: randomUUID(), decision: 'approve' }) });
  assert.equal(wrong.statusCode, 409);
  const kinds: string[] = [];
  const commands: string[] = [];
  for (let approval: OrchestratorRunState | null = childApproval; approval !== null; approval = await waitForApprovalOrEnd(context, started.runId)) {
    kinds.push(approval.approval?.kind ?? 'none');
    if (approval.approval?.kind === 'check') commands.push(approval.approval.command);
    const decided = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approvalId, decision: 'approve' }) });
    assert.equal(decided.statusCode, 200, JSON.stringify(decided.body));
  }

  const { state } = await following;
  assertCompleted(state, engine);
  assert.deepEqual(kinds, ['child', 'check', 'check'], 'the child write, the task check, then the final check');
  assert.deepEqual(commands, [TARGET_EXISTS.command, PASSING_CHECK.command], 'each check command is approved on its own');
  assert.equal(engine.parentToolOutputs().some((output) => output.includes('Approval needed')), false, 'the orchestrator is never asked');
});

const SAYS_BYE: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0,
  command: `if ((Get-Content ${TARGET} -Raw) -match 'bye') { exit 0 } else { exit 1 }` };

test('a failing final verification rejects the finish with its output, and a fix lets the next finish complete', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-final-fix-');
  const { engine } = context;
  engine.parent.push([savePlan(planOf([WRITE_TASK], [SAYS_BYE])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE,
    dispatch({ taskId: 'greeting', purpose: 'fix', instruction: 'Make the greeting say bye.' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER, [writeFile('export const greeting = "bye";\n'), APPROVING_VERDICT, AGENT_REPORT]);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt]), [['implementation', 1], ['fix', 1]]);
  assert.match(engine.prompts('children')[1] ?? '', /^Fix ONLY task 'greeting'/u);
  assert.equal(events.filter((event) => event.message === 'Running final verification.').length, 2);
});

test('a final verification that fails on every finish fails the run after the last one', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-final-failed-');
  const { engine } = context;
  const failing: OrchestratorVerificationCheck = { kind: 'command', command: 'exit 1', cwd: '.', expectedExitCode: 0 };
  engine.parent.push([savePlan(planOf([WRITE_TASK], [failing])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    COMPLETE, COMPLETE, COMPLETE]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'final_verification_failed');
  assert.match(state.failure?.message ?? '', /Final verification failed 3 times: Check `exit 1` exited 1; expected 0\./u);
});

test('an engine failure in the orchestrator conversation fails the run as infrastructure', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-infra-');
  const { engine } = context;
  engine.parent.push(new Error('TabbyAPI exited unexpectedly (code=1, signal=null).'));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.deepEqual([state.failure?.code, state.failure?.message], ['infrastructure_failed', 'TabbyAPI exited unexpectedly (code=1, signal=null).']);
});

test('a duplicate submission returns the same run and abort stops a parked child', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-abort-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);
  const submissionId = randomUUID();
  const started = await startRun(context, 'interactive', submissionId);
  assert.equal((await startRun(context, 'interactive', submissionId)).runId, started.runId);
  const conflicting = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId, sessionId: null, repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: 'Something else.', planPath: null }) });
  assert.equal(conflicting.statusCode, 400);

  await waitForApproval(context, started.runId);
  const aborted = await requestJson(`${context.baseUrl}/orchestrator/abort`, { method: 'POST', body: JSON.stringify({ runId: started.runId }) });
  assert.equal(aborted.statusCode, 200, JSON.stringify(aborted.body));
  const state = OrchestratorRunStateSchema.parse(aborted.body);
  assert.equal(state.phase, 'aborted');
  assert.equal(state.approval, null);
  assert.equal(fs.existsSync(path.join(context.repo, TARGET)), false, 'the parked write never ran');
  assert.equal((await followRun(context, started.runId)).state.phase, 'aborted', 'a reconnect reports the terminal state');
});

class CollectingStream extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

test('the CLI starts a run, streams committed events, and prints the typed result with a completion exit code', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-cli-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);
  const previousUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${context.baseUrl}/status`;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = previousUrl;
  });
  const stdout = new CollectingStream();
  const stderr = new CollectingStream();

  const exitCode = await runCli({ argv: ['orchestrator', '--approval', 'off', '--repo', context.repo, 'Add a greeting module.'], stdout, stderr });

  assert.equal(exitCode, 0, stderr.text);
  const result = z.object({ runId: z.string().uuid(), status: z.string(),
    tasks: z.array(z.object({ taskId: z.string(), review: z.string().nullable(), report: z.object({ kind: z.string() }).loose().nullable() })),
    attempts: z.array(z.object({ outcome: z.string().nullable() }).loose()) }).loose().parse(parseJsonValueText(stdout.text));
  assert.equal(result.status, 'completed');
  assert.deepEqual([result.tasks[0]?.review, result.tasks[0]?.report?.kind, result.attempts[0]?.outcome], ['pass', 'agent', 'passed']);
  assert.match(stderr.text, /\[orchestrator #1\] preparing_plan: Orchestrator run created\./u);
  assert.match(stderr.text, /Reserved implementation attempt 1\./u);
  const status = new CollectingStream();
  assert.equal(await runCli({ argv: ['orchestrator', 'status', result.runId], stdout: status, stderr }), 0);
  assert.equal(z.object({ status: z.string() }).loose().parse(parseJsonValueText(status.text)).status, 'completed');
});

test('the events stream carries the orchestrator conversation and live children, and nothing once a child settles', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-activity-');
  const { engine } = context;
  engine.parent.push([{ thinking: 'Plan one writer.', ...savePlan() }, dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const started = await startRun(context, 'off');
  const response = await requestSse(`${context.baseUrl}/orchestrator/events`, { body: { runId: started.runId, afterSequence: 0 }, timeoutMs: RUN_TIMEOUT_MS });
  const state = OrchestratorRunStateSchema.parse(response.result);
  const activities = response.frames.filter((frame) => frame.event === ORCHESTRATOR_ACTIVITY_FRAME)
    .map((frame) => parseJsonText(frame.data, OrchestratorActivitySchema));

  assertCompleted(state, engine);
  const parent = activities.at(-1)?.parent;
  assert.ok(parent);
  assert.match(parent.prompt?.user ?? '', /Requested task: Add a greeting module\./u);
  assert.match(parent.prompt?.system ?? '', /dispatch/u);
  assert.equal(parent.turns[0]?.thinking, 'Plan one writer.');
  assert.deepEqual(parent.turns.flatMap((turn) => turn.tools.map((entry) => [entry.command.split(' ')[0], entry.status])),
    [['save_plan', 'succeeded'], ['dispatch', 'succeeded'], ['record_review', 'succeeded']]);
  assert.ok(activities.some((activity) => activity.parent?.parked === true), 'the parent shows as parked while its child works');
  const scheduled = activities.find((activity) => activity.schedule !== null)?.schedule;
  assert.deepEqual(scheduled?.claims.map(({ taskId, modelId, mutating }) => ({ taskId, modelId, mutating })),
    [{ taskId: 'greeting', modelId: ALTERNATE_MODEL_PRESET_ID, mutating: true }]);
  const childViews = activities.flatMap((activity) => activity.children);
  assert.ok(childViews.length > 0 && childViews.every((child) => child.childRunId === state.attempts[0]?.childRunId));
  assert.ok(childViews.some((child) => child.tools.some((entry) => entry.status === 'succeeded')), 'the child tool call settled');
  assert.deepEqual(activities.at(-1)?.children, [], 'a settled child leaves the view');
  const childRunId = state.attempts[0]?.childRunId;
  assert.ok(childRunId);
  assert.equal((await requestJson(`${context.baseUrl}/dashboard/runs/${encodeURIComponent(childRunId)}`)).statusCode, 200,
    'the Logs tab finds the child transcript by its child run ID');
});

test('a client that connects mid-run starts from the live snapshot, and an aborted child leaves the view before the run ends', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-activity-snapshot-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);
  const started = await startRun(context, 'interactive');
  const parked = await waitForApproval(context, started.runId);
  const childRunId = parked.approval?.kind === 'child' ? parked.approval.childRunId : null;
  assert.ok(childRunId, 'the child is parked on its write');

  const aborts: ReturnType<typeof requestJson>[] = [];
  const response = await requestSse(`${context.baseUrl}/orchestrator/events`, {
    body: { runId: started.runId, afterSequence: 0 }, timeoutMs: RUN_TIMEOUT_MS,
    onProgress: () => {
      if (aborts.length === 0) aborts.push(requestJson(`${context.baseUrl}/orchestrator/abort`, { method: 'POST', body: JSON.stringify({ runId: started.runId }) }));
    },
  });
  const [aborted] = await Promise.all(aborts);
  assert.equal(aborted?.statusCode, 200);
  const activities = response.frames.filter((frame) => frame.event === ORCHESTRATOR_ACTIVITY_FRAME)
    .map((frame) => parseJsonText(frame.data, OrchestratorActivitySchema));

  assert.equal(OrchestratorRunStateSchema.parse(response.result).phase, 'aborted');
  assert.deepEqual(activities[0]?.children.map((child) => [child.childRunId, child.taskId]), [[childRunId, 'greeting']],
    'the first frame is the live snapshot, sent before anything changed');
  assert.equal(activities[0]?.parent?.parked, true);
  assert.deepEqual(activities.at(-1)?.children, [], 'the aborted child was untracked before the terminal result');
});

test('a run keeps the configuration it started with when presets change mid-run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-pinned-config-');
  const { engine } = context;
  const dependent = { ...READ_TASK, dependsOn: ['greeting'] };
  engine.parent.push([savePlan(planOf([WRITE_TASK, dependent])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    dispatch({ taskId: 'read-app' }), COMPLETE]);
  engine.children.push(ESCALATING_WRITER, READER);
  const started = await startRun(context, 'interactive');
  const following = followRun(context, started.runId);

  let approval = await waitForApprovalOrEnd(context, started.runId);
  await context.harness.updateOperationPreset('repo-search', { allowedTools: ['read'] });
  while (approval !== null) {
    await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approvalId, decision: 'approve' }) });
    approval = await waitForApprovalOrEnd(context, started.runId);
  }

  const { state } = await following;
  assertCompleted(state, engine);
  assert.notDeepEqual(engine.requireRepoSearch('Report the value of app').allowedTools, ['read'],
    'the reader keeps the tools the run started with');
});

test('a reader that starts after the writer finished is charged with its own change to the writer\'s file, and the orchestrator sees it', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-late-reader-');
  const { engine } = context;
  const touchTarget: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0,
    command: `Add-Content -Path ${TARGET} -Value '// touched by a reader check'; exit 0` };
  const dependent = { ...READ_TASK, dependsOn: ['greeting'], verification: [touchTarget] };
  engine.parent.push([savePlan(planOf([WRITE_TASK, dependent])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    dispatch({ taskId: 'read-app' }), { content: '{"status":"blocked","reason":"The reader changed a file."}' }]);
  engine.children.push(WRITER, [tool('read', { path: 'src/app.ts' }), SEARCH_REPORT, SEARCH_REPORT, SEARCH_REPORT]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.failure?.code, 'blocked');
  const readAttempt = state.attempts.find((attempt) => attempt.taskId === 'read-app');
  assert.deepEqual([readAttempt?.result?.outcome, readAttempt?.result?.changedPaths], ['passed', [TARGET]]);
  assert.ok((engine.parentToolOutputs().at(-1) ?? '').includes(`- ${TARGET} +1 -0`), 'the reader\'s change reaches the orchestrator');
});

test('the orchestrator is told which uncommitted changes predate the run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-preexisting-dirty-');
  const { engine } = context;
  fs.writeFileSync(path.join(context.repo, 'src', 'app.ts'), 'export const app = 1;\n// local note\n');
  engine.parent.push([{ content: '{"status":"blocked","reason":"Nothing to do."}' }]);

  await followRun(context, (await startRun(context, 'off')).runId);

  assert.match(engine.prompts('parent')[0] ?? '', /Uncommitted changes that predate this run \(never count them against any task\): src\/app\.ts\./u);
});
