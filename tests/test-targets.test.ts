import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildNodeTestArgs, resolveTestTargets } from '../src/test-runner/test-targets.ts';

const target = (...parts: string[]): string => path.join('tests', ...parts);

test('resolveTestTargets maps bare test basenames into the tests directory', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['mock-repo-search-loop.test.ts']), [target('mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets prefers one exact basename over partial matches', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['config.test.ts']), [target('config.test.ts'), target('process', 'config.test.ts')]);
});

test('resolveTestTargets maps bare prefixes to matching test files', () => {
  const resolved = resolveTestTargets(process.cwd(), ['dashboard-status-server']);
  assert.equal(resolved.includes(target('dashboard-status-server.run-logs.test.ts')), true);
  assert.equal(resolved.includes(target('dashboard-status-server.test.ts')), true);
  assert.equal(resolved.includes('dashboard-status-server'), false);
});

test('resolveTestTargets preserves explicit test paths', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['.\\tests\\mock-repo-search-loop.test.ts']), [target('mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets preserves option values while still resolving later positional targets', () => {
  const resolved = resolveTestTargets(process.cwd(), ['--test-name-pattern', 'runTaskLoop auto-accepts', 'mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, ['--test-name-pattern', 'runTaskLoop auto-accepts', target('mock-repo-search-loop.test.ts')]);
});

test('buildNodeTestArgs adds default timeout and twelve-file concurrency before resolved targets', () => {
  assert.deepEqual(buildNodeTestArgs(process.cwd(), ['mock-repo-search-loop.test.ts']), [
    '--test-timeout=30000',
    '--test-concurrency=12',
    target('mock-repo-search-loop.test.ts'),
  ]);
});

test('buildNodeTestArgs defaults to top-level tests/*.test.ts when no explicit targets are provided', () => {
  const args = buildNodeTestArgs(process.cwd(), []);
  assert.equal(args[0], '--test-timeout=30000');
  assert.equal(args[1], '--test-concurrency=12');
  assert.equal(args.includes(target('test-targets.test.ts')), true);
  assert.equal(args.includes(target('dashboard-api.test.ts')), true);
  assert.equal(args.includes(target('fixtures', 'hangs-forever.test.ts')), false);
  assert.equal(args.some((value) => value.startsWith('--test-reporter')), false);
});

test('buildNodeTestArgs adds default top-level targets when only runner options are provided', () => {
  assert.equal(buildNodeTestArgs(process.cwd(), ['--test-concurrency=6']).includes(target('test-targets.test.ts')), true);
});

test('resolveTestTargets rejects a target that names no test file', () => {
  assert.throws(() => resolveTestTargets(process.cwd(), ['tests/not-a-real.test.ts']), /No test file matches/u);
  assert.throws(() => resolveTestTargets(process.cwd(), ['no-such-prefix-anywhere']), /No test file matches/u);
});

test('buildNodeTestArgs preserves explicit test runner overrides without duplicating defaults', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--test-concurrency=32', '--test-reporter=spec', '--test-timeout=60000']);
  assert.deepEqual(args.filter((arg) => arg.startsWith('--test-concurrency=')), ['--test-concurrency=32']);
  assert.equal(args.includes('--test-timeout=30000'), false);
  assert.equal(args.includes('--test-reporter=spec'), true);
  assert.equal(args.includes('--test-timeout=60000'), true);
});

test('process option resolves every tests/process test and is not forwarded to node', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--process']);
  assert.equal(args.includes(target('process', 'run-tests-watchdog.test.ts')), true);
  assert.equal(args.includes(target('config.test.ts')), false);
  assert.equal(args.includes('--process'), false);
});

test('default runs exclude the opt-in process suite', () => {
  const args = buildNodeTestArgs(process.cwd(), []);
  assert.equal(args.some((value) => value.startsWith(target('process') + path.sep)), false);
  assert.equal(args.includes(target('config.test.ts')), true);
});

test('a basename shared by the default and process suites resolves to both files', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['runtime-status-server.test.ts']), [
    target('process', 'runtime-status-server.test.ts'),
    target('runtime-status-server.test.ts'),
  ]);
});

test('perf option resolves tests/perf, runs one file at a time, and no other run includes it', () => {
  const perfTarget = target('perf', 'chat-stream-load.test.ts');
  const args = buildNodeTestArgs(process.cwd(), ['--perf']);
  assert.equal(args.includes(perfTarget), true);
  assert.equal(args.includes('--test-concurrency=1'), true);
  assert.equal(args.includes('--perf'), false);
  for (const other of [[], ['--process']]) assert.equal(buildNodeTestArgs(process.cwd(), other).includes(perfTarget), false);
});

test('a perf test named on its own still runs one file at a time', () => {
  assert.equal(buildNodeTestArgs(process.cwd(), ['chat-stream-load.test.ts']).includes('--test-concurrency=1'), true);
});

test('the dashboard option fails loudly because dashboard tests run on Vitest', () => {
  assert.throws(() => buildNodeTestArgs(process.cwd(), ['--dashboard']), /npm run test:dashboard/u);
});
