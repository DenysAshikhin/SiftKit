import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import {
  ORCHESTRATOR_ACTIVITY_FRAME,
  OrchestratorActivitySchema,
  OrchestratorPlanPreparationSchema,
  OrchestratorProgressSchema,
  OrchestratorRunStateSchema,
  type ApprovalMode,
  type OrchestratorDriftFinding,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';
import { runCli } from '../../src/cli/dispatch.ts';
import { parseJsonText, parseJsonValueText } from '../../src/lib/json.ts';
import { z } from '../../src/lib/zod.ts';
import type { RepoSearchExecutionRequest } from '../../src/repo-search/types.ts';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from '../helpers/dashboard-model-queue-harness.ts';
import { requestJson } from '../helpers/dashboard-http.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from '../helpers/orchestrator-plan.ts';
import { ESCALATING_VERDICTS, ScriptedEngineService, finalAnswer } from '../helpers/scripted-engine-service.ts';
import { requestSse } from '../helpers/sse-http.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

const MODEL_A = 'exl3-main';
const RUN_TIMEOUT_MS = 120_000;
const TARGET = 'src/greeting.ts';
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

function writePlan(dependents = false): OrchestratorPlan {
  const write = makeOrchestratorTask({ id: 'greeting', title: 'Add the greeting module', workerPresetId: 'repo-agent',
    readPaths: ['src/app.ts'], writePaths: [TARGET], verification: [TARGET_EXISTS],
    steps: [{ instruction: `Create ${TARGET} exporting greeting.`, expectedResult: 'The module exists.' }],
    acceptance: ['src/greeting.ts exports greeting.'] });
  const dependent = makeOrchestratorTask({ id: 'report', dependsOn: ['greeting'], readPaths: [TARGET],
    verification: [PASSING_CHECK], steps: [{ instruction: 'Report the greeting.', expectedResult: 'The greeting.' }] });
  return { ...makeOrchestratorPlan(dependents ? [write, dependent] : [write]), finalVerification: [PASSING_CHECK] };
}

function planAnswer(plan: OrchestratorPlan) {
  return finalAnswer(JSON.stringify({ status: 'generated', plan, issues: [] }));
}

const APPROVE_CHECK = finalAnswer('{"decision":"approve","reason":"A read-only check of the planned file."}');

function writeFile(content: string) {
  return { toolCalls: [{ name: 'write', arguments: { path: TARGET, content } }] };
}

/** A write into the attempt's scratch directory, read from its instruction. */
function scratchNote(request: RepoSearchExecutionRequest) {
  const scratch = /Scratch directory for temporary files: (\S+)/u.exec(request.prompt)?.[1];
  if (scratch === undefined) throw new Error(`Expected an implementation prompt, got: ${request.prompt.slice(0, 120)}`);
  return { toolCalls: [{ name: 'write', arguments: { path: `${scratch}/note.txt`, content: 'temporary\n' } }] };
}

function digestOf(request: RepoSearchExecutionRequest): string {
  const digest = /Change digest: ([0-9a-f]{64})/u.exec(request.prompt)?.[1];
  if (digest === undefined) throw new Error(`Expected a drift review prompt, got: ${request.prompt.slice(0, 120)}`);
  return digest;
}

const LEGACY_LINE = 'export const greeting = legacyGreeting() ?? "hi";';
const FINDING: OrchestratorDriftFinding = {
  id: 'D1', title: 'Parallel legacy path', purpose: 'One greeting source.', directive: 'No compatibility shims.',
  evidence: [{ path: TARGET, line: 1, snippet: LEGACY_LINE }], impact: 'Two greeting paths diverge.',
  fix: 'Remove legacyGreeting and export the literal.', affectedPaths: [TARGET], verification: [TARGET_EXISTS],
};

function driftReview(status: 'clean' | 'actionable', resolutions: { findingId: string; evidence: string }[] = []) {
  return (request: RepoSearchExecutionRequest) => finalAnswer(JSON.stringify({
    taskId: 'greeting', changeDigest: digestOf(request), scopePaths: [TARGET], resolutions, status,
    findings: status === 'clean' ? [] : [FINDING],
  }));
}

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
    submissionId, repoRoot: context.repo, presetId: 'orchestrator', approval, task: 'Add a greeting module.', planPath: null,
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

test('a child approval unloads the child model for the parent decision and reloads it to continue the same attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-bab-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...ESCALATING_VERDICTS, ...finalAnswer('Created src/greeting.ts.')]);
  engine.parent.push(finalAnswer('{"decision":"approve","reason":"Creates the planned file inside its scope."}'));
  engine.parent.push(APPROVE_CHECK);
  engine.parent.push(driftReview('clean'));
  engine.parent.push(APPROVE_CHECK);

  const started = await startRun(context, 'auto');
  const { state, events } = await followRun(context, started.runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(context.harness.loadedModelNames, ['model-a', 'model-b', 'model-a', 'model-b', 'model-a'],
    'plan on A, child on B, parent approval on A, the same child resumes on B, review on A');
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt, attempt.status]), [['implementation', 1, 'settled']]);
  assert.equal(engine.prompts('children').length, 1, 'approval continuation is not a new child');
  assert.match(engine.prompts('parent')[1] ?? '', /decide a subagent's permission request/u);
  assert.match(engine.prompts('parent')[1] ?? '', /Tool: write/u);
  assert.equal(fs.readFileSync(path.join(context.repo, TARGET), 'utf8'), 'export const greeting = "hi";\n');
  assert.ok(fs.existsSync(path.join(context.repo, state.planPath ?? 'missing')));
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.some((event) => event.message.startsWith('Approval requested: write')));
  const childRequests = engine.repoSearchRequests.filter((request) => request.taskKind !== 'orchestrator');
  assert.deepEqual([...new Set(childRequests.map((request) => request.requestId))], [state.attempts[0]?.childRunId],
    'the child transcript is keyed by its reserved child run ID');
});

