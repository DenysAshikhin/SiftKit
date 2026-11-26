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
  type OrchestratorStartRequest,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';
import { runCli } from '../../src/cli/dispatch.ts';
import { parseJsonText, parseJsonValueText } from '../../src/lib/json.ts';
import type { JsonObject } from '../../src/lib/json-types.ts';
import { z } from '../../src/lib/zod.ts';
import { COMMAND_TAIL_CHARS } from '../../src/orchestrator/run.ts';
import { ORCHESTRATOR_MAX_WRITE_PATHS } from '../../src/orchestrator/plan.ts';
import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from '../helpers/dashboard-model-queue-harness.ts';
import { requestJson } from '../helpers/dashboard-http.ts';
import { readStatusModelRequests } from '../helpers/model-request-status.ts';
import { makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorTask } from '../helpers/orchestrator-plan.ts';
import { APPROVING_VERDICT, ESCALATING_VERDICTS, ScriptedEngineService, type ParentTurn } from '../helpers/scripted-engine-service.ts';
import { requestSse } from '../helpers/sse-http.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';
import { digestFixturePath } from '../helpers/output-digest-fixtures.ts';

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
const FAREWELL_TASK = makeOrchestratorTask({ ...WRITE_TASK, id: 'farewell', title: 'Add farewell', writePaths: ['src/farewell.ts'],
  verification: [PASSING_CHECK], steps: [{ instruction: 'Create src/farewell.ts exporting farewell.', expectedResult: 'The module exists.' }],
  acceptance: ['src/farewell.ts exports farewell.'] });

function planOf(tasks = [WRITE_TASK], finalVerification = [PASSING_CHECK]): OrchestratorPlan {
  return { ...makeOrchestratorPlan(tasks), finalVerification };
}

// ---- the orchestrator's turns ----

function tool(name: string, args: JsonObject): MockPlannerResponseInput {
  return { toolCalls: [{ name, arguments: args }] };
}

const savePlan = (plan: OrchestratorPlan = planOf()) => tool('save_plan', { plan });

function dispatch(child: { taskId: string; purpose?: OrchestratorChildPurpose; instruction?: string; update?: string }) {
  return tool('dispatch', { update: child.update ?? 'The run is under way.', taskId: child.taskId, purpose: child.purpose ?? 'implementation',
    instruction: child.instruction ?? `Do task ${child.taskId}.` });
}

const GREETING_EVIDENCE = { path: TARGET, line: 1, snippet: 'export const greeting' };
const FAREWELL_EVIDENCE = { path: 'src/farewell.ts', line: 1, snippet: 'export const farewell' };

function review(taskId: string, verdict: 'pass' | 'fail', overrides: Partial<OrchestratorRecordReviewArgs> = {}) {
  const evidence = taskId === 'farewell' ? FAREWELL_EVIDENCE : GREETING_EVIDENCE;
  return tool('record_review', { taskId, verdict, criteria: [{ index: 0, met: verdict === 'pass', evidence: verdict === 'pass' ? [evidence] : [] }],
    findings: verdict === 'pass' ? [] : [{ path: 'src/app.ts', line: 1, issue: 'The greeting is not exported.' }], ...overrides });
}

const COMPLETE: MockPlannerResponseInput = { content: '{"status":"completed","summary":"Added the greeting module."}' };

function announcedApprovalId(output: string): string {
  const approvalId = /approvalId "([0-9a-f-]{36})"/u.exec(output)?.[1];
  if (approvalId === undefined) throw new Error(`No announced approval in: ${output.slice(0, 400)}`);
  return approvalId;
}

/** decide on the approval the previous tool result announced. */
function decideAnnounced(decision: 'approve' | 'deny' | 'escalate'): ParentTurn {
  return (output) => tool('decide', { approvalId: announcedApprovalId(output), decision, reason: 'Creates the planned file inside its scope.' });
}

// ---- the children's turns ----

function writeFile(content: string, file = TARGET): MockPlannerResponseInput {
  return { toolCalls: [{ name: 'write', arguments: { path: file, content } }] };
}

const AGENT_REPORT: MockPlannerResponseInput = { content: JSON.stringify({ status: 'completed', deviations: [] }) };

/** A writer that creates the greeting, approved by its own reviewer, and reports. */
const WRITER: MockPlannerResponseInput[] = [writeFile(GREETING), APPROVING_VERDICT, AGENT_REPORT];

