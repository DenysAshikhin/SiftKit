import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorDriftFinding, OrchestratorDriftReview } from '@siftkit/contracts';
import { buildDriftCorrectionWork, validateDriftReview } from '../src/orchestrator/drift-review.js';
import { buildDriftCorrectionPrompt } from '../src/orchestrator/prompts.js';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;

function makeRepo(): string {
  const root = createManagedTempDir('siftkit-drift-review-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function load() {\n  return legacyLoad() ?? modernLoad();\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  return root;
}

function finding(overrides: Partial<OrchestratorDriftFinding> = {}): OrchestratorDriftFinding {
  return {
    id: 'D1', title: 'Parallel legacy path', purpose: 'One load path', directive: 'No compatibility shims.',
    evidence: [{ path: 'src/a.ts', line: 2, snippet: 'return legacyLoad() ?? modernLoad();' }],
    impact: 'Two paths diverge.', fix: 'Delete legacyLoad and migrate callers.', affectedPaths: ['src/a.ts'],
    verification: [{ kind: 'command', command: 'npm run typecheck', cwd: '.', expectedExitCode: 0 }], ...overrides,
  };
}

function review(overrides: Partial<Extract<OrchestratorDriftReview, { status: 'actionable' }>> = {}): OrchestratorDriftReview {
  return { taskId: 'write', changeDigest: 'digest-1', scopePaths: ['src/a.ts'], resolutions: [],
    status: 'actionable', findings: [finding()], ...overrides };
}

function validate(candidate: OrchestratorDriftReview, root: string, openFindings: OrchestratorDriftFinding[] = []): string[] {
  return validateDriftReview({ review: candidate, repoRoot: root, taskId: 'write', changeDigest: 'digest-1',
    changedPaths: ['src/a.ts'], openFindings });
}

test('a finding anchored to the current changed code with its exact snippet is accepted', () => {
  assert.deepEqual(validate(review(), makeRepo()), []);
});

test('stale, unattributable, or fabricated evidence makes the report unusable', () => {
  const root = makeRepo();
  assert.match(validate(review({ changeDigest: 'digest-0' }), root).join(' '), /different change digest/u);
  assert.match(validate(review({ findings: [finding({ evidence: [{ path: 'src/a.ts', line: 2, snippet: 'return cachedLoad();' }] })] }), root).join(' '),
    /does not contain the cited snippet/u);
  assert.match(validate(review({ findings: [finding({ evidence: [{ path: 'src/a.ts', line: 90, snippet: 'x' }] })] }), root).join(' '),
    /past the end/u);
  assert.match(validate(review({ findings: [finding({ evidence: [{ path: 'src/b.ts', line: 1, snippet: 'export const b = 1;' }] })] }), root).join(' '),
    /cites no code this step changed/u);
  assert.match(validate(review({ findings: [finding(), finding()] }), root).join(' '), /reported twice/u);
});

test('a clean report must account for every prior finding, and only the host may skip the review', () => {
  const root = makeRepo();
  const clean: OrchestratorDriftReview = { taskId: 'write', changeDigest: 'digest-1', scopePaths: ['src/a.ts'],
    resolutions: [], status: 'clean', findings: [] };
  assert.match(validate(clean, root, [finding()]).join(' '), /Prior finding D1 is neither resolved/u);
  assert.deepEqual(validate({ ...clean, resolutions: [{ findingId: 'D1', evidence: 'legacyLoad removed from src/a.ts' }] }, root, [finding()]), []);
  assert.match(validate({ taskId: 'write', changeDigest: 'digest-1', scopePaths: [], resolutions: [], status: 'not_required',
    reason: 'no_code_changes' }, root).join(' '), /Only the host/u);
});

test('the correction payload carries every finding as bullets, bounded paths, and deduplicated checks', () => {
  const task = makeOrchestratorTask({ id: 'write', title: 'Add loader', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'],
    verification: [CHECK], acceptance: ['Loader works.'] });
  const findings = [finding(), finding({ id: 'D2', title: 'Duplicate', affectedPaths: ['src/c.ts'], verification: [CHECK] })];
  const work = buildDriftCorrectionWork({ task, changeDigest: 'digest-1', findings });
  assert.deepEqual(work.allowedPaths, ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(work.verification.map((check) => check.kind === 'command' ? check.command : ''), ['npm test', 'npm run typecheck']);
  const prompt = buildDriftCorrectionPrompt(work, null);
  assert.match(prompt, /^Resolve only the confirmed drift in step write\. Objective: Add loader\./u);
  assert.match(prompt, /- D1: Parallel legacy path\n {2}Evidence: src\/a\.ts:2 return legacyLoad\(\) \?\? modernLoad\(\);/u);
  assert.match(prompt, /- D2: Duplicate/u);
  assert.match(prompt, /Fix: Delete legacyLoad and migrate callers\./u);
  assert.match(prompt, /Allowed files: src\/a\.ts, src\/c\.ts/u);
  assert.match(prompt, /Do not create a new plan or commit\./u);
  assert.doesNotMatch(prompt, /<[a-z-]+>/u, 'no uninterpolated placeholders');
});
