import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorCheckResult, OrchestratorVerificationCheck } from '@siftkit/contracts';
import { evaluateAttempt } from '../src/orchestrator/verification.js';
import { renderOrchestratorPlan } from '../src/orchestrator/plan.js';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const COMMAND = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const EVIDENCE: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm the install command.', paths: ['README.md'] };

function ran(exitCode: number): OrchestratorCheckResult {
  return { check: COMMAND, executed: true, exitCode, timedOut: false, output: 'out' };
}

function repo(): string {
  const root = createManagedTempDir('siftkit-verification-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Title\nnpm install\n');
  return root;
}

function evaluate(overrides: Partial<Parameters<typeof evaluateAttempt>[0]>) {
  return evaluateAttempt({ repoRoot: repo(), workerStatus: 'completed', checks: [ran(0)], scopeViolations: [], review: null, ...overrides });
}

test('a completed worker with independently passing checks and verified evidence passes', () => {
  assert.deepEqual(evaluate({}), { passed: true, findings: [] });
  const withEvidence = evaluate({ checks: [ran(0), { check: EVIDENCE, executed: false, exitCode: null, timedOut: false, output: '' }],
    review: { status: 'pass', evidence: [{ path: 'README.md', line: 2, snippet: 'npm install' }] } });
  assert.deepEqual(withEvidence, { passed: true, findings: [] });
});

test('a worker claim cannot pass a failing, missing, or timed-out check', () => {
  assert.match(evaluate({ checks: [ran(1)] }).findings.join(' '), /exited 1; expected 0/u);
  assert.match(evaluate({ checks: [{ check: COMMAND, executed: false, exitCode: null, timedOut: false, output: '' }] }).findings.join(' '), /never ran/u);
  assert.match(evaluate({ checks: [{ ...ran(124), timedOut: true }] }).findings.join(' '), /timed out/u);
  assert.match(evaluate({ workerStatus: 'failed' }).findings.join(' '), /worker ended failed/u);
  assert.match(evaluate({ scopeViolations: ['docs/x.md'] }).findings.join(' '), /outside the task's write scope/u);
});

test('evidence checks need a passing review whose anchors resolve to the cited lines', () => {
  const evidenceChecks = [{ check: EVIDENCE, executed: false, exitCode: null, timedOut: false, output: '' }];
  const reviewed = (path: string, line: number, snippet: string) =>
    evaluate({ checks: evidenceChecks, review: { status: 'pass', evidence: [{ path, line, snippet }] } }).findings.join(' ');
  assert.match(evaluate({ checks: evidenceChecks }).findings.join(' '), /were not reviewed/u);
  assert.match(reviewed('README.md', 40, 'npm install'), /README\.md:40 is past the end of the file/u);
  assert.match(reviewed('docs/missing.md', 1, 'x'), /docs\/missing\.md does not exist in the repository/u);
  assert.match(reviewed('README.md', 2, 'yarn add'), /README\.md:2 does not contain the cited snippet/u);
  assert.match(reviewed('../outside.md', 1, 'x'), /does not exist in the repository/u);
  assert.match(evaluate({ checks: evidenceChecks, review: { status: 'fail', findings: [{ path: 'README.md', line: 2, issue: 'Wrong flag.' }] } })
    .findings.join(' '), /README\.md:2 Wrong flag\./u);
});

test('a rendered plan states every task scope, step, check, and acceptance criterion', () => {
  const markdown = renderOrchestratorPlan(makeOrchestratorPlan([
    makeOrchestratorTask(),
    makeOrchestratorTask({ id: 'edit', title: 'Edit loader', workerPresetId: 'repo-agent', dependsOn: ['inspect'],
      writePaths: ['src/a.ts'], verification: [COMMAND] }),
  ]));
  for (const expected of ['# Exercise the orchestrator.', '## Task inspect: Inspect README', '- Worker: `repo-search`',
    '- Writes: none (read-only)', '## Task edit: Edit loader', '- Depends on: `inspect`', '- Writes: `src/a.ts`',
    '1. Read README.md and report its installation commands.', '   Expected: Commands with file and line evidence.',
    '- Run `npm test` in `.`; expected exit 0.', '- Every reported command is supported by the current README.',
    '## Final verification']) {
    assert.ok(markdown.includes(expected), expected);
  }
});