test('a task that fails verification twice stops after two implementation children and never starts its dependent', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-retry-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan(true)));
  for (const attempt of [1, 2]) {
    engine.children.push((request) => [scratchNote(request),
      { toolCalls: [{ name: 'write', arguments: { path: 'src/wrong.ts', content: `// ${attempt}\n` } }] }, ...finalAnswer('Done.')]);
  }

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'implementation_failed');
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt]), [['implementation', 1], ['implementation', 2]]);
  const [first, second] = engine.prompts('children');
  assert.match(first ?? '', /implementation attempt 1 of 2/u);
  assert.match(second ?? '', /implementation attempt 2 of 2/u);
  assert.match(second ?? '', /exited 1; expected 0/u, 'the retry carries the observed check failure');
  assert.match(second ?? '', /src\/wrong\.ts/u, 'the retry carries the previous attempt\'s changes');
  assert.equal(state.tasks.find((task) => task.taskId === 'report')?.status, 'pending');
  assert.equal(engine.prompts('children').length, 2);
  const scratch = path.join(context.repo, '.siftkit', 'orchestrator', state.runId, 'scratch');
  assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], 'a failed run leaves no scratch files');
});

test('a drift correction runs on the task\'s own worker preset, so it holds the model slot the task claimed', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-drift-worker-');
  const { engine } = context;
  await context.harness.copyOperationPreset('repo-agent', { id: 'site-writer', label: 'Site writer', modelPresetId: MODEL_A });
  const plan = writePlan();
  engine.parent.push(planAnswer({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, workerPresetId: 'site-writer' })) }));
  engine.children.push([writeFile(`${LEGACY_LINE}\n`), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('actionable'));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Removed the legacy path.')]);
  engine.parent.push(driftReview('clean', [{ findingId: 'D1', evidence: 'src/greeting.ts:1 exports the literal only' }]));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const fix = state.attempts.find((attempt) => attempt.purpose === 'drift_fix');
  assert.ok(fix);
  const fixRequests = engine.repoSearchRequests.filter((request) => request.requestId === fix.childRunId);
  assert.ok(fixRequests.length > 0);
  assert.deepEqual([...new Set(fixRequests.map((request) => request.presetId))], ['site-writer']);
});

