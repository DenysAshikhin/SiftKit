import fs from 'node:fs';
import path from 'node:path';

const TEST_RUNNER_OPTIONS_WITH_VALUES = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
]);
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_CONCURRENCY = 12;
const TEST_BUILD_DIRECTORY = '.test-build';
const TESTS_DIRECTORY = path.join(TEST_BUILD_DIRECTORY, 'tests');
const TEST_FILE_SUFFIX = '.test.js';
const DASHBOARD_TESTS_DIRECTORY = path.join(TEST_BUILD_DIRECTORY, 'dashboard', 'tests');
const DASHBOARD_TESTS_OPTION = '--dashboard';
const TIMEOUT_OPTION = '--test-timeout';
const CONCURRENCY_OPTION = '--test-concurrency';

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function getMatchingTestTargets(repoRoot: string, rawValue: string): string[] {
  if (!rawValue || hasPathSeparator(rawValue)) {
    return [];
  }
  const compiledValue = rawValue.replace(/\.tsx?$/u, '.js');
  const exactTarget = path.join(TESTS_DIRECTORY, compiledValue);
  if (fs.existsSync(path.resolve(repoRoot, exactTarget))) {
    return [exactTarget];
  }
  const testsPath = path.resolve(repoRoot, TESTS_DIRECTORY);
  if (!fs.existsSync(testsPath)) {
    return [];
  }
  return fs.readdirSync(testsPath)
    .filter((entry) => entry.endsWith(TEST_FILE_SUFFIX) && entry.includes(compiledValue))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(TESTS_DIRECTORY, entry));
}

function resolveSingleTestTarget(repoRoot: string, rawValue: string): string[] {
  if (!rawValue) {
    throw new Error('A test target cannot be empty.');
  }
  if (hasPathSeparator(rawValue)) {
    const normalizedPath = path.normalize(rawValue);
    const normalized = normalizedPath.startsWith(`.${path.sep}`) ? normalizedPath.slice(2) : normalizedPath;
    const compiledCandidates: string[] = [];
    if (normalized.startsWith(`tests${path.sep}`)) {
      const testPath = normalized.slice(`tests${path.sep}`.length).replace(/\.tsx?$/u, '.js');
      compiledCandidates.push(path.join(TESTS_DIRECTORY, testPath));
    } else if (normalized.startsWith(`dashboard${path.sep}tests${path.sep}`)) {
      compiledCandidates.push(path.join(TEST_BUILD_DIRECTORY, normalized).replace(/\.tsx?$/u, '.js'));
    } else if (normalized.startsWith(`${TEST_BUILD_DIRECTORY}${path.sep}`)) {
      compiledCandidates.push(normalized);
    }
    const compiledTarget = compiledCandidates.find((candidate) => fs.existsSync(path.resolve(repoRoot, candidate)));
    if (compiledTarget) {
      return [compiledTarget];
    }
    throw new Error(`No compiled test artifact matches ${rawValue}. Run npm run build:test.`);
  }
  const matchingTargets = getMatchingTestTargets(repoRoot, rawValue);
  if (matchingTargets.length === 0) {
    throw new Error(`No compiled test artifact matches ${rawValue}. Run npm run build:test.`);
  }
  return matchingTargets;
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

function collectDashboardTestTargets(repoRoot: string, directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const targets: string[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      targets.push(...collectDashboardTestTargets(repoRoot, entryPath));
    } else if (entry.name.endsWith(TEST_FILE_SUFFIX)) {
      targets.push(path.relative(repoRoot, entryPath));
    }
  }
  return targets.sort();
}

function resolveTestArguments(repoRoot: string, rawArgs: string[]) {
  const resolvedArgs: string[] = [];
  let targetCount = 0;
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
    if (rawArg === DASHBOARD_TESTS_OPTION) {
      const dashboardTargets = collectDashboardTestTargets(
        repoRoot,
        path.resolve(repoRoot, DASHBOARD_TESTS_DIRECTORY),
      );
      resolvedArgs.push(...dashboardTargets);
      targetCount += dashboardTargets.length;
      continue;
    }
    if (rawArg.startsWith('-')) {
      resolvedArgs.push(rawArg);
      continue;
    }
    const targets = resolveSingleTestTarget(repoRoot, rawArg);
    resolvedArgs.push(...targets);
    targetCount += targets.length;
  }
  return { args: resolvedArgs, targetCount };
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
    defaultArgs.push(`${CONCURRENCY_OPTION}=${DEFAULT_TEST_CONCURRENCY}`);
  }
  return [
    ...defaultArgs,
    ...resolved.args,
    ...(resolved.targetCount > 0 ? [] : getDefaultTestTargets(repoRoot)),
  ];
}
