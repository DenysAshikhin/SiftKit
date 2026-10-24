import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { OrchestratorAttemptResultSchema, type OrchestratorRecordReviewArgs } from '@siftkit/contracts';
import { findReviewProblems } from '../src/orchestrator/review.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const TASK = makeOrchestratorTask({ acceptance: ['README names the install command.', 'README has a title.'] });
const MET = [
  { index: 0, met: true, evidence: [{ path: 'README.md', line: 2, snippet: 'npm install' }] },
  { index: 1, met: true, evidence: [{ path: 'README.md', line: 1, snippet: '# Title' }] },
];

function result(passed: boolean) {
  return OrchestratorAttemptResultSchema.parse({
    taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: '00000000-0000-4000-8000-000000000002',
    workerStatus: 'completed', workerOutput: '', report: null, outcome: passed ? 'passed' : 'checks_failed', submissions: 1,
    passed, checks: [], findings: [], changedPaths: [], changeDigest: null,
  });
}

function problems(review: Partial<OrchestratorRecordReviewArgs>, passed = true): string[] {
  const repoRoot = createManagedTempDir('siftkit-review-');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Title\nnpm install\n');
  return findReviewProblems({ repoRoot, task: TASK, result: result(passed),
    review: { taskId: TASK.id, verdict: 'pass', criteria: MET, findings: [], ...review } });
}

test('a pass with every criterion met by resolving evidence on a passing attempt records cleanly', () => {
  assert.deepEqual(problems({}), []);
});

test('every acceptance criterion is judged exactly once', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ criteria: [first] }), ['Judge every acceptance criterion; missing index 1.']);
  assert.deepEqual(problems({ criteria: [first, second, { ...first, index: 2 }] }), ["Task 'inspect' has no acceptance criterion 2."]);
  assert.deepEqual(problems({ criteria: [first, second, first] }), ['Judge each criterion once; repeated index 0.']);
});

test('a pass needs passing checks, every criterion met with evidence, and no findings', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({}, false), ['Attempt 1 did not pass its checks (checks_failed); it cannot pass review.']);
  assert.deepEqual(problems({ criteria: [first, { ...second, met: false }] }), ['A pass needs every criterion met.']);
  assert.deepEqual(problems({ criteria: [first, { ...second, evidence: [] }] }), ['A pass needs code evidence for every criterion.']);
  assert.deepEqual(problems({ findings: [{ path: 'README.md', line: 1, issue: 'Terse.' }] }), ['A pass cannot carry findings; record a fail.']);
});

test('a fail names an unmet criterion or a finding', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ verdict: 'fail' }), ['A fail needs an unmet criterion or a finding.']);
  assert.deepEqual(problems({ verdict: 'fail', criteria: [first, { ...second, met: false, evidence: [] }] }), []);
  assert.deepEqual(problems({ verdict: 'fail', findings: [{ path: 'README.md', line: 2, issue: 'Wrong flag.' }] }, false), []);
});

test('every evidence snippet and finding citation must hold in the current code', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ criteria: [first, { ...second, evidence: [{ path: 'README.md', line: 2, snippet: 'yarn add' }] }] }),
    ['Evidence: README.md:2 does not contain the cited snippet.']);
  assert.deepEqual(problems({ verdict: 'fail', findings: [{ path: 'docs/missing.md', line: 1, issue: 'Gone.' }] }),
    ['Finding: docs/missing.md is not a file in the repository.']);
});