test('actionable drift is fixed by one bullet correction child and a fresh clean review completes the task', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-drift-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile(`${LEGACY_LINE}\n`), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('actionable'));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Removed the legacy path.')]);
  engine.parent.push(driftReview('clean', [{ findingId: 'D1', evidence: 'src/greeting.ts:1 exports the literal only' }]));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt]), [['implementation', 1], ['drift_fix', 1]]);
  const correction = engine.prompts('children')[1] ?? '';
  assert.match(correction, /^Resolve only the confirmed drift in step greeting\./u);
  assert.match(correction, /- D1: Parallel legacy path/u);
  assert.match(correction, /Fix: Remove legacyGreeting and export the literal\./u);
  assert.doesNotMatch(correction, /from plan /u, 'a correction carries bullets, not a plan');
  const task = state.tasks.find((entry) => entry.taskId === 'greeting');
  assert.equal(task?.driftReview?.status, 'clean');
  assert.equal(task?.reviewedDigests.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(context.repo, '.siftkit', 'orchestrator', state.runId)).sort(), ['plan.md', 'scratch']);
});

test('drift still present after two corrections stops with the unresolved finding and no fifth child', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-drift-limit-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile(`${LEGACY_LINE}\n`), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('actionable'));
  for (const note of ['first', 'second']) {
    engine.children.push([writeFile(`${LEGACY_LINE}\n// ${note}\n`), ...finalAnswer('Tried.')]);
    engine.parent.push(driftReview('actionable'));
  }

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'drift_unresolved');
  assert.deepEqual(state.failure?.findingIds, ['D1']);
  assert.deepEqual(state.attempts.map((attempt) => [attempt.purpose, attempt.attempt]),
    [['implementation', 1], ['drift_fix', 1], ['drift_fix', 2]]);
  assert.equal(engine.prompts('children').length, 3);
});

test('interactive runs forward child and verification approvals to the person, by exact approval ID', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-interactive-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));
  const started = await startRun(context, 'interactive');
  const following = followRun(context, started.runId);

  const childApproval = await waitForApproval(context, started.runId);
  assert.equal(childApproval.approval?.kind, 'child');
  const wrong = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
    body: JSON.stringify({ runId: started.runId, approvalId: randomUUID(), decision: 'approve' }) });
  assert.equal(wrong.statusCode, 409);
  const kinds: string[] = [];
  const commands: string[] = [];
  for (let approval: OrchestratorRunState | null = childApproval; approval !== null;) {
    kinds.push(approval.approval?.kind ?? 'none');
    if (approval.approval?.kind === 'check') commands.push(approval.approval.command);
    const decided = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approvalId, decision: 'approve' }) });
    assert.equal(decided.statusCode, 200, JSON.stringify(decided.body));
    approval = kinds.length < 3 ? await waitForApproval(context, started.runId) : null;
  }

  const { state } = await following;
  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(kinds, ['child', 'check', 'check'], 'the child write, the task check, then the final check');
  assert.deepEqual(commands, [TARGET_EXISTS.command, PASSING_CHECK.command], 'each check command is approved on its own');
  assert.equal(engine.prompts('parent').some((prompt) => prompt.includes('permission request')), false,
    'an interactive run never lets the parent decide');
});

test('a duplicate submission returns the same parent and abort stops a parked child', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-abort-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  const submissionId = randomUUID();
  const started = await startRun(context, 'interactive', submissionId);
  assert.equal((await startRun(context, 'interactive', submissionId)).runId, started.runId);
  const conflicting = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId, repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: 'Something else.', planPath: null }) });
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
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));
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
    tasks: z.array(z.object({ taskId: z.string(), output: z.string().nullable() }).loose()) }).loose()
    .parse(parseJsonValueText(stdout.text));
  assert.equal(result.status, 'completed');
  assert.match(result.tasks[0]?.output ?? '', /Created\./u, 'the caller sees the worker answer');
  assert.match(stderr.text, /\[orchestrator #1\] preparing_plan: Orchestrator run created\./u);
  assert.match(stderr.text, /Reserved implementation attempt 1\./u);
  const status = new CollectingStream();
  assert.equal(await runCli({ argv: ['orchestrator', 'status', result.runId], stdout: status, stderr }), 0);
  assert.equal(z.object({ status: z.string() }).loose().parse(parseJsonValueText(status.text)).status, 'completed');
});

