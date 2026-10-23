import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  OPERATION_STREAM_EVENTS,
  ORCHESTRATOR_ACTIVITY_FRAME,
  ORCHESTRATOR_RECENT_TOOL_LIMIT,
  OrchestratorActivitySchema,
  OrchestratorChildActivitySchema,
  OrchestratorModelSlotsSchema,
  OrchestratorPhaseSchema,
  OrchestratorTaskStatusSchema,
  OrchestratorTaskWaitSchema,
  isOrchestratorOpenTaskStatus,
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

test('a start request needs a task or a plan path and states which session it came from', () => {
  const request = { submissionId: '6f9f2d7c-3b2e-4c0a-9a1f-2d3e4f5a6b7c', sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator',
    approval: 'interactive', task: null, planPath: null };
  assert.equal(OrchestratorStartRequestSchema.safeParse(request).success, false);
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, task: 'Do it.' }).success, true);
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, planPath: 'docs/plan.md' }).success, true);
  assert.equal(OrchestratorStartRequestSchema.parse({ ...request, task: 'Do it.', sessionId: RUN_ID }).sessionId, RUN_ID);
  // A start that names no session at all is not a start: 'no session of mine' has to be said out loud.
  assert.equal(OrchestratorStartRequestSchema.safeParse({ ...request, task: 'Do it.', sessionId: undefined }).success, false);
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

const LIVE_CHILD = {
  childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'greeting',
  waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1200, tools: [],
};
const LIVE_TOOL = { toolCallId: 't1', turn: 3, activityKind: 'edit', command: 'write src/greeting.ts', status: 'running' };
const SCHEDULE = {
  claims: [{ taskId: 'greeting', modelId: 'exl3-main', mutating: true, contextTokens: 32768 }],
  models: [{ modelId: 'exl3-main', slots: 2, used: 1 }], writerUsed: true,
  waits: [{ taskId: 'report', wait: { kind: 'dependencies', taskIds: ['greeting'] } }],
};

test('a live activity snapshot carries the scheduler pass and children with a bounded tool history', () => {
  const activity = OrchestratorActivitySchema.parse({
    runId: LIVE_CHILD.childRunId, schedule: SCHEDULE, children: [{ ...LIVE_CHILD, tools: [LIVE_TOOL] }],
  });
  assert.equal(activity.children[0]?.tools[0]?.status, 'running');
  assert.equal(OrchestratorActivitySchema.safeParse({ runId: LIVE_CHILD.childRunId, schedule: null, children: [] }).success, true);
  const tooMany = Array.from({ length: ORCHESTRATOR_RECENT_TOOL_LIMIT + 1 }, (_, index) => ({ ...LIVE_TOOL, toolCallId: `t${index}` }));
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, tools: tooMany }).success, false);
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, extra: true }).success, false);
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, maxTurns: null, turn: 0 }).success, true);
  assert.equal(OrchestratorModelSlotsSchema.safeParse({ modelId: 'm', slots: 0, used: 0 }).success, false);
  assert.equal(OrchestratorModelSlotsSchema.safeParse({ modelId: 'm', slots: 1, used: -1 }).success, false);
});

test('a wait names its unmet dependencies, the writer slot, or the full model', () => {
  assert.equal(OrchestratorTaskWaitSchema.safeParse({ kind: 'dependencies', taskIds: [] }).success, false);
  assert.equal(OrchestratorTaskWaitSchema.safeParse({ kind: 'writer_slot' }).success, true);
  assert.equal(OrchestratorTaskWaitSchema.safeParse({ kind: 'model_slot', modelId: 'exl3-main' }).success, true);
});

test('open task statuses are exactly the statuses of live work', () => {
  const open = OrchestratorTaskStatusSchema.options.filter((status) => isOrchestratorOpenTaskStatus(status));
  assert.deepEqual(open, ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending']);
});

test('drift review and correction are task statuses, never run phases', () => {
  for (const phase of ['reviewing_drift', 'correcting_drift']) assert.equal(OrchestratorPhaseSchema.safeParse(phase).success, false, phase);
});

test('the orchestrator stream names every frame from the shared contract', () => {
  assert.deepEqual([OPERATION_STREAM_EVENTS.progress, ORCHESTRATOR_ACTIVITY_FRAME, OPERATION_STREAM_EVENTS.result], ['progress', 'activity', 'result']);
});
