import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorTaskReviewSchema } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import { ORCHESTRATOR_PHASE_ANSWER_NAMES } from '../src/orchestrator/phase-runner.ts';
import {
  EVIDENCE_REVIEW_GUIDANCE,
  buildAttemptReviewPrompt,
  buildCheckApprovalPrompt,
  buildChildApprovalPrompt,
  buildDriftReviewPrompt,
  buildFinalVerificationPrompt,
  buildParentPrompt,
  buildPlanPreparationPrompt,
  buildRunContext,
  type RunContext,
} from '../src/orchestrator/prompts.ts';
import { buildPlannerJsonSchema } from '../src/planner-protocol/json-schema.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const config = getDefaultConfigObject();
const model = config.Server.ModelPresets.Presets[0];
const worker = config.Presets.find((preset) => preset.id === 'repo-agent');
const task = makeOrchestratorTask({ id: 'greeting', writePaths: ['src/greeting.ts'] });
const plan = makeOrchestratorPlan([task]);
const schema = buildPlannerJsonSchema(OrchestratorTaskReviewSchema);
const check = { kind: 'command', command: 'exit 0', cwd: '.', expectedExitCode: 0 } as const;

function run(withPlan: boolean): RunContext {
  assert.ok(model && worker);
  return { task: 'Add a greeting module.', workers: [{ preset: worker, model }], preexistingDirtyPaths: ['README.md'],
    plan: withPlan ? { path: '.siftkit/orchestrator/r/plan.md', hash: 'a'.repeat(64), plan } : null };
}

const attemptReview = buildAttemptReviewPrompt({ task, result: { workerOutput: 'done', checks: [], changedPaths: [] },
  preexistingDirtyPaths: [], rejectedProblems: [] });
const driftReview = buildDriftReviewPrompt({ task, changeDigest: 'b'.repeat(64), diff: '', changedPaths: ['src/greeting.ts'],
  openFindings: [], checks: [], rejectedProblems: [] });
const finalVerification = buildFinalVerificationPrompt({ checks: [], rejectedProblems: [] });
const phasePrompts = [
  buildPlanPreparationPrompt({ planPath: null, planMarkdown: null, rejectedProblems: [] }),
  attemptReview,
  driftReview,
  buildChildApprovalPrompt({ task, purpose: 'implementation', attempt: 1,
    approval: { approvalId: '00000000-0000-4000-8000-000000000000', toolName: 'write', command: 'write src/greeting.ts',
      reviewPayload: null } }),
  buildCheckApprovalPrompt({ task, check }),
  finalVerification,
];

test('a parent prompt is the run block, then the phase, then the answer JSON schema', () => {
  const planned = run(true);
  const prompt = buildParentPrompt(planned, finalVerification, schema);
  assert.ok(prompt.startsWith(`${buildRunContext(planned)}\n${finalVerification}\n`), prompt.slice(0, 200));
  assert.ok(prompt.endsWith(`Answer with exactly one JSON object that matches this JSON schema:\n${JSON.stringify(schema)}`));
  const block = buildRunContext(planned);
  assert.match(block, /Saved plan \.siftkit\/orchestrator\/r\/plan\.md/u);
  assert.match(block, /Command checks run in PowerShell/u);
  assert.match(block, /Uncommitted changes that predate this run \(not made by it; never count them against it\): README\.md/u);
});

test('every phase builder returns only its phase text', () => {
  for (const prompt of phasePrompts) {
    assert.match(prompt, /^Phase: /u);
    for (const removed of ['Orchestrator run context', 'Answer with exactly one JSON object', '"status": "pass"',
      '"decision": "approve"', 'Plan JSON shape']) {
      assert.ok(!prompt.includes(removed), `${removed} in ${prompt.slice(0, 200)}`);
    }
  }
});

test('both evidence reviews state the shared answer guidance once', () => {
  for (const prompt of [attemptReview, finalVerification]) assert.equal(prompt.split(EVIDENCE_REVIEW_GUIDANCE).length - 1, 1, prompt);
});

test('attempt review lists only the task baseline beyond the run context', () => {
  const prompt = buildAttemptReviewPrompt({ task, result: { workerOutput: 'done', checks: [], changedPaths: [] },
    preexistingDirtyPaths: ['b.ts'], rejectedProblems: [] });
  assert.ok(prompt.includes(
    'predate this task, beyond those listed in the run context (not made by it; never count them against it): b.ts.'), prompt);
});

test('drift review forbids answering not_required', () => {
  assert.match(driftReview, /Never answer "not_required": the host uses it only for steps without code changes\./u);
});

test('final verification feeds back the problems that rejected its previous review', () => {
  const problem = 'Review evidence: a.ts:3 does not contain the cited snippet.';
  const retried = buildFinalVerificationPrompt({ checks: [], rejectedProblems: [problem] });
  assert.ok(retried.includes(`Your previous review was rejected:\n- ${problem}`), retried);
  assert.ok(!finalVerification.includes('Your previous review was rejected:'));
  assert.ok(!finalVerification.includes(problem));
});

test('check approval and final verification state the goal once, via the saved plan', () => {
  const planned = run(true);
  const prompts = [
    buildParentPrompt(planned, finalVerification, schema),
    buildParentPrompt(planned, buildCheckApprovalPrompt({ task, check }), schema),
  ];
  for (const prompt of prompts) assert.equal(prompt.split(plan.goal).length - 1, 1, prompt);
});

test('every phase label maps to a wire-safe json_schema name', () => {
  assert.deepEqual(Object.keys(ORCHESTRATOR_PHASE_ANSWER_NAMES).sort(),
    ['approval decision', 'drift review', 'final verification', 'plan preparation', 'task review']);
  for (const name of Object.values(ORCHESTRATOR_PHASE_ANSWER_NAMES)) assert.match(name, /^[A-Za-z0-9_-]+$/u);
});

test('plan preparation opens with the run block before any plan exists', () => {
  const unplanned = run(false);
  const prompt = buildParentPrompt(unplanned, buildPlanPreparationPrompt({ planPath: null, planMarkdown: null, rejectedProblems: [] }),
    schema);
  assert.ok(prompt.startsWith(`${buildRunContext(unplanned)}\nPhase: prepare the executable plan`));
  assert.doesNotMatch(buildRunContext(unplanned), /Saved plan/u);
});