/** A writer that creates the farewell module, approved by its own reviewer, and reports. */
const FAREWELL_WRITER: MockPlannerResponseInput[] = [writeFile("export const farewell = 'bye';\n", 'src/farewell.ts'),
  APPROVING_VERDICT, AGENT_REPORT];

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

async function startRun(context: Harness, approval: ApprovalMode, overrides: Partial<OrchestratorStartRequest> = {}): Promise<OrchestratorRunState> {
  const response = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify(
    makeOrchestratorRequest({ repoRoot: context.repo, approval, task: 'Add a greeting module.', ...overrides })) });
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

for (const { from, statusUpdates } of [{ from: 'the dashboard', statusUpdates: true }, { from: 'the terminal', statusUpdates: false }]) {
  test(`a run started from ${from} has workers that ${statusUpdates ? 'write' : 'write no'} status updates`, async (t) => {
    const context = await startHarness(t, 'siftkit-orchestrator-updates-');
    const { engine } = context;
    engine.parent.push([savePlan(), dispatch({ taskId: 'greeting', instruction: 'Create src/greeting.ts exporting greeting.' }),
      review('greeting', 'pass'), COMPLETE]);
    engine.children.push(WRITER);

    const sessionId = statusUpdates ? await context.harness.createChatSession('orchestrator', 'model-a') : null;
    const started = await startRun(context, 'off', { sessionId });
    const { state } = await followRun(context, started.runId);

    assertCompleted(state, engine);
    const requests = engine.repoSearchRequests.map((request) => [request.taskKind === 'orchestrator', request.statusUpdates ?? false]);
    assert.deepEqual(requests, [[true, false], [false, statusUpdates]], 'the orchestrator itself never does: its dispatches say where the run is');
  });
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
    assert.equal(state.summary, 'Added the greeting module.');
    assert.deepEqual(context.harness.loadedModelNames, ['model-a', 'model-b', 'model-a'],
      'the parent on A, its child on B, then the parent resumes on A');
    assert.equal(engine.prompts('parent').length, 1, 'the whole run is one orchestrator conversation');
    const parentPrompt = engine.prompts('parent')[0] ?? '';
    assert.match(parentPrompt, /^- repo-agent \(model /mu, 'the repo-agent preset is a worker');
    assert.doesNotMatch(parentPrompt, /^- (?:repo-search|plan|orchestrator) \(/mu, 'read-only and orchestrator presets are never workers');
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

test('a prompt-cache break in the orchestrator or its worker becomes a run event, so the CLI prints it', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-cache-break-');
  const { engine } = context;
  const evicted = { promptEvalTokens: 50_000, promptCacheTokens: 0 };
  engine.parent.push([savePlan(), { ...dispatch({ taskId: 'greeting' }), ...evicted }, review('greeting', 'pass'), COMPLETE]);
  engine.children.push([writeFile(GREETING), APPROVING_VERDICT, { ...AGENT_REPORT, ...evicted }]);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const warnings = events.filter((event) => event.message.includes('Prompt cache broke'))
    .map((event) => [event.message.replace(/grew [\d,]+\./u, 'grew N.'), event.taskId, event.childRunId]);
  assert.deepEqual(warnings, [
    ['Orchestrator warning: Prompt cache broke on turn 2: re-prefilled 50,000 tokens where the prompt grew N.', null, null],
    ['Worker warning: Prompt cache broke on turn 2: re-prefilled 50,000 tokens where the prompt grew N.', 'greeting',
      state.attempts[0]?.childRunId],
  ]);
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

const INVALID_SAVE_PLAN = tool('save_plan', { tasks: [] });

test('the orchestrator conversation survives four invalid responses in a row and goes on', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-invalid-four-');
  const { engine } = context;
  engine.parent.push([INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, savePlan(),
    { content: '{"status":"blocked","reason":"Stop after the plan."}' }]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.failure?.code, 'blocked', JSON.stringify(state.failure));
  assert.ok(state.plan, 'the valid save_plan after four slips was applied');
});

test('a fifth invalid response in a row ends the orchestrator conversation', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-invalid-five-');
  const { engine } = context;
  engine.parent.push([INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, INVALID_SAVE_PLAN, savePlan()]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.match(state.failure?.message ?? '', /invalid_response_limit/u);
  assert.equal(state.plan, null, 'the save_plan after the fifth slip never ran');
  assert.equal(state.summary, null);
});

test('a child start that loses the repository settles the attempt and hands the gate back, so the retry dispatch completes the run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-start-failure-');
  const { engine } = context;
  const gitDir = path.join(context.repo, '.git');
  const gitHidden = path.join(context.repo, '.git-unavailable');
  engine.parent.push([
    savePlan(),
    () => {
      fs.renameSync(gitDir, gitHidden);
      assert.ok(fs.existsSync(gitHidden) && !fs.existsSync(gitDir), 'the first child start must face no git directory');
      return dispatch({ taskId: 'greeting' });
    },
    () => {
      fs.renameSync(gitHidden, gitDir);
      assert.ok(fs.existsSync(gitDir), 'the retry dispatch must face the repository again');
      return dispatch({ taskId: 'greeting' });
    },
    review('greeting', 'pass'),
    COMPLETE,
  ]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const refused = engine.parentToolOutputs()[1] ?? '';
  assert.match(refused, /^Not done:\n- .*git status failed/u, 'the failed start is a refusal the parent reads, not a crash');
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt, attempt.status, attempt.result?.outcome]),
    [['implementation', 1, 'settled', 'not_submitted'], ['implementation', 2, 'settled', 'passed']],
    'the failed start settles its attempt, and the retry works only if the gate was handed back');
  assert.match(state.attempts[0]?.result?.findings[0] ?? '', /git status failed/u, 'the settled attempt names why the child never started');
  assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), GREETING);
});

