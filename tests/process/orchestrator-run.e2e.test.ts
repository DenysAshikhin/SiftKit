import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import {
  OrchestratorEventSchema,
  OrchestratorRunStateSchema,
  type ApprovalMode,
  type OrchestratorDriftFinding,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';
import { runCli } from '../../src/cli/dispatch.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { z } from '../../src/lib/zod.js';
import type { RepoSearchExecutionRequest } from '../../src/repo-search/types.js';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from '../helpers/dashboard-model-queue-harness.js';
import { requestJson } from '../helpers/dashboard-http.js';
import { makeOrchestratorPlan, makeOrchestratorTask } from '../helpers/orchestrator-plan.js';
import { ESCALATING_VERDICTS, ScriptedEngineService, finalAnswer } from '../helpers/scripted-engine-service.js';
import { requestSse } from '../helpers/sse-http.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

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

function writeFile(content: string) {
  return { toolCalls: [{ name: 'write', arguments: { path: TARGET, content } }] };
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
  return { state: OrchestratorRunStateSchema.parse(response.result), events: response.progress.map((event) => OrchestratorEventSchema.parse(event)) };
}

async function readRun(context: Harness, runId: string): Promise<OrchestratorRunState> {
  const response = await requestJson(`${context.baseUrl}/orchestrator/status?runId=${runId}`);
  return OrchestratorRunStateSchema.parse(response.body);
}

async function waitForApproval(context: Harness, runId: string): Promise<OrchestratorRunState> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readRun(context, runId);
    if (state.phase === 'approval_required' && state.approval !== null) return state;
    assert.ok(!['completed', 'failed', 'aborted', 'interrupted'].includes(state.phase), JSON.stringify(state.failure));
    await delay(25);
  }
  throw new Error('Timed out waiting for an orchestrator approval.');
}

test('a child approval unloads the child model for the parent decision and reloads it to continue the same attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-bab-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...ESCALATING_VERDICTS, ...finalAnswer('Created src/greeting.ts.')]);
  engine.parent.push(finalAnswer('{"decision":"approve","reason":"Creates the planned file inside its scope."}'));
  engine.parent.push(driftReview('clean'));

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
});

test('a task that fails verification twice stops after two implementation children and never starts its dependent', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-retry-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan(true)));
  for (const attempt of [1, 2]) {
    engine.children.push([{ toolCalls: [{ name: 'write', arguments: { path: 'src/wrong.ts', content: `// ${attempt}\n` } }] },
      ...finalAnswer('Done.')]);
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
  assert.equal(childApproval.approval?.target.kind, 'child');
  const wrong = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
    body: JSON.stringify({ runId: started.runId, approvalId: randomUUID(), decision: 'approve' }) });
  assert.equal(wrong.statusCode, 409);
  const kinds: string[] = [];
  for (let approval: OrchestratorRunState | null = childApproval; approval !== null;) {
    kinds.push(approval.approval?.target.kind ?? 'none');
    const decided = await requestJson(`${context.baseUrl}/orchestrator/decide`, { method: 'POST',
      body: JSON.stringify({ runId: started.runId, approvalId: approval.approval?.approval.approvalId, decision: 'approve' }) });
    assert.equal(decided.statusCode, 200, JSON.stringify(decided.body));
    approval = kinds.length < 3 ? await waitForApproval(context, started.runId) : null;
  }

  const { state } = await following;
  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(kinds, ['child', 'phase', 'phase'], 'the child write, the task checks, then the final checks');
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
  const result = z.object({ runId: z.string().uuid(), status: z.string() }).loose().parse(parseJsonValueText(stdout.text));
  assert.equal(result.status, 'completed');
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
  const { state } = await followRun(context, OrchestratorRunStateSchema.parse(response.body).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.equal(state.planPath, 'docs/plan.md');
  assert.equal(fs.existsSync(path.join(context.repo, '.siftkit', 'orchestrator', state.runId, 'plan.md')), false, 'no second plan file');
  assert.match(engine.prompts('parent')[1] ?? '', /Your previous answer was rejected/u);
  assert.match(engine.prompts('children')[0] ?? '', /from plan docs\/plan\.md/u);
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