test('a supplied adequate plan is kept as is, and malformed parent output gets exactly one retry', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-supplied-');
  const { engine } = context;
  const plan = writePlan();
  fs.mkdirSync(path.join(context.repo, 'docs'));
  fs.writeFileSync(path.join(context.repo, 'docs', 'plan.md'), '# Greeting plan\n');
  engine.parent.push(finalAnswer('Here is my plan: add the file.'));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'ready', plan })));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const response = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId: randomUUID(), repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: null, planPath: 'docs/plan.md' }) });
  const { state, events } = await followRun(context, OrchestratorRunStateSchema.parse(response.body).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.equal(state.planPath, 'docs/plan.md');
  assert.equal(fs.existsSync(path.join(context.repo, '.siftkit', 'orchestrator', state.runId, 'plan.md')), false, 'no second plan file');
  assert.match(engine.prompts('parent')[1] ?? '', /Your previous answer was rejected/u);
  assert.match(engine.prompts('children')[0] ?? '', /from plan docs\/plan\.md/u);
  assert.ok(events.some((event) => /^Parent phase started: plan preparation; retrying after: Provider returned an invalid plan_preparation payload/u
    .test(event.message)));
});

test('malformed plan-preparation JSON is repaired inside the phase by one constrained turn, with no phase retry', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-answer-repair-');
  const { engine } = context;
  const plan = JSON.stringify({ status: 'generated', plan: writePlan(), issues: [] });
  const broken = `Here is the plan: ${plan.slice(0, -40)}`;
  engine.parent.push([{ content: broken }, { content: plan }]);
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message === 'Validating the plan.'));
  assert.equal(events.some((event) => event.message.startsWith('Parent phase started: plan preparation; retrying after')), false);
  assert.equal(engine.repoSearchRequests[0]?.answerSchema?.name, 'plan_preparation');
  assert.equal(engine.repoSearchRequests[0]?.answerSchema?.schema, OrchestratorPlanPreparationSchema);
});

test('a blocked plan and a missing plan file fail precisely before any child starts', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-blocked-');
  const { engine } = context;
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'blocked', reason: 'The task names two different modules.' })));
  const blocked = await followRun(context, (await startRun(context, 'off')).runId);
  assert.equal(blocked.state.failure?.code, 'plan_blocked');
  assert.match(blocked.state.failure?.message ?? '', /two different modules/u);

  const response = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId: randomUUID(), repoRoot: context.repo, presetId: 'orchestrator', approval: 'off', task: null, planPath: 'docs/missing.md' }) });
  const missing = await followRun(context, OrchestratorRunStateSchema.parse(response.body).runId);
  assert.equal(missing.state.failure?.code, 'plan_not_found');
  assert.equal(engine.prompts('children').length, 0);
  const rejected = await requestJson(`${context.baseUrl}/orchestrator`, { method: 'POST', body: JSON.stringify({
    submissionId: randomUUID(), repoRoot: context.repo, presetId: 'repo-agent', approval: 'off', task: 'x', planPath: null }) });
  assert.equal(rejected.statusCode, 400);
  assert.match(String(rejected.body.error), /not an orchestrator/u);
});

test('an auto run asks the parent before each check command and never runs a denied one', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-denied-');
  const { engine } = context;
  const markerCheck: OrchestratorVerificationCheck = { kind: 'command', command: 'Set-Content check-ran.txt ran; exit 0', cwd: '.', expectedExitCode: 0 };
  const inspect = makeOrchestratorTask({ readPaths: ['src/app.ts'], verification: [markerCheck] });
  engine.parent.push(planAnswer({ ...makeOrchestratorPlan([inspect]), finalVerification: [PASSING_CHECK] }));
  for (const attempt of [1, 2]) {
    engine.children.push(finalAnswer(`Inspected, attempt ${attempt}.`));
    engine.parent.push(finalAnswer('{"decision":"deny","reason":"Writes a file outside the task scope."}'));
  }

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'implementation_failed');
  assert.match(state.failure?.message ?? '', /never ran/u);
  assert.equal(fs.existsSync(path.join(context.repo, 'check-ran.txt')), false, 'a denied check never runs');
  const checkPrompts = engine.prompts('parent').filter((prompt) => prompt.includes('verification command'));
  assert.equal(checkPrompts.length, 2);
  assert.match(checkPrompts[0] ?? '', /Set-Content check-ran\.txt ran; exit 0/u);
});