test('a dispatch whose update names a path is refused and records no line; the next one is recorded', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-update-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting', update: 'Working on src/greeting.ts now.' }),
    dispatch({ taskId: 'greeting', update: 'Building the greeting first.' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);
  const { state } = await followRun(context, (await startRun(context, 'off')).runId);
  assertCompleted(state, engine);
  assert.deepEqual(state.statusLines.map((line) => line.text), ['Building the greeting first.']);
  assert.equal(state.attempts.length, 1);
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

test('code refuses an invalid plan or dispatch in the tool result, and the conversation goes on until it finishes blocked', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-refusals-');
  const { engine } = context;
  // A name no machine resolves; a live run failed the same way on `grep`, which some PATHs do provide.
  const missingTool: OrchestratorVerificationCheck = { kind: 'command', command: 'node --version | siftkit-missing-tool v', cwd: '.',
    expectedExitCode: 0 };
  const dependent = makeOrchestratorTask({ ...FAREWELL_TASK, id: 'goodbye', writePaths: ['src/goodbye.ts'], dependsOn: ['greeting'] });
  engine.parent.push([savePlan(planOf([{ ...WRITE_TASK, verification: [missingTool] }])), savePlan(planOf([WRITE_TASK, FAREWELL_TASK, dependent])),
    dispatch({ taskId: 'goodbye' }), dispatch({ taskId: 'nowhere' }),
    { content: '{"status":"blocked","reason":"The greeting cannot be written."}' }]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.failure, { code: 'blocked', message: 'The orchestrator stopped: The greeting cannot be written.', taskId: null });
  const [badPlan, goodPlan, unmet, unknown] = engine.parentToolOutputs();
  assert.match(badPlan ?? '', /^Not done:\n- Check `node --version \| siftkit-missing-tool v` cannot run in PowerShell/u);
  assert.match(goodPlan ?? '', /^Plan saved to .*plan\.md with 3 task\(s\)\./u);
  assert.match(unmet ?? '', /Task 'goodbye' cannot start: its dependencies are not complete: greeting\./u);
  assert.match(unknown ?? '', /Task 'nowhere' is not in the saved plan\./u);
  assert.equal(engine.prompts('children').length, 0, 'no refused dispatch started a child');
  assert.match(engine.prompts('parent')[0] ?? '', /Command checks run in PowerShell \(Windows, powershell\.exe\)/u);
});

// Real case (run e85529c8): the 11- and 13-path tasks compacted mid-task or stalled.
test('save_plan refuses a task over the write-path limit and keeps no plan until a valid one is saved', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-write-paths-');
  const { engine } = context;
  const wide = { ...WRITE_TASK, writePaths: Array.from({ length: ORCHESTRATOR_MAX_WRITE_PATHS + 1 }, (_, index) => `src/part${index}.ts`) };
  engine.parent.push([savePlan(planOf([wide])), savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const [refused, saved] = engine.parentToolOutputs();
  assert.match(refused ?? '', new RegExp(`^Not done:\\n- Task 'greeting' lists ${ORCHESTRATOR_MAX_WRITE_PATHS + 1} writePaths`, 'u'));
  assert.match(saved ?? '', /^Plan saved to .*plan\.md with 1 task\(s\)\./u);
});

test('update_tasks revises the saved plan and its Markdown, and save_plan only makes the first plan', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-update-tasks-');
  const { engine } = context;
  engine.parent.push([savePlan(),
    tool('update_tasks', { update: [{ taskId: 'greeting', set: { title: 'Write the greeting module' } }], add: [FAREWELL_TASK] }),
    savePlan(), tool('update_tasks', { retire: [{ taskId: 'nowhere', reason: 'Never planned.' }] }), dispatch({ taskId: 'farewell' }),
    { content: '{"status":"blocked","reason":"Stop after the farewell."}' }]);
  engine.children.push(FAREWELL_WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  const [, updated, replaced, unknown] = engine.parentToolOutputs();
  assert.match(updated ?? '', /^Plan updated: .*plan\.md now has 2 task\(s\)\./u);
  assert.match(replaced ?? '', /A plan is already saved; change it with update_tasks\./u);
  assert.match(unknown ?? '', /Task 'nowhere' is not in the saved plan\./u);
  assert.deepEqual(state.plan?.tasks.map((task) => [task.id, task.title]), [['greeting', 'Write the greeting module'], ['farewell', FAREWELL_TASK.title]]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['greeting', 'pending'], ['farewell', 'aborted']],
    'the dispatched task was open when the run stopped blocked');
  assert.ok(state.planPath);
  assert.match(fs.readFileSync(path.join(context.repo, state.planPath ?? ''), 'utf8'), /Write the greeting module/u);
});

test('update_tasks sent whole as a string inside its update argument, as a live run did, revises the plan', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-update-wrapped-');
  const { engine } = context;
  engine.parent.push([savePlan(), tool('update_tasks', { update: JSON.stringify({ add: [FAREWELL_TASK] }) }),
    { content: '{"status":"blocked","reason":"Stop after the update."}' }]);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.match(engine.parentToolOutputs()[1] ?? '', /^Plan updated: .*plan\.md now has 2 task\(s\)\./u);
  assert.deepEqual(state.plan?.tasks.map((task) => task.id), ['greeting', 'farewell']);
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
  const start = (planPath: string) => requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify(makeOrchestratorRequest({
    repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: null, planPath })) });

  const { state } = await followRun(context, OrchestratorRunStateSchema.parse((await start('docs/plan.md')).body).runId);
  assertCompleted(state, engine);
  assert.ok((engine.prompts('parent')[0] ?? '').includes('Supplied plan (docs/plan.md):\n<<<PLAN\n# Greeting plan\nWrite src/greeting.ts.\n\nPLAN>>>'));

  const missing = await followRun(context, OrchestratorRunStateSchema.parse((await start('docs/missing.md')).body).runId);
  assert.equal(missing.state.failure?.code, 'plan_not_found');
  assert.equal(engine.prompts('parent').length, 1, 'no conversation for a missing plan');
  const rejected = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify(makeOrchestratorRequest({
    repoRoot: context.repo, presetId: 'repo-agent', approval: 'off', task: 'x' })) });
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

