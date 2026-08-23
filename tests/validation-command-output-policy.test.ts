import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
  ValidationCommandOutputPolicy,
} from '../src/repo-search/engine/validation-command-output-policy.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/runtime-profile.js';

const policy = new ValidationCommandOutputPolicy(REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT);

test('classifies supported validation command families', () => {
  const commands = [
    'npm test',
    'npm run test:coverage',
    'pnpm build',
    'yarn lint:fix',
    'bun run typecheck',
    'node --test tests/a.test.ts',
    'npx vitest run',
    'pnpm exec eslint .',
    'tsc --noEmit',
    'python -m pytest -q',
    'ruff check .',
    'mypy src',
    'dotnet test',
    'cargo clippy',
    'go vet ./...',
    '.\\gradlew.bat build',
    'mvn verify',
    'cmake --build build',
    'ctest --test-dir build',
    '$env:NODE_ENV="test"; npm run test:unit',
    '; npm test',
  ];

  for (const command of commands) {
    assert.equal(policy.isValidationCommand(command), true, command);
  }
});

test('does not classify discovery, display, or unrelated commands', () => {
  const commands = [
    'rg -n "npm test" src',
    'Get-Content tests/a.ts',
    'Write-Output "dotnet test"',
    'npm run deploy',
    'node scripts/build-report.js',
    'git diff -- tests',
    'Get-ChildItem build',
  ];

  for (const command of commands) {
    assert.equal(policy.isValidationCommand(command), false, command);
  }
});

test('leaves zero through 50 validation output lines unchanged', () => {
  for (const lineCount of [0, 49, 50]) {
    const output = Array.from({ length: lineCount }, (_, index) => `line-${index + 1}`).join('\n');
    assert.equal(policy.apply({ command: 'npm test', output, outputMode: 'auto' }), output);
  }
});

test('retains exactly the final 50 lines and reports omissions', () => {
  const output = Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join('\n');
  const trimmed = policy.apply({ command: 'npm test', output, outputMode: 'auto' });
  const lines = trimmed.split('\n');

  assert.equal(lines.length, 51);
  assert.equal(lines[0], '1 line omitted from validation command output.');
  assert.equal(lines[1], 'line-2');
  assert.equal(lines[50], 'line-51');
});

test('pluralizes the omission notice', () => {
  const output = Array.from({ length: 52 }, (_, index) => `line-${index + 1}`).join('\n');
  const trimmed = policy.apply({ command: 'npm test', output, outputMode: 'auto' });
  assert.match(trimmed, /^2 lines omitted from validation command output\./u);
});

test('handles CRLF and CR while preserving the same final logical lines', () => {
  for (const separator of ['\r\n', '\r']) {
    const output = `${Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join(separator)}${separator}`;
    const trimmed = policy.apply({ command: 'dotnet test', output, outputMode: 'auto' });
    assert.match(trimmed, /^1 line omitted from validation command output\.\nline-2/u);
    assert.match(trimmed, /line-51$/u);
  }
});

test('full mode and non-validation commands bypass the fixed line cap', () => {
  const output = Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join('\n');
  assert.equal(policy.apply({ command: 'npm test', output, outputMode: 'full' }), output);
  assert.equal(policy.apply({ command: 'rg test src', output, outputMode: 'auto' }), output);
});

function buildSpecReporterOutput(passing: number, failures: number): string {
  const lines: string[] = [];
  for (let index = 0; index < passing; index += 1) {
    lines.push(`✔ ok${index} (0.1ms)`);
  }
  for (let index = 0; index < failures; index += 1) {
    lines.push(`✖ boom${index} (0.1ms)`);
  }
  lines.push(
    `ℹ tests ${passing + failures}`,
    'ℹ suites 0',
    `ℹ pass ${passing}`,
    `ℹ fail ${failures}`,
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 61',
    '',
    '✖ failing tests:',
    '',
  );
  for (let index = 0; index < failures; index += 1) {
    lines.push(`test at b.test.js:${index + 1}:1`, `✖ boom${index} (0.1ms)`);
    for (let frame = 0; frame < 18; frame += 1) {
      lines.push(`    at frame${frame}`);
    }
  }
  return lines.join('\n');
}

