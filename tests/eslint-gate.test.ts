import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const LintMessageSchema = z.object({
  ruleId: z.string().nullable(),
  message: z.string(),
}).passthrough();

const LintFileResultSchema = z.object({
  filePath: z.string(),
  messages: z.array(LintMessageSchema),
  errorCount: z.number(),
}).passthrough();

type LintFileResult = z.infer<typeof LintFileResultSchema>;

const ExecErrorSchema = z.object({ stdout: z.string().optional() }).passthrough();

const eslintExecutable = 'node_modules/eslint/bin/eslint.js';
const fixtureNames = [
  'cast.ts',
  'namespace.ts',
  'explicit-any.ts',
  'explicit-unknown.ts',
  'broad-json-union.ts',
  'declaration.d.ts',
  'clean.ts',
  'unused-var.ts',
] as const;

function parseLintOutput(output: string): ReadonlyMap<string, LintFileResult> {
  const results = z.array(LintFileResultSchema).parse(JSON.parse(output));
  assert.equal(results.length, fixtureNames.length);
  return new Map(results.map((result) => [path.basename(result.filePath), result]));
}

function lintFixtures(): ReadonlyMap<string, LintFileResult> {
  try {
    return parseLintOutput(execFileSync(
      process.execPath,
      [
        eslintExecutable,
        '--no-ignore',
        '--format',
        'json',
        ...fixtureNames.map((fixtureName) => `tests/fixtures/eslint-gate/${fixtureName}`),
      ],
      { encoding: 'utf8' },
    ));
  } catch (error) {
    const failed = ExecErrorSchema.parse(error);
    return parseLintOutput(failed.stdout ?? '[]');
  }
}

let lintResults: ReadonlyMap<string, LintFileResult> = new Map();

before(() => {
  lintResults = lintFixtures();
});

function lintFixture(fixtureName: string): LintFileResult {
  const result = lintResults.get(fixtureName);
  if (!result) {
    throw new Error(`ESLint did not return a result for ${fixtureName}.`);
  }
  return result;
}

test('eslint gate flags value casts', () => {
  const result = lintFixture('cast.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/consistent-type-assertions');
});

test('eslint gate flags namespace imports', () => {
  const result = lintFixture('namespace.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags explicit any', () => {
  const result = lintFixture('explicit-any.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/no-explicit-any');
});

test('eslint gate flags explicit unknown', () => {
  const result = lintFixture('explicit-unknown.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags broad JsonValue unions', () => {
  const result = lintFixture('broad-json-union.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate lints project declaration files', () => {
  const result = lintFixture('declaration.d.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate passes clean code', () => {
  const result = lintFixture('clean.ts');
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.messages, []);
});

// An underscore prefix must not silence the unused-vars gate: renaming a dead
// binding to `_dead` would otherwise be a repo-wide, review-invisible opt-out.
test('eslint gate flags unused underscore-prefixed variables', () => {
  const result = lintFixture('unused-var.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/no-unused-vars');
});

// Generated test bundles are 198MB of esbuild output; linting them once cost 160s per run.
// ESLint reports an explicitly-named ignored file with a single "ignored" warning.
test('eslint gate ignores the generated test build tree', () => {
  const output = execFileSync(
    process.execPath,
    [eslintExecutable, '--format', 'json', '.test-build/tests/eslint-gate.test.bundle.js'],
    { encoding: 'utf8' },
  );
  const results = z.array(LintFileResultSchema).parse(JSON.parse(output));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.errorCount, 0);
  assert.match(results[0]?.messages[0]?.message ?? '', /ignored/u);
});
