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

/** `scopeLabel` names the suites a filter was limited to, so a miss says where it looked. */
function resolveSingleTestTarget(tests: TestEntry[], rawValue: string, scopeLabel: string): string[] {
  if (!rawValue) {
    throw new Error('A test target cannot be empty.');
  }
  const noMatch = new Error(`No ${scopeLabel}test file matches ${rawValue}.`);
  if (hasPathSeparator(rawValue)) {
    const sourcePath = path.normalize(rawValue).split(path.sep).join('/').replace(/^\.\//u, '');
    const matched = tests.find((entry) => entry.source === sourcePath);
    if (matched) {
      return [toPlatformPath(matched.source)];
    }
    throw noMatch;
  }
  // A basename can exist in more than one suite; an exact name selects every such file.
  const exactTargets = tests.filter((entry) => path.posix.basename(entry.source) === rawValue);
  const matchingTargets = exactTargets.length > 0 ? exactTargets : tests.filter((entry) => path.posix.basename(entry.source).includes(rawValue));
  if (matchingTargets.length === 0) {
    throw noMatch;
  }
  return sortedTargets(matchingTargets);
}

type ClassifiedArgument = { kind: 'pass'; arg: string } | { kind: 'suite'; suite: TestSuite } | { kind: 'target'; arg: string };

function classifyArguments(rawArgs: string[]): ClassifiedArgument[] {
  const classified: ClassifiedArgument[] = [];
  let nextArgumentIsOptionValue = false;
  for (const rawArg of rawArgs) {
    if (rawArg === DASHBOARD_OPTION) {
      throw new Error('Dashboard tests run on Vitest: npm run test:dashboard');
    }
    const suite = nextArgumentIsOptionValue ? undefined : SUITE_OPTIONS.get(rawArg);
    if (suite) {
      classified.push({ kind: 'suite', suite });
    } else if (nextArgumentIsOptionValue || rawArg.startsWith('-')) {
      classified.push({ kind: 'pass', arg: rawArg });
    } else {
      classified.push({ kind: 'target', arg: rawArg });
    }
    nextArgumentIsOptionValue = !nextArgumentIsOptionValue && TEST_RUNNER_OPTIONS_WITH_VALUES.has(rawArg);
  }
  return classified;
}

function getDefaultTestTargets(tests: TestEntry[]): string[] {
  return sortedTargets(tests.filter((entry) => entry.suite === 'node' && !entry.source.slice(`${TESTS_DIRECTORY}/`.length).includes('/')));
}

function resolveTestArguments(repoRoot: string, rawArgs: string[]) {
  const tests = listTestEntries(repoRoot);
  const classified = classifyArguments(rawArgs);
  const suites = new Set(classified.flatMap((entry) => (entry.kind === 'suite' ? [entry.suite] : [])));
  const hasNamedTargets = classified.some((entry) => entry.kind === 'target');
  // A suite option alone runs the whole suite; with name filters it limits them to that suite.
  const scope = suites.size === 0 ? tests : tests.filter((entry) => suites.has(entry.suite));
  const scopeLabel = suites.size === 0 ? '' : `${[...suites].join(' or ')} `;
  // Node ignores runner options that follow a test file, so every option goes before the targets.
  const runnerArgs = classified.flatMap((entry) => (entry.kind === 'pass' ? [entry.arg] : []));
  const targets = classified.flatMap((entry) => {
    if (entry.kind === 'pass') return [];
    if (entry.kind === 'target') return resolveSingleTestTarget(scope, entry.arg, scopeLabel);
    return hasNamedTargets ? [] : sortedTargets(tests.filter((test) => test.suite === entry.suite));
  });
  const serialTargets = new Set(sortedTargets(tests.filter((entry) => entry.suite === SERIAL_SUITE)));
  return { args: [...runnerArgs, ...targets], targetCount: targets.length, tests, serial: targets.some((arg) => serialTargets.has(arg)) };
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
