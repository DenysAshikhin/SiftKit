import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from '../../src/lib/zod.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import {
  collectCoveredBranchKeys,
  escapeForNamePattern,
  CoverageFinalSchema,
  type TestBranchSet,
} from './coverage-attribution-core.js';

const PackageVersionSchema = z.object({ version: z.string() });
const IsolationResultSchema = z.object({
  index: z.number(),
  name: z.string(),
  branchKeys: z.array(z.string()),
  ok: z.boolean(),
  exitCode: z.number(),
});

const repoRoot = process.cwd();
const tsxCli = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const c8Cli = path.resolve(repoRoot, 'node_modules', 'c8', 'bin', 'c8.js');
const cacheDir = path.join(repoRoot, '.coverage-attr', 'cache');

function readToolVersions(): string {
  const c8Pkg = PackageVersionSchema.parse(parseJsonValueText(fs.readFileSync(path.resolve(repoRoot, 'node_modules', 'c8', 'package.json'), 'utf8')));
  const tsxPkg = PackageVersionSchema.parse(parseJsonValueText(fs.readFileSync(path.resolve(repoRoot, 'node_modules', 'tsx', 'package.json'), 'utf8')));
  return `c8@${c8Pkg.version}|tsx@${tsxPkg.version}|node@${process.version}`;
}

const toolVersions = readToolVersions();

export interface IsolationResult extends TestBranchSet {
  ok: boolean;
  exitCode: number;
}

function cacheKeyFor(testFile: string, name: string): string {
  const fileHash = createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  return createHash('sha256').update(`${fileHash}|${name}|${toolVersions}`).digest('hex');
}

function readCache(key: string): IsolationResult | null {
  const cachePath = path.join(cacheDir, `${key}.json`);
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  return IsolationResultSchema.parse(parseJsonValueText(fs.readFileSync(cachePath, 'utf8')));
}

function writeCache(key: string, result: IsolationResult): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(result));
}

function parseTapCounts(output: string): { tests: number; fail: number } {
  const testsMatch = output.match(/^# tests (\d+)/m);
  const failMatch = output.match(/^# fail (\d+)/m);
  return {
    tests: testsMatch ? Number(testsMatch[1]) : 0,
    fail: failMatch ? Number(failMatch[1]) : 1,
  };
}

export function runOneTestInIsolation(
  testFile: string,
  name: string,
  index: number,
  outRoot: string,
): Promise<IsolationResult> {
  const key = cacheKeyFor(testFile, name);
  const cached = readCache(key);
  if (cached !== null) {
    return Promise.resolve({ ...cached, index, name });
  }

  const outDir = path.join(outRoot, String(index));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    c8Cli,
    '--reporter=json',
    `--report-dir=${outDir}`,
    `--temp-directory=${path.join(outDir, 'tmp')}`,
    '--include=src/**/*.ts',
    '--exclude=node_modules/**',
    '--exclude=tests/**',
    process.execPath,
    tsxCli,
    '--test',
    '--test-reporter=tap',
    `--test-name-pattern=${escapeForNamePattern(name)}`,
    testFile,
  ];
  return new Promise<IsolationResult>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync(path.join(outDir, 'run.log'), output);
      const exitCode = code ?? -1;
      const counts = parseTapCounts(output);
      const jsonPath = path.join(outDir, 'coverage-final.json');
      const ok = exitCode === 0 && counts.tests >= 1 && counts.fail === 0 && fs.existsSync(jsonPath);
      if (!ok) {
        const failed: IsolationResult = { index, name, branchKeys: [], ok: false, exitCode };
        writeCache(key, failed);
        resolve(failed);
        return;
      }
      const coverage = CoverageFinalSchema.parse(parseJsonValueText(fs.readFileSync(jsonPath, 'utf8')));
      const result: IsolationResult = { index, name, branchKeys: [...collectCoveredBranchKeys(coverage, repoRoot)], ok: true, exitCode: 0 };
      writeCache(key, result);
      // Per-test c8 output (full istanbul coverage-final.json + temp dir) is large and now
      // redundant with the cached branch keys. Leaving it accumulates GBs under .coverage-attr,
      // which scanRepoFiles enumerates (it honors its own ignore names, not .gitignore) and
      // overflows repo-scanning tests. Drop it on success; failures keep run.log for debugging.
      fs.rmSync(outDir, { recursive: true, force: true });
      resolve(result);
    });
  });
}

export async function attributeFile(
  testFile: string,
  names: string[],
  concurrency: number,
  outRoot: string,
): Promise<IsolationResult[]> {
  const results: IsolationResult[] = new Array(names.length);
  let next = 0;
  const laneCount = Math.min(concurrency, names.length);
  const lanes: Promise<void>[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    lanes.push(
      (async () => {
        for (;;) {
          const current = next;
          next += 1;
          if (current >= names.length) {
            return;
          }
          process.stderr.write(`  [${current + 1}/${names.length}] ${names[current]}\n`);
          results[current] = await runOneTestInIsolation(testFile, names[current], current, outRoot);
        }
      })(),
    );
  }
  await Promise.all(lanes);
  return results;
}