test('while a child awaits a decision, code refuses a check, a second dispatch, a plan change, and a finish, and decide resumes it', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-one-child-');
  const { engine } = context;
  const refusedThenDecide: ParentTurn = (output) => ({ toolCalls: [
    tool('run_check', { command: 'node --version', cwd: '.' }),
    dispatch({ taskId: 'greeting', instruction: 'Again.' }),
    tool('update_tasks', { update: [{ taskId: 'greeting', set: { title: 'Renamed' } }] }),
    tool('decide', { approvalId: announcedApprovalId(output), decision: 'approve', reason: 'Inside its scope.' }),
  ].flatMap((turn) => turn.toolCalls ?? []) });
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), COMPLETE, refusedThenDecide, review('greeting', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER);

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assertCompleted(state, engine);
  const [, announced, check, again, update, decided] = engine.parentToolOutputs();
  // Real case (run 560566c3): told only "a child is still running", the orchestrator polled run_check for 28 turns
  // while its child sat paused on an approval it had already been shown.
  const waiting = `Child approval ${announcedApprovalId(announced ?? '')} is waiting for your decide; the child stays paused until you answer it.`;
  for (const refused of [check, again, update]) assert.ok((refused ?? '').includes(waiting), refused);
  assert.deepEqual(engine.parentFinishRejections(), [waiting], 'the early finish was refused, the last one accepted');
  assert.match(decided ?? '', /## greeting \(implementation attempt 1\): passed/u);
  assert.equal(state.attempts.length, 1, 'the refused dispatch started no child');
  assert.equal(state.plan?.tasks[0]?.title, WRITE_TASK.title, 'the refused update left the plan alone');
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

test('a failed finish needs a child to run before the next one, and a spent dispatch budget ends the run on a failing finish', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-dispatch-budget-');
  const { engine } = context;
  const failing: OrchestratorVerificationCheck = { kind: 'command', command: 'exit 1', cwd: '.', expectedExitCode: 0 };
  engine.parent.push([savePlan(planOf([WRITE_TASK], [failing])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    COMPLETE, COMPLETE,
    dispatch({ taskId: 'greeting', purpose: 'fix' }), review('greeting', 'pass'),
    dispatch({ taskId: 'greeting', purpose: 'fix' }), COMPLETE]);
  engine.children.push(WRITER, [writeFile('export const greeting = "hey";\n'), APPROVING_VERDICT, AGENT_REPORT]);

  const { state, events } = await followRun(context,
    (await startRun(context, 'off', { budget: { minutes: 60, dispatches: 2 } })).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'budget_exhausted');
  assert.match(state.failure?.message ?? '',
    /^Final verification still fails and the dispatch budget is spent \(2 of 2\): Check `exit 1` exited 1; expected 0\./u);
  assert.equal(events.filter((event) => event.message === 'Running final verification.').length, 2,
    'the second finish was refused before any check ran, because no child had run since the first');
  assert.equal(state.attempts.length, 2, 'the third dispatch started no child');
  assert.ok(engine.parentToolOutputs().some((output) => /The run's dispatch budget is spent \(2 of 2\)\. Finish now/u.test(output)));
});

test('a run that outlives its time budget stops as budget_exhausted, even while it waits on a person', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-deadline-');
  const { engine } = context;
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' })]);
  engine.children.push(WRITER);

  // Interactive approval parks the child's check on a person who never answers, so only the deadline can end the run.
  const { state } = await followRun(context,
    (await startRun(context, 'interactive', { budget: { minutes: 0.05, dispatches: 5 } })).runId);

  assert.equal(state.phase, 'failed');
  assert.deepEqual(state.failure, { code: 'budget_exhausted', message: "The run's time budget of 0.05 minutes is spent.", taskId: null });
  assert.equal(state.approval, null, 'the pending approval is cleared');
  assert.equal(state.tasks.some((task) => task.status === 'running' || task.status === 'reviewing'), false, 'no task is left looking live');
});

/** A command that replays a recorded check's output and exit code; run_check refuses a command that only reads. */
function replayCheckOutput(file: string, exitCode: number): string {
  return `node -e "process.stdout.write(require('node:fs').readFileSync('${file}', 'utf8')); process.exitCode = ${exitCode}"`;
}

test('run_check leads its result with the digest of the whole check output', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-digest-');
  const { engine } = context;
  // A check reads only inside its repository, so the fixture output is copied in first.
  fs.copyFileSync(digestFixturePath('pytest/fail.txt'), path.join(context.repo, 'pytest-fail.txt'));
  const command = replayCheckOutput('pytest-fail.txt', 1);
  engine.parent.push([savePlan(), tool('run_check', { command, cwd: '.' }), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const [, check] = engine.parentToolOutputs();
  assert.match(check ?? '', /exit 1\nDigest of the whole output:\npytest: FAILED \(2 failed, 1 passed\)\n✖ test_compares_lists — test_math\.py:4\n/u);
});

test('a run_check of a real passing suite returns its verdict and a bounded tail', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-pass-');
  const { engine } = context;
  fs.copyFileSync(digestFixturePath('node-test/real-run-pass.txt'), path.join(context.repo, 'suite-pass.txt'));
  engine.parent.push([savePlan(), tool('run_check', { command: replayCheckOutput('suite-pass.txt', 0), cwd: '.' }),
    dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const [, check = ''] = engine.parentToolOutputs();
  const verdict = 'exit 0\nDigest of the whole output:\nnode:test: passed (263 tests, 263 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo)\n';
  assert.ok(check.startsWith(verdict), check.slice(0, 300));
  assert.ok(check.length <= verdict.length + COMMAND_TAIL_CHARS, String(check.length));
  assert.match(check, /ℹ duration_ms 40987\.0442/u);
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
  const started = await startRun(context, 'interactive', { submissionId });
  assert.equal((await startRun(context, 'interactive', { submissionId })).runId, started.runId);
  const conflicting = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify(makeOrchestratorRequest({
    submissionId, repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: 'Something else.' })) });
  assert.equal(conflicting.statusCode, 400);

  await waitForApproval(context, started.runId);
  assert.ok(context.harness.describeLiveWork().includes(`orchestrator run ${started.runId}`), 'a dev restart would wait for the live run');
  const aborted = await requestJson(`${context.baseUrl}/orchestrator/abort`, { method: 'POST', body: JSON.stringify({ runId: started.runId }) });
  assert.equal(aborted.statusCode, 200, JSON.stringify(aborted.body));
  const state = OrchestratorRunStateSchema.parse(aborted.body);
  assert.equal(state.phase, 'aborted');
  assert.equal(state.approval, null);
  assert.equal(fs.existsSync(path.join(context.repo, TARGET)), false, 'the parked write never ran');
  assert.equal((await followRun(context, started.runId)).state.phase, 'aborted', 'a reconnect reports the terminal state');
  assert.deepEqual(context.harness.describeLiveWork(), [], 'nothing holds a dev restart once the run ended');
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
    tasks: z.array(z.object({ taskId: z.string(), review: z.string().nullable(), report: z.object({ status: z.string() }).loose().nullable() })),
    attempts: z.array(z.object({ outcome: z.string().nullable() }).loose()) }).loose().parse(parseJsonValueText(stdout.text));
  assert.equal(result.status, 'completed');
  assert.deepEqual([result.tasks[0]?.review, result.tasks[0]?.report?.status, result.attempts[0]?.outcome], ['pass', 'completed', 'passed']);
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
  assert.deepEqual(scheduled?.claims.map(({ taskId, modelId }) => ({ taskId, modelId })),
    [{ taskId: 'greeting', modelId: ALTERNATE_MODEL_PRESET_ID }]);
  assert.deepEqual(scheduled?.waits, []);
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
  const dependent = { ...FAREWELL_TASK, dependsOn: ['greeting'] };
  engine.parent.push([savePlan(planOf([WRITE_TASK, dependent])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]);
  engine.children.push(ESCALATING_WRITER, FAREWELL_WRITER);
  const started = await startRun(context, 'interactive');
  const following = followRun(context, started.runId);

  let approval = await waitForApprovalOrEnd(context, started.runId);
  await context.harness.updateOperationPreset('repo-agent', { allowedTools: ['read', 'edit'] });
  while (approval !== null) {
    await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approvalId, decision: 'approve' }) });
    approval = await waitForApprovalOrEnd(context, started.runId);
  }

  const { state } = await following;
  assertCompleted(state, engine);
  assert.notDeepEqual(engine.requireRepoSearch('Create src/farewell.ts exporting farewell').allowedTools, ['read', 'edit'],
    'the second writer keeps the tools the run started with');
});

