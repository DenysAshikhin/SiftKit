import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_RUNNER_OPTIONS_WITH_VALUES = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
]);

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
  const testsRelativePath = path.join('tests', rawValue);
  if (fs.existsSync(path.resolve(repoRoot, testsRelativePath))) {
    return testsRelativePath;
  }
  return rawValue;
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
