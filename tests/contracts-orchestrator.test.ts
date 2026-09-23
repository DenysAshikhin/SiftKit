import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  OrchestratorChildWorkSchema,
  OrchestratorDriftReviewSchema,
  OrchestratorPresetOptionsSchema,
  OrchestratorStartRequestSchema,
  SiftPresetCollectionSchema,
  SiftPresetSchema,
} from '@siftkit/contracts';
import { PresetCatalog } from '../src/preset-catalog.js';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.js';

const FINDING = {
  id: 'D1', title: 'Duplicated admission path', purpose: 'One admission path',
  directive: 'Keep logic DRY.', evidence: [{ path: 'src/a.ts', line: 3, snippet: 'acquire()' }],
  impact: 'The two paths diverge on cancellation.', fix: 'Route both through acquireWebUiModelRequest.',
  affectedPaths: ['src/a.ts'], verification: [{ kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 }],
};

test('the default orchestrator inherits the model and runs one child at a time', () => {
  const preset = PresetCatalog.createDefault().requireById('orchestrator');
  assert.equal(preset.presetKind, 'orchestrator');
  assert.equal(preset.modelPresetId, null);
  assert.deepEqual(preset.orchestrator, { maxSubagents: 1 });
  assert.equal(preset.deletable, false);
  assert.equal(preset.builtin, true);
  assert.deepEqual(preset.surfaces, ['cli', 'web']);
});

test('every other built-in preset carries null orchestrator options', () => {
  for (const preset of PresetCatalog.createDefault().list()) {
    if (preset.presetKind !== 'orchestrator') assert.equal(preset.orchestrator, null, preset.id);
  }
});

test('the subagent cap is a positive integer and attempts are a fixed policy, not an option', () => {
  assert.equal(ORCHESTRATOR_MAX_ATTEMPTS, 2);
  assert.equal(OrchestratorPresetOptionsSchema.safeParse({ maxSubagents: 0 }).success, false);
  assert.equal(OrchestratorPresetOptionsSchema.safeParse({ maxSubagents: 1.5 }).success, false);
  assert.equal(OrchestratorPresetOptionsSchema.safeParse({ maxSubagents: 2, maxAttempts: 3 }).success, false);
  assert.equal(OrchestratorPresetOptionsSchema.safeParse({ maxSubagents: 3 }).success, true);
});

test('orchestrator options are required for the orchestrator kind and forbidden for others', () => {
  const catalog = PresetCatalog.createDefault().list();
  const withoutOptions = catalog.map((preset) => (preset.id === 'orchestrator' ? { ...preset, orchestrator: null } : preset));
  assert.throws(() => SiftPresetCollectionSchema.parse(withoutOptions), /Orchestrator preset 'orchestrator' requires orchestrator options/u);
  const chatWithOptions = catalog.map((preset) => (preset.id === 'chat' ? { ...preset, orchestrator: { maxSubagents: 1 } } : preset));
  assert.throws(() => SiftPresetCollectionSchema.parse(chatWithOptions), /Preset 'chat' has kind 'chat' and must not carry orchestrator options/u);
  const chat = catalog.find((preset) => preset.id === 'chat');
  assert.ok(chat);
  const { orchestrator: _omitted, ...missingField } = chat;
  assert.equal(SiftPresetSchema.safeParse(missingField).success, false, 'the field is required, not optional');
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