test('the orchestrator is told which uncommitted changes predate the run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-preexisting-dirty-');
  const { engine } = context;
  fs.writeFileSync(path.join(context.repo, 'src', 'app.ts'), 'export const app = 1;\n// local note\n');
  engine.parent.push([{ content: '{"status":"blocked","reason":"Nothing to do."}' }]);

  await followRun(context, (await startRun(context, 'off')).runId);

  assert.match(engine.prompts('parent')[0] ?? '', /Uncommitted changes that predate this run \(never count them against any task\): src\/app\.ts\./u);
});

/** A child that never creates the target: it reads, then reports until its resubmits run out. */
function neverWrites(): MockPlannerResponseInput[] {
  return [tool('read', { path: 'src/app.ts' }), AGENT_REPORT, AGENT_REPORT, AGENT_REPORT];
}

test('a task out of attempts blocks the finish until it is retired and replaced under a new id; the run then completes', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-retire-');
  const { engine } = context;
  const failing = (purpose: OrchestratorChildPurpose) => [dispatch({ taskId: 'greeting', purpose }), review('greeting', 'fail')];
  engine.parent.push([savePlan(), ...failing('implementation'), ...failing('implementation'), ...failing('fix'), ...failing('fix'),
    COMPLETE,
    tool('update_tasks', { retire: [{ taskId: 'greeting', reason: 'Four children never created the file.' }],
      add: [{ ...WRITE_TASK, id: 'greeting-2' }] }),
    dispatch({ taskId: 'greeting-2' }), review('greeting-2', 'pass'), COMPLETE]);
  engine.children.push(neverWrites(), neverWrites(), neverWrites(), neverWrites(), WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status]), [['greeting-2', 'completed']]);
  assert.deepEqual(state.retiredTasks.map((task) => [task.taskId, task.status, task.approach, task.reason]),
    [['greeting', 'failed', 1, 'Four children never created the file.']]);
  assert.equal(state.attempts.length, 5, 'the retired task keeps its four attempts on record');
  const outputs = engine.parentToolOutputs();
  assert.ok(outputs.some((output) => /Recorded fail for greeting; it is now failed\. It is out of attempts: retire it/u.test(output)));
  assert.ok(outputs.some((output) => /^Plan updated: .*plan\.md now has 1 task\(s\)\./u.test(output)));
  assert.doesNotMatch(fs.readFileSync(path.join(context.repo, state.planPath ?? ''), 'utf8'), /## Task greeting:/u);
});

