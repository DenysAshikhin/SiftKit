import fs from 'node:fs';
import path from 'node:path';

import { TESTS_DIRECTORY } from './test-environment.ts';

type TestSuite = 'node' | 'process' | 'perf';
type TestEntry = { source: string; suite: TestSuite };

const TEST_RUNNER_OPTIONS_WITH_VALUES = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
]);
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_CONCURRENCY = 12;
const SUITE_OPTIONS = new Map<string, TestSuite>([['--process', 'process'], ['--perf', 'perf']]);
/** Perf tests measure CPU time, so no other test file may run beside them. */
const SERIAL_SUITE = 'perf';
const TIMEOUT_OPTION = '--test-timeout';
const CONCURRENCY_OPTION = '--test-concurrency';
const DASHBOARD_OPTION = '--dashboard';

function getTestSuite(source: string): TestSuite {
  if (source.startsWith('tests/process/')) return 'process';
  return source.startsWith('tests/perf/') ? 'perf' : 'node';
}

// Dot-directories under tests/ are per-run scratch homes, never test sources.
function listTestEntries(repoRoot: string): TestEntry[] {
  return fs.readdirSync(path.join(repoRoot, TESTS_DIRECTORY), { recursive: true, encoding: 'utf8' })
    .map((relativePath) => `${TESTS_DIRECTORY}/${relativePath.split(path.sep).join('/')}`)
    .filter((source) => source.endsWith('.test.ts') && !source.split('/').some((segment) => segment.startsWith('.')))
    .sort((left, right) => left.localeCompare(right))
    .map((source) => ({ source, suite: getTestSuite(source) }));
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function toPlatformPath(source: string): string {
  return source.split('/').join(path.sep);
}

function sortedTargets(entries: TestEntry[]): string[] {
  return entries.map((entry) => toPlatformPath(entry.source)).sort((left, right) => left.localeCompare(right));
}

function resolveSingleTestTarget(tests: TestEntry[], rawValue: string): string[] {
  if (!rawValue) {
    throw new Error('A test target cannot be empty.');
  }
  if (hasPathSeparator(rawValue)) {
    const sourcePath = path.normalize(rawValue).split(path.sep).join('/').replace(/^\.\//u, '');
    const matched = tests.find((entry) => entry.source === sourcePath);
    if (matched) {
      return [toPlatformPath(matched.source)];
    }
    throw new Error(`No test file matches ${rawValue}.`);
  }
  // A basename can exist in more than one suite; an exact name selects every such file.
  const exactTargets = tests.filter((entry) => path.posix.basename(entry.source) === rawValue);
  const matchingTargets = exactTargets.length > 0 ? exactTargets : tests.filter((entry) => path.posix.basename(entry.source).includes(rawValue));
  if (matchingTargets.length === 0) {
    throw new Error(`No test file matches ${rawValue}.`);
  }
  return sortedTargets(matchingTargets);
}

function getDefaultTestTargets(tests: TestEntry[]): string[] {
  return sortedTargets(tests.filter((entry) => entry.suite === 'node' && !entry.source.slice(`${TESTS_DIRECTORY}/`.length).includes('/')));
}

function resolveTestArguments(repoRoot: string, rawArgs: string[]) {
  const tests = listTestEntries(repoRoot);
  const resolvedArgs: string[] = [];
  let targetCount = 0;
  let nextArgumentIsOptionValue = false;
  for (const rawArg of rawArgs) {
    if (rawArg === DASHBOARD_OPTION) {
      throw new Error('Dashboard tests run on Vitest: npm run test:dashboard');
    }
    if (nextArgumentIsOptionValue) {
      resolvedArgs.push(rawArg);
      nextArgumentIsOptionValue = false;
      continue;
    }
    if (TEST_RUNNER_OPTIONS_WITH_VALUES.has(rawArg)) {
      resolvedArgs.push(rawArg);
      nextArgumentIsOptionValue = true;
      continue;
    }
    const suite = SUITE_OPTIONS.get(rawArg);
    if (suite) {
      const suiteTargets = sortedTargets(tests.filter((entry) => entry.suite === suite));
      resolvedArgs.push(...suiteTargets);
      targetCount += suiteTargets.length;
      continue;
    }
    if (rawArg.startsWith('-')) {
      resolvedArgs.push(rawArg);
      continue;
    }
    const targets = resolveSingleTestTarget(tests, rawArg);
    resolvedArgs.push(...targets);
    targetCount += targets.length;
  }
  const serialTargets = new Set(sortedTargets(tests.filter((entry) => entry.suite === SERIAL_SUITE)));
  return { args: resolvedArgs, targetCount, tests, serial: resolvedArgs.some((arg) => serialTargets.has(arg)) };
}

export function resolveTestTargets(repoRoot: string, rawArgs: string[]): string[] {
  return resolveTestArguments(repoRoot, rawArgs).args;
}

function hasExplicitOption(rawArgs: string[], optionName: string): boolean {
  return rawArgs.some((rawArg) => rawArg === optionName || rawArg.startsWith(`${optionName}=`));
}

export function buildNodeTestArgs(repoRoot: string, rawArgs: string[]): string[] {
  const resolved = resolveTestArguments(repoRoot, rawArgs);
  const defaultArgs: string[] = [];
  if (!hasExplicitOption(rawArgs, TIMEOUT_OPTION)) {
    defaultArgs.push(`${TIMEOUT_OPTION}=${DEFAULT_TEST_TIMEOUT_MS}`);
  }
  if (!hasExplicitOption(rawArgs, CONCURRENCY_OPTION)) {
    defaultArgs.push(`${CONCURRENCY_OPTION}=${resolved.serial ? 1 : DEFAULT_TEST_CONCURRENCY}`);
  }
  return [
    ...defaultArgs,
    ...resolved.args,
    ...(resolved.targetCount > 0 ? [] : getDefaultTestTargets(resolved.tests)),
  ];
}
