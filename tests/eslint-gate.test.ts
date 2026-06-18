import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

type LintMessage = {
  ruleId: string | null;
  message: string;
};

type LintFileResult = {
  filePath: string;
  messages: LintMessage[];
  errorCount: number;
};

const eslintExecutable = 'node_modules/eslint/bin/eslint.js';

function parseLintOutput(output: string): LintFileResult {
  const results = JSON.parse(output) as LintFileResult[];
  assert.equal(results.length, 1);
  return results[0];
}

function lintFixture(fixtureName: string): LintFileResult {
  const output = execFileSync(
    process.execPath,
    [eslintExecutable, '--no-ignore', '--format', 'json', `tests/fixtures/eslint-gate/${fixtureName}`],
    { encoding: 'utf8' },
  );
  return parseLintOutput(output);
}

function lintFixtureAllowingFailure(fixtureName: string): LintFileResult {
  try {
    return lintFixture(fixtureName);
  } catch (error) {
    const failed = error as { stdout?: string };
    return parseLintOutput(failed.stdout ?? '[]');
  }
}

test('eslint gate flags value casts', () => {
  const result = lintFixtureAllowingFailure('cast.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/consistent-type-assertions');
});

test('eslint gate flags namespace imports', () => {
  const result = lintFixtureAllowingFailure('namespace.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags explicit any', () => {
  const result = lintFixtureAllowingFailure('explicit-any.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/no-explicit-any');
});

test('eslint gate flags explicit unknown', () => {
  const result = lintFixtureAllowingFailure('explicit-unknown.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags broad JsonValue unions', () => {
  const result = lintFixtureAllowingFailure('broad-json-union.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate lints project declaration files', () => {
  const result = lintFixtureAllowingFailure('declaration.d.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate passes clean code', () => {
  const result = lintFixture('clean.ts');
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.messages, []);
});
