import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { buildNodeTestArgs, resolveTestTargets } from '../scripts/test-targets.ts';

test('resolveTestTargets maps bare test basenames into the tests directory', () => {
  const resolved = resolveTestTargets(process.cwd(), ['mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, [path.join('tests', 'mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets preserves explicit test paths', () => {
  const resolved = resolveTestTargets(process.cwd(), ['.\\tests\\mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, ['.\\tests\\mock-repo-search-loop.test.ts']);
});

test('resolveTestTargets preserves option values while still resolving later positional targets', () => {
  const resolved = resolveTestTargets(process.cwd(), [
    '--test-name-pattern',
    'runTaskLoop auto-accepts non-thinking finish after ten tool calls without follow-up',
    'mock-repo-search-loop.test.ts',
  ]);
  assert.deepEqual(resolved, [
    '--test-name-pattern',
    'runTaskLoop auto-accepts non-thinking finish after ten tool calls without follow-up',
    path.join('tests', 'mock-repo-search-loop.test.ts'),
  ]);
});

test('buildNodeTestArgs adds default timeout and serial file concurrency before resolved targets', () => {
  const args = buildNodeTestArgs(process.cwd(), ['mock-repo-search-loop.test.ts']);

  assert.deepEqual(args, [
    '--test-timeout=30000',
    '--test-concurrency=24',
    path.join('tests', 'mock-repo-search-loop.test.ts'),
  ]);
});

test('buildNodeTestArgs defaults to tests/*.test.ts when no explicit targets are provided', () => {
  const args = buildNodeTestArgs(process.cwd(), []);

  assert.equal(args[0], '--test-timeout=30000');
  assert.equal(args[1], '--test-concurrency=24');
  assert.equal(args.includes(path.join('tests', 'test-targets.test.ts')), true);
  assert.equal(args.some((value) => /(?:^|[\\/])scripts[\\/]test-targets\.ts$/u.test(value)), false);
  assert.equal(args.some((value) => /(?:^|[\\/])dist[\\/]scripts[\\/]test-targets/u.test(value)), false);
  assert.equal(args.some((value) => value.startsWith('--test-reporter')), false);
});

test('buildNodeTestArgs preserves explicit test runner overrides without duplicating defaults', () => {
  const args = buildNodeTestArgs(process.cwd(), [
    '--test-concurrency=32',
    '--test-reporter=spec',
    '--test-timeout=60000',
  ]);

  assert.equal(args.includes('--test-concurrency=24'), false);
  assert.equal(args.includes('--test-timeout=30000'), false);
  assert.equal(args.includes('--test-concurrency=32'), true);
  assert.equal(args.includes('--test-reporter=spec'), true);
  assert.equal(args.includes('--test-timeout=60000'), true);
});
