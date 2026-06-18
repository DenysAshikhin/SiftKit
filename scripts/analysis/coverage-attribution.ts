import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildCandidates,
  extractTestNames,
} from './coverage-attribution-core.js';
import { attributeFile } from './coverage-isolation-runner.js';

function readNumberFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    return fallback;
  }
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const testFile = argv[0];
  if (!testFile || testFile.startsWith('--')) {
    throw new Error('usage: coverage-attribution <testFile> [--concurrency N] [--threshold N]');
  }
  const concurrency = readNumberFlag(argv, '--concurrency', 4);
  const threshold = readNumberFlag(argv, '--threshold', 8);
  const fileId = path.basename(testFile).replace(/\.test\.ts$/, '');
  const outRoot = path.join(repoRoot, '.coverage-attr', fileId);
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const source = fs.readFileSync(path.resolve(repoRoot, testFile), 'utf8');
  const names = extractTestNames(source);
  process.stderr.write(`attributing ${names.length} tests in ${testFile} (concurrency ${concurrency})\n`);
  const results = await attributeFile(path.resolve(repoRoot, testFile), names, concurrency, outRoot);

  const failed = results.filter((entry) => !entry.ok);
  const candidates = buildCandidates(results, threshold);
  const report = {
    file: testFile,
    threshold,
    failedIsolations: failed.map((entry) => ({ name: entry.name, exitCode: entry.exitCode })),
    tests: results.map((entry) => ({ index: entry.index, name: entry.name, ok: entry.ok, branchCount: entry.branchKeys.length })),
    candidates,
  };
  const reportPath = path.join(repoRoot, '.coverage-attr', `report.${fileId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`report: ${reportPath}\n`);

  if (failed.length > 0) {
    process.stdout.write(`FAILED isolations: ${failed.length} (see report; inspect .coverage-attr/${fileId}/<index>/run.log)\n`);
    for (const entry of failed) {
      process.stdout.write(`  exit ${entry.exitCode}: "${entry.name}"\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`candidates (residual <= ${threshold}): ${candidates.length}\n`);
  for (const candidate of candidates) {
    process.stdout.write(
      `  DELETE [${candidate.deleteIndex}] "${candidate.deleteName}" (residual ${candidate.residualCount}) <= KEEP [${candidate.keepIndex}] "${candidate.keepName}"\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
