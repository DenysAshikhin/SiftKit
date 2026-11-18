import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorAttemptResult, OrchestratorCheckResult } from '@siftkit/contracts';

import { renderAttemptForParent, renderCheckOutput } from '../src/orchestrator/handoff.ts';
import { digestOutput, digestToolOutput } from '../src/output-digest/digest.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

const passing: OrchestratorCheckResult = { check: { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 },
  executed: true, exitCode: 0, timedOut: false, output: 'all good '.repeat(50), digest: null };
const failing: OrchestratorCheckResult = { check: { kind: 'command', command: 'npm run lint', cwd: '.', expectedExitCode: 0 },
  executed: true, exitCode: 1, timedOut: false, output: `${'noise '.repeat(400)}src/store.ts:4 unused import`,
  digest: 'Digest of the whole output:\neslint: FAILED (1 errors, 0 warnings)\n✖ unused import (no-unused-vars) — src/store.ts:4:1' };

function result(overrides: Partial<OrchestratorAttemptResult> = {}): OrchestratorAttemptResult {
  return {
    taskId: 'store', purpose: 'implementation', attempt: 1, childRunId: '00000000-0000-4000-8000-000000000001',
    workerStatus: 'completed', workerOutput: '{}', outcome: 'checks_failed', submissions: 3, passed: false,
    checks: [passing, failing], findings: ['Check `npm run lint` exited 1; expected 0.'],
    changedPaths: ['src/store.ts', 'tests/store.test.ts'], changeDigest: 'd',
    report: { status: 'incomplete', deviations: [
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
  assert.match(text, /- FAIL `npm run lint` exited 1\nDigest of the whole output:\neslint: FAILED \(1 errors, 0 warnings\)\n✖ unused import \(no-unused-vars\) — src\/store\.ts:4:1\n[^]*src\/store\.ts:4 unused import/u);
  assert.doesNotMatch(text, /all good/u, 'passing output is not shown');
  assert.doesNotMatch(text, /"status":/u);
  assert.ok(text.length < 2_500, `rendered ${text.length} characters`);
});

test('a completed attempt without deviations says so in one line', () => {
  const text = renderAttemptForParent(result({ report: { status: 'completed', deviations: [] } }), DIFFSTAT);
  assert.match(text, /Status: completed\nDeviations: none\./u);
});

test('an attempt names empty changes and lists only command checks', () => {
  const evidence: OrchestratorCheckResult = { check: { kind: 'evidence', instruction: 'Read the diff.', paths: ['src/store.ts'] },
    executed: false, exitCode: null, timedOut: false, output: '', digest: null };
  const text = renderAttemptForParent(result({ checks: [passing, evidence] }), []);
  assert.match(text, /Changes: none\.\n/u);
  assert.match(text, /Checks \(the gate's last run\):\n- pass `npm test`$/u);
  const onlyEvidence = renderAttemptForParent(result({ checks: [evidence] }), []);
  assert.doesNotMatch(onlyEvidence, /Checks|Read the diff/u);
});

test('without a usable report the tail of the final answer stands in for it', () => {
  const text = renderAttemptForParent(result({ report: null, outcome: 'report_invalid', workerOutput: `${'x'.repeat(5_000)}END` }), DIFFSTAT);
  assert.match(text, /No usable report\. End of the final answer:\nx+END\nChanges/u);
  assert.ok(text.length < 4_000);
});

test('a check renders as its whole digest, then its output tail; without a digest, as the tail alone', () => {
  const digest = failing.digest ?? '';
  assert.equal(renderCheckOutput(failing, 400), `${digest}\n${failing.output.slice(-400)}`);
  assert.equal(renderCheckOutput({ ...failing, digest: null }, 400), failing.output.slice(-400));
});

test('every real failing check renders every failure whole, however small its tail', () => {
  const corpus = path.join(process.cwd(), 'tests', 'fixtures', 'output-digest-runs', '67e089d0');
  const outputs = [...fs.readdirSync(corpus).filter((file) => file.endsWith('.txt')).map((file) => fs.readFileSync(path.join(corpus, file), 'utf8')),
    readDigestFixture('node-test/noisy-e2e-fail.txt')];
  const failingOutputs = outputs.filter((output) => digestOutput(output)?.failed === true);
  assert.ok(failingOutputs.length > 20, String(failingOutputs.length));
  for (const output of failingOutputs) {
    const rendered = renderCheckOutput({ ...failing, output: output.slice(-20_000), digest: digestOutput(output)?.text ?? null }, 1_500);
    for (const failure of digestToolOutput(output).flatMap((entry) => entry.failures)) {
      assert.ok(rendered.includes(failure.name), failure.name);
      for (const line of failure.message) assert.ok(rendered.includes(line), line);
    }
  }
});
