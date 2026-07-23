import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  ValidationCommandOutputPolicy,
} from '../src/repo-search/engine/validation-command-output-policy.js';

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
