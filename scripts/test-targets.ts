import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_RUNNER_OPTIONS_WITH_VALUES = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
]);
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_CONCURRENCY = 24;
const TESTS_DIRECTORY = 'tests';
const TEST_FILE_SUFFIX = '.test.ts';
const TIMEOUT_OPTION = '--test-timeout';
const CONCURRENCY_OPTION = '--test-concurrency';

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveSingleTestTarget(repoRoot: string, rawValue: string): string {
  if (!rawValue) {
    return rawValue;
  }
  if (hasPathSeparator(rawValue) && fs.existsSync(path.resolve(repoRoot, rawValue))) {
    return rawValue;
  }
  const testsRelativePath = path.join(TESTS_DIRECTORY, rawValue);
  if (fs.existsSync(path.resolve(repoRoot, testsRelativePath))) {
    return testsRelativePath;
  }
  return rawValue;
}

function getDefaultTestTargets(repoRoot: string): string[] {
  const testsPath = path.resolve(repoRoot, TESTS_DIRECTORY);
  if (!fs.existsSync(testsPath)) {
    return [];
  }
  return fs.readdirSync(testsPath)
    .filter((entry) => entry.endsWith(TEST_FILE_SUFFIX))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(TESTS_DIRECTORY, entry));
}

export function resolveTestTargets(repoRoot: string, rawArgs: string[]): string[] {
  const resolvedArgs: string[] = [];
  let nextArgumentIsOptionValue = false;
  for (const rawArg of rawArgs) {
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
    if (rawArg.startsWith('-')) {
      resolvedArgs.push(rawArg);
      continue;
    }
    resolvedArgs.push(resolveSingleTestTarget(repoRoot, rawArg));
  }
  return resolvedArgs;
}

function hasExplicitOption(rawArgs: string[], optionName: string): boolean {
  return rawArgs.some((rawArg) => rawArg === optionName || rawArg.startsWith(`${optionName}=`));
}

export function buildNodeTestArgs(repoRoot: string, rawArgs: string[]): string[] {
  const resolvedTargets = resolveTestTargets(repoRoot, rawArgs);
  const defaultArgs: string[] = [];
  if (!hasExplicitOption(rawArgs, TIMEOUT_OPTION)) {
    defaultArgs.push(`${TIMEOUT_OPTION}=${DEFAULT_TEST_TIMEOUT_MS}`);
  }
  if (!hasExplicitOption(rawArgs, CONCURRENCY_OPTION)) {
    defaultArgs.push(`${CONCURRENCY_OPTION}=${DEFAULT_TEST_CONCURRENCY}`);
  }
  return [
    ...defaultArgs,
    ...(resolvedTargets.length > 0 ? resolvedTargets : getDefaultTestTargets(repoRoot)),
  ];
}
