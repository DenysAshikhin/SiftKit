import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from '../../src/lib/errors.js';

import { missingBranchKeys } from './coverage-attribution-core.js';
import { runOneTestInIsolation } from './coverage-isolation-runner.js';

interface TestRef {
  file: string;
  name: string;
}

function parseRef(raw: string): TestRef {
  const separator = raw.lastIndexOf('::');
  if (separator === -1) {
    throw new Error(`expected <file>::<test name>, got: ${raw}`);
  }
  return { file: raw.slice(0, separator), name: raw.slice(separator + 2) };
}

function collectRefs(argv: string[], flag: string): TestRef[] {
  const refs: TestRef[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === flag && index + 1 < argv.length) {
      refs.push(parseRef(argv[index + 1]));
    }
  }
  return refs;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const deletedIndex = argv.indexOf('--deleted');
  const deletedRaw = deletedIndex === -1 ? undefined : argv[deletedIndex + 1];
  if (!deletedRaw) {
    throw new Error('usage: coverage-verify-subset --deleted <file>::<name> --cover <file>::<name> [--cover ...]');
  }
  const deleted = parseRef(deletedRaw);
  const covering = collectRefs(argv, '--cover');
  if (covering.length === 0) {
    throw new Error('at least one --cover <file>::<name> is required');
  }

  const outRoot = path.join(repoRoot, '.coverage-attr', 'verify');
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const deletedResult = await runOneTestInIsolation(path.resolve(repoRoot, deleted.file), deleted.name, 0, outRoot);
  if (!deletedResult.ok) {
    throw new Error(`deleted test produced no coverage (exit ${deletedResult.exitCode}; name mismatch or red test?): ${deleted.name}`);
  }
  const coveringSets: string[][] = [];
  for (let index = 0; index < covering.length; index++) {
    const ref = covering[index];
    const result = await runOneTestInIsolation(path.resolve(repoRoot, ref.file), ref.name, index + 1, outRoot);
    if (!result.ok) {
      throw new Error(`covering test produced no coverage (exit ${result.exitCode}; name mismatch or red test?): ${ref.name}`);
    }
    coveringSets.push(result.branchKeys);
  }

  const missing = missingBranchKeys(deletedResult.branchKeys, coveringSets);
  process.stdout.write(`deleted branches: ${deletedResult.branchKeys.length}\n`);
  process.stdout.write(`MISSING: ${missing.length}\n`);
  for (const key of missing) {
    process.stdout.write(`  ${key}\n`);
  }
  process.exit(missing.length === 0 ? 0 : 2);
}

main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exit(1);
});
