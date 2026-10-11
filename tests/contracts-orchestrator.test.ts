import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  OrchestratorChildWorkSchema,
  OrchestratorDecideRequestSchema,
  OrchestratorDriftReviewSchema,
  OrchestratorFailureSchema,
  OrchestratorPendingApprovalSchema,
  OrchestratorStartRequestSchema,
  OrchestratorTaskReviewSchema,
  SiftPresetCollectionSchema,
  orchestratorCheckFailure,
  SiftPresetSchema,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';
import { PresetCatalog } from '../src/preset-catalog.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const FINDING = {
  id: 'D1', title: 'Duplicated admission path', purpose: 'One admission path',
  directive: 'Keep logic DRY.', evidence: [{ path: 'src/a.ts', line: 3, snippet: 'acquire()' }],
  impact: 'The two paths diverge on cancellation.', fix: 'Route both through acquireWebUiModelRequest.',
  affectedPaths: ['src/a.ts'], verification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }],
};

test('the default orchestrator inherits the model', () => {
  const preset = PresetCatalog.createDefault().requireById('orchestrator');
  assert.equal(preset.presetKind, 'orchestrator');
  assert.equal(preset.modelPresetId, null);
  assert.equal(preset.deletable, false);
  assert.equal(preset.builtin, true);
  assert.deepEqual(preset.surfaces, ['cli', 'web']);
});

test('attempts are a fixed policy and concurrency comes from the worker model, so no preset carries orchestrator options', () => {
  assert.equal(ORCHESTRATOR_MAX_ATTEMPTS, 2);
  const catalog = PresetCatalog.createDefault().list();
  assert.doesNotThrow(() => SiftPresetCollectionSchema.parse(catalog));
  for (const preset of catalog) {
    assert.equal(SiftPresetSchema.safeParse({ ...preset, orchestrator: null }).success, false, preset.id);
  }
});

test('implementation work needs a plan reference; drift-fix work is only findings and fixes', () => {
  const task = makeOrchestratorTask();
  assert.equal(OrchestratorChildWorkSchema.safeParse({ kind: 'implementation', task }).success, false);
  assert.equal(OrchestratorChildWorkSchema.safeParse({ kind: 'implementation', planPath: 'plan.md', planHash: 'abc', task }).success, true);
  const driftFix = { kind: 'drift_fix', taskId: 'inspect', objective: 'Remove the duplicate path.', changeDigest: 'd1',
    findings: [FINDING], allowedPaths: ['src/a.ts'], verification: FINDING.verification };
  assert.equal(OrchestratorChildWorkSchema.safeParse(driftFix).success, true);
  assert.equal(OrchestratorChildWorkSchema.safeParse({ ...driftFix, planPath: 'plan.md' }).success, false);
  assert.equal(OrchestratorChildWorkSchema.safeParse({ ...driftFix, findings: [] }).success, false);
});

test('actionable reviews need complete findings and clean reviews carry none', () => {
  const base = { taskId: 'inspect', changeDigest: 'd1', scopePaths: ['src/a.ts'], resolutions: [] };
  assert.equal(OrchestratorDriftReviewSchema.safeParse({ ...base, status: 'actionable', findings: [] }).success, false);
  assert.equal(OrchestratorDriftReviewSchema.safeParse({ ...base, status: 'actionable', findings: [{ ...FINDING, evidence: [] }] }).success, false);
  assert.equal(OrchestratorDriftReviewSchema.safeParse({ ...base, status: 'actionable', findings: [FINDING] }).success, true);
  assert.equal(OrchestratorDriftReviewSchema.safeParse({ ...base, status: 'clean', findings: [FINDING] }).success, false);
  assert.equal(OrchestratorDriftReviewSchema.safeParse({ ...base, status: 'not_required', reason: 'no_code_changes' }).success, true);
});

