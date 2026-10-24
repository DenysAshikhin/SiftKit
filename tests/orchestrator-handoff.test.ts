import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorAttemptResult, OrchestratorCheckResult } from '@siftkit/contracts';

import { renderAttemptForParent } from '../src/orchestrator/handoff.ts';

const passing: OrchestratorCheckResult = { check: { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 },
  executed: true, exitCode: 0, timedOut: false, output: 'all good '.repeat(50) };
const failing: OrchestratorCheckResult = { check: { kind: 'command', command: 'npm run lint', cwd: '.', expectedExitCode: 0 },
  executed: true, exitCode: 1, timedOut: false, output: `${'noise '.repeat(400)}src/store.ts:4 unused import` };

function result(overrides: Partial<OrchestratorAttemptResult> = {}): OrchestratorAttemptResult {
  return {
    taskId: 'store', purpose: 'implementation', attempt: 1, childRunId: '00000000-0000-4000-8000-000000000001',
    workerStatus: 'completed', workerOutput: '{}', outcome: 'checks_failed', submissions: 3, passed: false,
    checks: [passing, failing], findings: ['Check `npm run lint` exited 1; expected 0.'],
    changedPaths: ['src/store.ts', 'tests/store.test.ts'], changeDigest: 'd',
    report: { kind: 'agent', status: 'incomplete', deviations: [
      { what: 'Kept the old export.', why: 'The CLI still imports it.' },
      { what: 'Left the CLI wiring.', why: 'It belongs to the cli task.' },
    ] },
    ...overrides,
  };
}

const DIFFSTAT = [
  { path: 'src/store.ts', change: 'modified' as const, added: 12, removed: 3 },
  { path: 'tests/store.test.ts', change: 'added' as const, added: 40, removed: 0 },
];

test('an attempt renders as the child status and deviations, the measured diffstat and the gate checks, never raw JSON or hunks', () => {
  const text = renderAttemptForParent(result(), DIFFSTAT);
  assert.match(text, /^## store \(implementation attempt 1\): checks_failed, worker completed, 3 submission\(s\)/u);
  assert.match(text, /Status: incomplete/u);
  assert.match(text, /Deviations:\n- Kept the old export\. Why: The CLI still imports it\.\n- Left the CLI wiring\. Why: It belongs to the cli task\./u);
  assert.match(text, /Changes \(measured since the attempt began\):\n- src\/store\.ts \+12 -3\n- tests\/store\.test\.ts \+40 -0 \(new\)/u);
  assert.match(text, /Checks \(the gate's last run\):\n- pass `npm test`/u);
  assert.match(text, /- FAIL `npm run lint` exited 1[^\n]*\n[^]*src\/store\.ts:4 unused import/u);
  assert.doesNotMatch(text, /all good/u, 'passing output is not shown');
  assert.doesNotMatch(text, /"kind":"agent"/u);
  assert.ok(text.length < 2_500, `rendered ${text.length} characters`);
});

test('a completed attempt without deviations says so in one line', () => {
  const text = renderAttemptForParent(result({ report: { kind: 'agent', status: 'completed', deviations: [] } }), DIFFSTAT);
  assert.match(text, /Status: completed\nDeviations: none\./u);
});

test('a search report renders its graded findings and unknowns', () => {
  const text = renderAttemptForParent(result({ outcome: 'passed', checks: [], findings: [], changedPaths: [], report: {
    kind: 'search', understood: 'Where saves happen.',
    findings: [{ claim: 'save() lives in store.ts', evidence: [{ path: 'src/store.ts', line: 9 }], confidence: 'high' }],
    unknowns: ['Whether the CLI saves.'],
  } }), []);
  assert.match(text, /Changes: none\./u);
  assert.match(text, /- \[high\] save\(\) lives in store\.ts \(src\/store\.ts:9\)/u);
  assert.match(text, /Unknowns:\n- Whether the CLI saves\./u);
});

test('without a usable report the tail of the final answer stands in for it', () => {
  const text = renderAttemptForParent(result({ report: null, outcome: 'report_invalid', workerOutput: `${'x'.repeat(5_000)}END` }), DIFFSTAT);
  assert.match(text, /No usable report\. End of the final answer:\nx+END\nChanges/u);
  assert.ok(text.length < 4_000);
});