test('a run keeps the configuration it started with when presets change mid-run', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-pinned-config-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan(true)));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));
  engine.children.push(finalAnswer('The greeting is hi.'));
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
  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const report = engine.requireRepoSearch('Report the greeting.');
  assert.notDeepEqual(report.allowedTools, ['read'], 'the report child keeps the tools the run started with');
});

const ENGINE_CRASH = 'TabbyAPI exited unexpectedly (code=1, signal=null).';

function readOnlyPlan(verification: OrchestratorVerificationCheck[]): OrchestratorPlan {
  const inspect = makeOrchestratorTask({ readPaths: ['src/app.ts'], verification,
    steps: [{ instruction: 'Report the value of app in src/app.ts.', expectedResult: 'The value.' }] });
  return { ...makeOrchestratorPlan([inspect]), finalVerification: [PASSING_CHECK] };
}

test('a parent phase hit by an engine failure is retried once as a new phase with the reason recorded', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-infra-retry-');
  const { engine } = context;
  engine.parent.push(new Error(ENGINE_CRASH));
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message === 'Parent phase started: plan preparation.'));
  assert.ok(events.some((event) => event.message.startsWith(
    `Parent phase started: plan preparation; retrying after: infrastructure failure: ${ENGINE_CRASH}`)));
});

test('an engine failure twice in one approval decision fails the run as infrastructure, never as a denial', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-infra-fail-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(new Error(ENGINE_CRASH));
  engine.parent.push(new Error(ENGINE_CRASH));

  const { state, events } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'infrastructure_failed');
  assert.match(state.failure?.message ?? '', /approval decision phase failed 2 times: TabbyAPI exited unexpectedly/u);
  assert.equal(events.some((event) => /Not run|deny/u.test(event.message)), false, 'no check was denied');
});

test('an approval decision after prose is accepted and the decision is recorded', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-decision-prose-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(finalAnswer('Checked: it only exits.\n{"decision":"approve","reason":"A no-op check."}'));
  engine.parent.push(APPROVE_CHECK);

  const { state, events } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message === 'Approval resolved: approve.'));
});

test('an unusable approval decision is retried once, then fails the run instead of denying', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-decision-invalid-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(finalAnswer('Looks fine to me.'));
  engine.parent.push(finalAnswer('Still fine.'));

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'approval_decision_invalid');
  const decisions = engine.prompts('parent').filter((prompt) => prompt.includes('verification command'));
  assert.equal(decisions.length, 2);
  assert.match(decisions[1] ?? '', /Your previous answer was rejected:\n- Provider returned an invalid approval_decision payload/u);
});

test('a review citing a snippet that is not in the file is re-asked, and the worker keeps its attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-review-citation-');
  const { engine } = context;
  const evidence: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm app is 1.', paths: ['src/app.ts'] };
  engine.parent.push(planAnswer(readOnlyPlan([evidence])));
  engine.children.push(finalAnswer('app is 1 (src/app.ts:1).'));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1; // the only export' }] })));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1;' }] })));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(state.attempts.map((attempt) => [attempt.attempt, attempt.result?.passed]), [[1, true]]);
  const reviews = engine.prompts('parent').filter((prompt) => prompt.includes('\nPhase: review the evidence'));
  assert.equal(reviews.length, 2);
  assert.match(reviews[1] ?? '', /Your previous review was rejected:\n- Review evidence: src\/app\.ts:1 does not contain the cited snippet\./u);
});

