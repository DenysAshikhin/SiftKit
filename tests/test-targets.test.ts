import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildNodeTestArgs, resolveTestTargets } from '../scripts/test-targets.js';

test('resolveTestTargets maps bare test basenames into the tests directory', () => {
  const resolved = resolveTestTargets(process.cwd(), ['mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, [path.join('.test-build', 'tests', 'mock-repo-search-loop.test.js')]);
});

test('resolveTestTargets prefers one exact basename over partial matches', () => {
  const resolved = resolveTestTargets(process.cwd(), ['config.test.ts']);

  assert.deepEqual(resolved, [path.join('.test-build', 'tests', 'config.test.js')]);
});

test('resolveTestTargets maps bundled dashboard source tests into the compiled test directory', () => {
  const resolved = resolveTestTargets(process.cwd(), ['dashboard-api.test.ts']);

  assert.deepEqual(resolved, [path.join('.test-build', 'tests', 'dashboard-api.test.js')]);
});

test('resolveTestTargets maps bare prefixes to matching test files', () => {
  const resolved = resolveTestTargets(process.cwd(), ['dashboard']);

  assert.equal(resolved.includes(path.join('.test-build', 'tests', 'dashboard-status-server.run-logs.test.js')), true);
  assert.equal(resolved.includes(path.join('.test-build', 'tests', 'dashboard-status-server.test.js')), true);
  assert.equal(resolved.includes('dashboard'), false);
});

test('resolveTestTargets preserves explicit test paths', () => {
  const resolved = resolveTestTargets(process.cwd(), ['.\\tests\\mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, [path.join('.test-build', 'tests', 'mock-repo-search-loop.test.js')]);
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
    path.join('.test-build', 'tests', 'mock-repo-search-loop.test.js'),
  ]);
});

test('buildNodeTestArgs adds default timeout and twelve-file concurrency before resolved targets', () => {
  const args = buildNodeTestArgs(process.cwd(), ['mock-repo-search-loop.test.ts']);

  assert.deepEqual(args, [
    '--test-timeout=30000',
    '--test-concurrency=12',
    path.join('.test-build', 'tests', 'mock-repo-search-loop.test.js'),
  ]);
});

test('buildNodeTestArgs defaults to tests/*.test.ts when no explicit targets are provided', () => {
  const args = buildNodeTestArgs(process.cwd(), []);

  assert.equal(args[0], '--test-timeout=30000');
  assert.equal(args[1], '--test-concurrency=12');
  assert.equal(args.includes(path.join('.test-build', 'tests', 'test-targets.test.js')), true);
  assert.equal(args.includes(path.join('.test-build', 'tests', 'dashboard-api.test.js')), true);
  assert.equal(args.some((value) => /(?:^|[\\/])scripts[\\/]test-targets\.ts$/u.test(value)), false);
  assert.equal(args.some((value) => /(?:^|[\\/])dist[\\/]scripts[\\/]test-targets/u.test(value)), false);
  assert.equal(args.some((value) => value.startsWith('--test-reporter')), false);
});

test('buildNodeTestArgs adds default top-level targets when only runner options are provided', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--test-concurrency=6']);

  assert.equal(args.includes(path.join('.test-build', 'tests', 'test-targets.test.js')), true);
  assert.equal(args.includes(path.join('.test-build', 'tests', 'fixtures', 'hangs-forever.test.js')), false);
});

test('resolveTestTargets rejects a source target with no compiled artifact', () => {
  assert.throws(
    () => resolveTestTargets(process.cwd(), ['tests/not-built.test.ts']),
    /No compiled test artifact matches/u,
  );
});

test('buildNodeTestArgs preserves explicit test runner overrides without duplicating defaults', () => {
  const args = buildNodeTestArgs(process.cwd(), [
    '--test-concurrency=32',
    '--test-reporter=spec',
    '--test-timeout=60000',
  ]);

  assert.equal(args.includes('--test-concurrency=6'), false);
  assert.equal(args.includes('--test-timeout=30000'), false);
  assert.equal(args.includes('--test-concurrency=32'), true);
  assert.equal(args.includes('--test-reporter=spec'), true);
  assert.equal(args.includes('--test-timeout=60000'), true);
});

test('dashboard option resolves every nested dashboard test and is not forwarded to node', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--dashboard']);
  assert.equal(args.includes(path.join('.test-build', 'dashboard', 'tests', 'api-stream.test.js')), true);
  assert.equal(args.includes(path.join('.test-build', 'dashboard', 'tests', 'hooks', 'useChatSessions.test.js')), true);
  assert.equal(args.includes('--dashboard'), false);
});

test('dashboard targets are deterministic and coexist with test-name-pattern', () => {
  const args = buildNodeTestArgs(process.cwd(), [
    '--dashboard',
    '--test-name-pattern',
    'two streams complete out of order',
  ]);
  const targets = args.filter((value) => value.startsWith(`.test-build${path.sep}dashboard${path.sep}tests${path.sep}`));
  assert.deepEqual(targets, [...targets].sort());
  assert.equal(args.includes('--test-name-pattern'), true);
  assert.equal(args.includes('two streams complete out of order'), true);
});