function changeApproachTo(title: string, lesson: string, rollback: boolean) {
  return tool('change_approach', { title, lesson, rollback });
}

test('change_approach with rollback puts the files back, records the dropped task with the lesson, and the next approach completes the run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-rollback-');
  const { engine } = context;
  const lesson = 'A constant greeting cannot be localised.';
  engine.parent.push([savePlan(), dispatch({ taskId: 'greeting' }), review('greeting', 'fail'),
    changeApproachTo('Farewell first', lesson, true), tool('update_tasks', { add: [FAREWELL_TASK] }),
    dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]);
  engine.children.push(WRITER, FAREWELL_WRITER);

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.equal(fs.existsSync(path.join(context.repo, TARGET)), false, 'the rolled-back approach left no file behind');
  assert.ok(fs.existsSync(path.join(context.repo, 'src', 'farewell.ts')));
  assert.deepEqual(state.approaches.map((approach) => [approach.number, approach.title, approach.outcome?.kind ?? 'active', approach.outcome?.lesson ?? null]),
    [[1, 'Initial plan', 'rolled_back', lesson], [2, 'Farewell first', 'active', null]]);
  assert.deepEqual(state.retiredTasks.map((task) => [task.taskId, task.status, task.approach, task.reason]), [['greeting', 'reviewing', 1, lesson]]);
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['farewell', 'completed', 2]]);
  const changed = engine.parentToolOutputs().find((output) => output.startsWith('Approach 1 ended')) ?? '';
  assert.match(changed, /^Approach 1 ended, rolled back \(\d+ file\(s\) restored\)\. Approach 2 is active: Farewell first\./u);
  assert.match(changed, /Restored: .*src\/greeting\.ts/u);
  assert.ok(events.some((event) => /^Approach 1 rolled back \(\d+ file\(s\) restored\); approach 2 began: Farewell first\.$/u.test(event.message)));
});

test('change_approach without rollback keeps the files, closes completed tasks, and carries open tasks into the next approach', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-keep-');
  const { engine } = context;
  engine.parent.push([savePlan(planOf([WRITE_TASK, FAREWELL_TASK])), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'),
    changeApproachTo('Second design', 'The greeting works; the farewell needs another design.', false),
    dispatch({ taskId: 'greeting', purpose: 'fix' }), dispatch({ taskId: 'farewell' }), review('farewell', 'pass'), COMPLETE]);
  engine.children.push(WRITER, FAREWELL_WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), GREETING, 'a kept approach keeps its files');
  assert.deepEqual(state.tasks.map((task) => [task.taskId, task.status, task.approach]), [['greeting', 'completed', 1], ['farewell', 'completed', 2]]);
  assert.deepEqual(state.approaches.map((approach) => approach.outcome?.kind ?? 'active'), ['kept', 'active']);
  assert.deepEqual(state.retiredTasks, []);
  assert.ok(engine.parentToolOutputs().some((output) => /Task 'greeting' was completed in approach 1, which has ended/u.test(output)),
    'a closed task takes no fix');
  assert.equal(state.attempts.length, 2, 'the refused fix started no child');
});