const BAD_CITATION = finalAnswer(JSON.stringify({ status: 'pass',
  evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1; // the only export' }] }));

/** A read-only task checked by command, then a final evidence review of src/app.ts. */
function finalEvidencePlan(): OrchestratorPlan {
  const evidence: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm app is 1.', paths: ['src/app.ts'] };
  return { ...readOnlyPlan([PASSING_CHECK]), finalVerification: [evidence] };
}

test('a final review citing a snippet that is not in the file is re-asked once and the run completes', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-final-citation-');
  const { engine } = context;
  engine.parent.push(planAnswer(finalEvidencePlan()));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(BAD_CITATION);
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1;' }] })));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message.startsWith(
    'Parent phase started: final verification; retrying after: Review evidence: src/app.ts:1 does not contain the cited snippet.')));
  const finals = engine.prompts('parent').filter((prompt) => prompt.includes('\nPhase: final verification'));
  assert.equal(finals.length, 2);
  assert.match(finals[1] ?? '', /Your previous review was rejected:\n- Review evidence: src\/app\.ts:1 does not contain the cited snippet\./u);
});

test('a final review that cites badly twice fails the run as an unusable final review', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-final-citation-twice-');
  const { engine } = context;
  engine.parent.push(planAnswer(finalEvidencePlan()));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(BAD_CITATION, BAD_CITATION);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'final_review_invalid');
  assert.match(state.failure?.message ?? '', /Review evidence: src\/app\.ts:1 does not contain the cited snippet\./u);
});

test('a plan whose check cannot run in the check shell is rejected and re-planned before any child starts', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-shell-');
  const { engine } = context;
  // A name no machine resolves; live S4 failed the same way on `grep`, which some PATHs do provide.
  const missingToolCheck: OrchestratorVerificationCheck = { kind: 'command', command: 'node --version | siftkit-missing-tool v', cwd: '.',
    expectedExitCode: 0 };
  const unrunnable = writePlan();
  engine.parent.push(planAnswer({ ...unrunnable, tasks: unrunnable.tasks.map((task) => ({ ...task, verification: [missingToolCheck] })) }));
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message.startsWith('Plan rejected: Check `node --version | siftkit-missing-tool v` cannot run in PowerShell')));
  assert.match(engine.prompts('parent')[1] ?? '', /'siftkit-missing-tool' is not a PowerShell command/u);
  assert.match(engine.prompts('parent')[0] ?? '', /Command checks run in PowerShell \(Windows, powershell\.exe\)/u);
  assert.equal(engine.prompts('children').length, 1);
});

/** Waits up to 20 s for the writer's file, so the reader can settle only once both tasks overlapped. */
const WAIT_FOR_TARGET: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0,
  command: `$deadline = (Get-Date).AddSeconds(20); while (-not (Test-Path ${TARGET})) { if ((Get-Date) -gt $deadline) { exit 1 }; `
    + 'Start-Sleep -Milliseconds 50 }; exit 0' };