test('a start request needs a task or a plan path', () => {
  const request = { submissionId: '6f9f2d7c-3b2e-4c0a-9a1f-2d3e4f5a6b7c', repoRoot: 'C:/repo', presetId: 'orchestrator',
    approval: 'interactive', task: null, planPath: null };
  assert.equal(OrchestratorStartRequestSchema.safeParse(request).success, false);
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, task: 'Do it.' }).success, true);
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, planPath: 'docs/plan.md' }).success, true);
});

const RUN_ID = '6f9f2d7c-3b2e-4c0a-9a1f-2d3e4f5a6b7c';
const APPROVAL_ID = '7a0e3d8c-4c3f-4d1b-8b2a-3e4f5a6b7c8d';

test('a pending approval is either a parked child tool call or one orchestrator check command', () => {
  const child = { kind: 'child', approvalId: APPROVAL_ID, childRunId: RUN_ID, taskId: 'inspect', toolName: 'write',
    command: 'write src/a.ts', reviewPayload: null };
  const check = { kind: 'check', approvalId: APPROVAL_ID, taskId: null, command: 'npm test', cwd: '.' };
  assert.equal(OrchestratorPendingApprovalSchema.safeParse(child).success, true);
  assert.equal(OrchestratorPendingApprovalSchema.safeParse(check).success, true);
  assert.equal(OrchestratorPendingApprovalSchema.safeParse({ ...check, toolName: 'run' }).success, false);
  assert.equal(OrchestratorPendingApprovalSchema.safeParse({ ...child, taskId: null }).success, false);
});

test('a decide request is a repo-agent decision addressed to one run approval', () => {
  const ids = { runId: RUN_ID, approvalId: APPROVAL_ID };
  assert.equal(OrchestratorDecideRequestSchema.safeParse({ ...ids, decision: 'approve' }).success, true);
  assert.equal(OrchestratorDecideRequestSchema.safeParse({ ...ids, decision: 'deny', reason: 'No.' }).success, true);
  assert.equal(OrchestratorDecideRequestSchema.safeParse({ ...ids, decision: 'deny' }).success, false);
  assert.equal(OrchestratorDecideRequestSchema.safeParse({ ...ids, decision: 'abort', reason: 'x' }).success, false);
});

test('a passing task review anchors each piece of evidence to a path, line, and snippet', () => {
  assert.equal(OrchestratorTaskReviewSchema.safeParse({ status: 'pass', evidence: ['README.md:2 install'] }).success, false);
  assert.equal(OrchestratorTaskReviewSchema.safeParse({ status: 'pass',
    evidence: [{ path: 'README.md', line: 2, snippet: 'npm install' }] }).success, true);
});

test('a check failure explains a failing command and never flags an evidence check', () => {
  const command = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
  const evidence: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm it.', paths: ['README.md'] };
  const result = { executed: true, exitCode: 0, timedOut: false, output: '' };
  assert.equal(orchestratorCheckFailure({ ...result, check: command }), null);
  assert.equal(orchestratorCheckFailure({ ...result, check: command, exitCode: 1 }), 'Check `npm test` exited 1; expected 0.');
  assert.equal(orchestratorCheckFailure({ ...result, check: command, executed: false, exitCode: null }), 'Check `npm test` never ran.');
  assert.equal(orchestratorCheckFailure({ ...result, check: command, timedOut: true, exitCode: 124 }), 'Check `npm test` timed out.');
  assert.equal(orchestratorCheckFailure({ check: evidence, executed: false, exitCode: null, timedOut: false, output: '' }), null);
});

test('a stored failure carries one of the known failure codes', () => {
  const failure = { message: 'Stopped.', taskId: null, purpose: null, findingIds: [] };
  assert.equal(OrchestratorFailureSchema.safeParse({ ...failure, code: 'infrastructure_failed' }).success, true);
  assert.equal(OrchestratorFailureSchema.safeParse({ ...failure, code: 'infrastructure_falied' }).success, false);
});
