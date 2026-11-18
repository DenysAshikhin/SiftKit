import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { OrchestratorAttemptResultSchema, type OrchestratorCheckResult, type OrchestratorRecordReviewArgs } from '@siftkit/contracts';
import { findReviewProblems } from '../src/orchestrator/review.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const TASK = makeOrchestratorTask({ acceptance: ['README names the install command.', 'README has a title.'] });
const MET = [
  { index: 0, met: true, evidence: [{ path: 'README.md', line: 2, snippet: 'npm install' }] },
  { index: 1, met: true, evidence: [{ path: 'README.md', line: 1, snippet: '# Title' }] },
];

function commandCheck(command: string, exitCode: number): OrchestratorCheckResult {
  return { check: { kind: 'command', command, cwd: '.', expectedExitCode: 0 }, executed: true, exitCode, timedOut: false, output: '', digest: null };
}

function result(passed: boolean, checks: OrchestratorCheckResult[] = []) {
  return OrchestratorAttemptResultSchema.parse({
    taskId: TASK.id, purpose: 'implementation', attempt: 1, childRunId: '00000000-0000-4000-8000-000000000002',
    workerStatus: 'completed', workerOutput: '', report: null, outcome: passed ? 'passed' : 'checks_failed', submissions: 1,
    passed, checks, findings: [], changedPaths: [], changeDigest: null,
  });
}

function problems(review: Partial<OrchestratorRecordReviewArgs>, passed = true,
  context: { checks?: OrchestratorCheckResult[]; passedRunChecks?: string[] } = {}): string[] {
  const repoRoot = createManagedTempDir('siftkit-review-');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Title\nnpm install\n');
  return findReviewProblems({ repoRoot, task: TASK, result: result(passed, context.checks), passedRunChecks: context.passedRunChecks ?? [],
    review: { taskId: TASK.id, verdict: 'pass', criteria: MET, findings: [], ...review } });
}

test('a pass with every criterion met by resolving evidence on a passing attempt records cleanly', () => {
  assert.deepEqual(problems({}), []);
});

test('every acceptance criterion is judged exactly once, and an unknown index names the criteria there are', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ criteria: [first] }), ['Judge every acceptance criterion; missing index 1.']);
  assert.deepEqual(problems({ criteria: [first, second, { ...first, index: 2 }] }),
    ["Task 'inspect' has acceptance criteria 0-1 only; there is no criterion 2."]);
  assert.deepEqual(problems({ criteria: [first, second, first] }), ['Judge each criterion once; repeated index 0.']);
});

test('a pass needs passing checks, every criterion met with evidence, and no findings', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({}, false), ['Attempt 1 did not pass its checks (checks_failed); it cannot pass review.']);
  assert.deepEqual(problems({ criteria: [first, { ...second, met: false }] }), ['A pass needs every criterion met.']);
  assert.deepEqual(problems({ criteria: [first, { ...second, evidence: [] }] }),
    ['A pass needs evidence for every criterion: code at a line, or a command that passed.']);
  assert.deepEqual(problems({ findings: [{ path: 'README.md', line: 1, issue: 'Terse.' }] }),
    ['A pass cannot carry findings: record a fail if they must be fixed, or leave them out.']);
});

test('a fail names an unmet criterion or a finding', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ verdict: 'fail' }), ['A fail needs an unmet criterion or a finding.']);
  assert.deepEqual(problems({ verdict: 'fail', criteria: [first, { ...second, met: false, evidence: [] }] }), []);
  assert.deepEqual(problems({ verdict: 'fail', findings: [{ path: 'README.md', line: 2, issue: 'Wrong flag.' }] }, false), []);
});

test('a snippet that does not hold shows the cited line, and a finding citation must hold', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  assert.deepEqual(problems({ criteria: [first, { ...second, evidence: [{ path: 'README.md', line: 2, snippet: 'npm install // the command' }] }] }),
    ['Evidence: README.md:2 does not contain the cited snippet; line 2 is `npm install`. Cite one line exactly as read shows it.']);
  assert.deepEqual(problems({ verdict: 'fail', findings: [{ path: 'docs/missing.md', line: 1, issue: 'Gone.' }] }),
    ['Finding: docs/missing.md is not a file in the repository.']);
});

test('command evidence holds only for a command that passed: an attempt check or a run_check since the report', () => {
  const [first, second] = MET;
  assert.ok(first && second);
  const lint = { ...second, evidence: [{ command: 'npm run lint' }] };
  assert.deepEqual(problems({ criteria: [first, lint] }, true, { checks: [commandCheck('npm run lint', 0)] }), []);
  assert.deepEqual(problems({ criteria: [first, lint] }, true, { passedRunChecks: ['npm  run   lint'] }), []);
  const unproven = ['Evidence: `npm run lint` has not passed since this attempt was reported; run it with run_check, or cite code.'];
  assert.deepEqual(problems({ criteria: [first, lint] }, true, { checks: [commandCheck('npm run lint', 1)] }), unproven);
  assert.deepEqual(problems({ criteria: [first, lint] }), unproven);
});