test('with two parallel slots a writer and an independent reader run together and the reader is never charged with the write',
  async (t) => {
    const context = await startHarness(t, 'siftkit-orchestrator-parallel-');
    const { engine } = context;
    await context.harness.updateParallelSlots(2);
    await context.harness.assignOperationModel('repo-agent', MODEL_A);
    const reader = makeOrchestratorTask({ id: 'read-app', readPaths: ['src/app.ts'], verification: [WAIT_FOR_TARGET],
      steps: [{ instruction: 'Report the value of app in src/app.ts.', expectedResult: 'The value.' }] });
    const plan = writePlan();
    engine.parent.push(planAnswer({ ...plan, tasks: [...plan.tasks, reader] }));
    // The two children may reach the engine in either order, so each answers by its own prompt.
    const child = (request: RepoSearchExecutionRequest) => (request.prompt.includes('Report the value of app')
      ? finalAnswer('app is 1.')
      : [writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
    engine.children.push(child, child);
    engine.parent.push(driftReview('clean'));

    const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

    assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
    const firstSettled = events.findIndex((event) => event.message.startsWith('Settled'));
    const started = events.slice(0, firstSettled).filter((event) => / running\.$/u.test(event.message)).map((event) => event.taskId);
    assert.deepEqual(started.sort(), ['greeting', 'read-app'], 'both tasks were running before either settled');
    const readAttempt = state.attempts.find((attempt) => attempt.taskId === 'read-app');
    assert.deepEqual(readAttempt?.result?.changedPaths, []);
    assert.deepEqual(readAttempt?.result?.scopeViolations, []);
    assert.match(engine.prompts('parent')[0] ?? '', /2 parallel slots/u);
    assert.match(engine.prompts('parent')[0] ?? '', /at most one task that modifies files at a time/u);
  });

test('the events stream carries live child activity: each scheduler pass, the child\'s turns and tool calls, and nothing once it settles', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-activity-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const started = await startRun(context, 'off');
  const response = await requestSse(`${context.baseUrl}/orchestrator/events`, {
    body: { runId: started.runId, afterSequence: 0 }, timeoutMs: RUN_TIMEOUT_MS,
  });
  const state = OrchestratorRunStateSchema.parse(response.result);
  const activities = response.frames
    .filter((frame) => frame.event === ORCHESTRATOR_ACTIVITY_FRAME)
    .map((frame) => parseJsonText(frame.data, OrchestratorActivitySchema));

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const scheduled = activities.find((activity) => activity.schedule !== null)?.schedule;
  assert.deepEqual(scheduled?.claims.map(({ taskId, modelId, mutating }) => ({ taskId, modelId, mutating })),
    [{ taskId: 'greeting', modelId: ALTERNATE_MODEL_PRESET_ID, mutating: true }]);
  assert.deepEqual([scheduled?.models, scheduled?.writerUsed], [[{ modelId: ALTERNATE_MODEL_PRESET_ID, slots: 1, used: 1 }], true],
    'the first pass started the writer');
  assert.deepEqual(activities.at(-1)?.schedule?.models, [{ modelId: ALTERNATE_MODEL_PRESET_ID, slots: 1, used: 0 }],
    'the last pass holds nothing');
  const childViews = activities.flatMap((activity) => activity.children);
  assert.ok(childViews.length > 0, 'the running child was published');
  assert.ok(childViews.every((child) => child.childRunId === state.attempts[0]?.childRunId && child.taskId === 'greeting'));
  assert.ok(childViews.some((child) => child.turn >= 1 && child.maxTurns !== null), 'turns are reported');
  const tools = childViews.flatMap((child) => child.tools);
  const written = tools.find((tool) => tool.status === 'running');
  assert.ok(written, 'a tool call was seen while running');
  assert.ok(tools.some((tool) => tool.toolCallId === written.toolCallId && tool.status === 'succeeded'), 'and then settled');
  assert.deepEqual(activities.at(-1)?.children, [], 'a settled child leaves the view');
  const childRunId = state.attempts[0]?.childRunId;
  assert.ok(childRunId);
  const transcript = await requestJson(`${context.baseUrl}/dashboard/runs/${encodeURIComponent(childRunId)}`);
  assert.equal(transcript.statusCode, 200, 'the Logs tab finds the child transcript by its child run ID');
});

test('a client that connects mid-run starts from the live snapshot, and an aborted child leaves the view before the run ends', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-activity-snapshot-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
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
  const activities = response.frames
    .filter((frame) => frame.event === ORCHESTRATOR_ACTIVITY_FRAME)
    .map((frame) => parseJsonText(frame.data, OrchestratorActivitySchema));

  assert.equal(OrchestratorRunStateSchema.parse(response.result).phase, 'aborted');
  assert.deepEqual(activities[0]?.children.map((child) => [child.childRunId, child.taskId]), [[childRunId, 'greeting']],
    'the first frame is the live snapshot, sent before anything changed');
  assert.equal(activities[0]?.schedule?.writerUsed, true);
  assert.deepEqual(activities.at(-1)?.children, [], 'the aborted child was untracked before the terminal result');
});