test('retains spec-reporter summary lines that fall outside the tail window', () => {
  const output = buildSpecReporterOutput(2000, 3);
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  for (const expected of ['ℹ tests 2003', 'ℹ pass 2000', 'ℹ fail 3', '✖ failing tests:']) {
    assert.ok(retained.includes(expected), expected);
  }
});

test('does not duplicate a summary line that already falls inside the tail window', () => {
  const output = [...Array.from({ length: 60 }, (_, index) => `line-${index + 1}`), 'ℹ tests 1'].join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained.filter((line) => line === 'ℹ tests 1').length, 1);
});

test('caps reserved summary lines at the line limit and keeps the last ones', () => {
  const output = Array.from({ length: 60 }, (_, index) => `ℹ marker ${index + 1}`).join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained[0], '10 lines omitted from validation command output.');
  assert.equal(retained[1], 'ℹ marker 11');
  assert.equal(retained[50], 'ℹ marker 60');
});

test('charges gap markers against the line limit', () => {
  const output = Array.from(
    { length: 100 },
    (_, index) => (index % 2 === 0 ? `ℹ marker ${index}` : `line-${index}`),
  ).join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.ok(retained.length - 1 <= 50, `body was ${retained.length - 1} lines`);
  assert.equal(retained[0], '50 lines omitted from validation command output.');
  assert.ok(retained.includes('ℹ marker 98'));
  assert.ok(!retained.includes('ℹ marker 0'));
  assert.equal(retained.filter((line) => line.startsWith('ℹ marker ')).length, 25);
});

test('marks interior gaps and emits retained lines in original order', () => {
  const output = ['ℹ tests 1', ...Array.from({ length: 60 }, (_, index) => `line-${index + 1}`)].join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained[0], '12 lines omitted from validation command output.');
  assert.equal(retained[1], 'ℹ tests 1');
  assert.equal(retained[2], '… 12 lines omitted …');
  assert.equal(retained[3], 'line-13');
  assert.equal(retained.length - 1, 50);
});

test('gate downgrades first full validation run, grants one retry, then rejects repeats', () => {
  const gate = new RunFullOutputGate();
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'downgrade', effectiveMode: 'auto', downgraded: true },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'retry', effectiveMode: 'full', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'duplicate' },
  );
});

test('every other run forfeits pending or consumed retry state', () => {
  const gate = new RunFullOutputGate();
  gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  assert.deepEqual(
    gate.beginRun({ command: 'Write-Output other', requestedMode: 'auto', isValidationCommand: false }),
    { kind: 'pass', effectiveMode: 'auto', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'downgrade', effectiveMode: 'auto', downgraded: true },
  );
});

test('an intervening run forfeits a consumed retry before the next full request', () => {
  const gate = new RunFullOutputGate();
  gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  assert.deepEqual(
    gate.beginRun({ command: 'Write-Output other', requestedMode: 'auto', isValidationCommand: false }),
    { kind: 'pass', effectiveMode: 'auto', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'downgrade', effectiveMode: 'auto', downgraded: true },
  );
});

test('pass-through requests do not create a retry or consume another command', () => {
  const gate = new RunFullOutputGate();
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'auto', isValidationCommand: true }),
    { kind: 'pass', effectiveMode: 'auto', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'Get-Content build.log', requestedMode: 'full', isValidationCommand: false }),
    { kind: 'pass', effectiveMode: 'full', downgraded: false },
  );
});

test('downgrade notice names the retry affordance', () => {
  assert.match(RUN_FULL_DOWNGRADE_NOTICE, /outputMode "full"/u);
  assert.match(RUN_FULL_DOWNGRADE_NOTICE, /repeat/iu);
});