test('parallel tasks take turns with their approvals, so every approval can be answered', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-parallel-approvals-');
  const { engine } = context;
  await context.harness.updateParallelSlots(2);
  const readers = ['read-one', 'read-two'].map((id) => makeOrchestratorTask({ id, readPaths: ['src/app.ts'], verification: [PASSING_CHECK],
    steps: [{ instruction: `Report the value of app in src/app.ts (${id}).`, expectedResult: 'The value.' }] }));
  engine.parent.push(planAnswer({ ...makeOrchestratorPlan(readers), finalVerification: [PASSING_CHECK] }));
  engine.children.push(finalAnswer('app is 1.'), finalAnswer('app is 1.'));
  const started = await startRun(context, 'interactive');
  const following = followRun(context, started.runId);

  let answered = 0;
  for (let approval = await waitForApprovalOrEnd(context, started.runId); approval !== null;
    approval = await waitForApprovalOrEnd(context, started.runId)) {
    const decided = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approvalId, decision: 'approve' }) });
    assert.equal(decided.statusCode, 200, JSON.stringify(decided.body));
    answered += 1;
  }

  const { state } = await following;
  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.equal(answered, 3, 'both task checks and the final check');
});

test('the planner and the evidence reviewer are told which uncommitted changes predate their work', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-preexisting-dirty-');
  const { engine } = context;
  fs.writeFileSync(path.join(context.repo, 'src', 'app.ts'), 'export const app = 1;\n// local note\n');
  const evidence: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm app is 1.', paths: ['src/app.ts'] };
  engine.parent.push(planAnswer(readOnlyPlan([evidence])));
  engine.children.push(finalAnswer('app is 1 (src/app.ts:1).'));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1;' }] })));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const [plan, review] = engine.prompts('parent');
  assert.match(plan ?? '', /Uncommitted changes that predate this run \(not made by it; never count them against it\): src\/app\.ts/u);
  assert.ok((review ?? '').includes(
    'Uncommitted changes that predate this run (not made by it; never count them against it): src/app.ts'), review);
  assert.ok((review ?? '').includes('Uncommitted changes that predate this task, beyond those listed in the run context '
    + '(not made by it; never count them against it): none'), review);
});

test('a reader that starts after the writer finished is still charged with its own change to the writer\'s file', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-late-reader-');
  const { engine } = context;
  const touchTarget: OrchestratorVerificationCheck = { kind: 'command', cwd: '.', expectedExitCode: 0,
    command: `Add-Content -Path ${TARGET} -Value '// touched by a reader check'; exit 0` };
  const plan = writePlan(true);
  engine.parent.push(planAnswer({ ...plan, tasks: plan.tasks.map((task) => (task.id === 'report' ? { ...task, verification: [touchTarget] } : task)) }));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));
  engine.children.push(finalAnswer('The greeting is hi.'), finalAnswer('The greeting is hi.'));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'implementation_failed');
  const readAttempt = state.attempts.find((attempt) => attempt.taskId === 'report');
  assert.deepEqual(readAttempt?.result?.scopeViolations, [TARGET]);
});

test('every parent phase reuses the run-start system context and run block, even after a writer adds a file', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-frozen-context-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...ESCALATING_VERDICTS, ...finalAnswer('Created.')]);
  engine.parent.push(finalAnswer('{"decision":"approve","reason":"Creates the planned file inside its scope."}'));
  engine.parent.push(APPROVE_CHECK);
  engine.parent.push(driftReview('clean'));
  engine.parent.push(APPROVE_CHECK);

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const parents = engine.repoSearchRequests.filter((request) => request.taskKind === 'orchestrator');
  assert.ok(parents.length >= 3, 'plan, approvals, and drift review');
  const first = parents[0]?.systemContext;
  assert.ok(first?.hasRepoFileListing, 'the orchestrator preset includes the listing');
  assert.doesNotMatch(first.content, /greeting\.ts/u, 'snapshotted before the writer ran');
  for (const request of parents) assert.equal(request.systemContext, first);
  const blocks = parents.slice(1).map((request) => request.prompt.slice(0, request.prompt.indexOf('\nPhase: ')));
  assert.ok(blocks.every((block) => block === blocks[0] && block.includes('Saved plan')));
});
