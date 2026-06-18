# E2E Dedup via Coverage-Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete redundant E2E cases in the 7 test suites over 1000 lines without losing `src/**` branch coverage, using per-test branch attribution to prove every deletion is safe.

**Architecture:** Build a typed, tested, **unshipped** coverage-attribution harness under `scripts/analysis/` that runs each test in isolation under c8, extracts the set of `src/**` branches each test covers, and finds near-duplicate test pairs (one test's covered branches are a near-subset of another's). For each candidate, backfill the small residual into an existing unit seam (TDD), prove `branches(deleted) ⊆ branches(kept) ∪ branches(backfill)`, then delete. A global `test:coverage` branch% gate guards the whole pass.

**Tech Stack:** TypeScript (NodeNext), `node:test` via `tsx --test`, c8 v11 (istanbul JSON reporter, pinned devDependency), `node:child_process`, `node:crypto` (cache keys).

**Spec:** `docs/superpowers/specs/2026-06-18-e2e-dedup-coverage-diff-design.md`

---

## Conventions used throughout this plan

- Repo root: `c:\Users\denys\Documents\GitHub\SiftKit`. All commands run from there in **Git Bash** (the Bash tool), not PowerShell, unless noted.
- "Branch key" = the string `<relPath>|<branchId>|<pathIndex>` produced from istanbul `branchMap`/`b`. It identifies one taken edge of one branch in one `src/**` file. This is the unit of coverage we diff on.
- "Seam file" = an existing focused unit-test file that backfill lands in. Never create a new ad-hoc test file for a backfill; route by area:
  - repo-search engine residuals → `tests/engine-*.test.ts`
  - planner protocol / JSON-parse residuals → `tests/repo-search-planner-protocol.test.ts` or `tests/llm-protocol.test.ts`
  - status route residuals → `tests/routes-*.test.ts`
- **The harness is unshipped.** It lives in `scripts/analysis/`, is excluded from the `dist` build, and its own unit test lives at `scripts/analysis/coverage-attribution-core.test.ts` (NOT under `tests/`, so the default runner never includes it). Run it manually with `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`.
- Commit after every task. Branch is already `f6-f14-test-pyramid-typing`; stay on it.

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/analysis/coverage-attribution-core.ts` | **Pure** functions: istanbul parsing, test-name extraction, regex escaping, candidate detection, subset diff. No I/O, no spawning. |
| `scripts/analysis/coverage-isolation-runner.ts` | Side-effectful: run one test in isolation under c8 (spawn, drained stdio, exit-code + TAP-summary gating, on-disk cache), bounded-concurrency file attribution. |
| `scripts/analysis/coverage-attribution.ts` | CLI: attribute one in-scope file → write `.coverage-attr/report.<id>.json`, print candidates, exit nonzero on any failed isolation. |
| `scripts/analysis/coverage-verify-subset.ts` | CLI: per-deletion gate. Run deleted + covering tests in isolation, print missing branch keys, exit 2 if any missing. |
| `scripts/analysis/coverage-attribution-core.test.ts` | Unit tests for the core module. Not part of the default suite. |
| `tsconfig.analysis.json` | NodeNext, `noEmit`, includes `scripts/analysis/**/*.ts`. Wired into `npm run typecheck`. |
| `tsconfig.scripts.json` | **Modified** to exclude `scripts/analysis/**` so the harness is never built into `dist`/shipped. |
| `package.json` | **Modified**: add pinned `c8` devDependency; add `typecheck:analysis` script and chain it into `typecheck`. |
| `.gitignore` | Add `/.coverage-attr`. |

The 7 in-scope test files are then edited in place (deletions) with backfills landing in existing seam files.

---

## Task 1: Gitignore the analysis output

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the ignore entry**

Append to `.gitignore` (the repo already ignores `/coverage`):

```
/.coverage-attr
```

- [ ] **Step 2: Verify**

Run: `git check-ignore .coverage-attr/anything`
Expected: prints `.coverage-attr/anything`

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(test): ignore coverage-attribution output dir"
```

---

## Task 2: Pin c8 and wire the analysis typecheck project

c8 is not installed (`node_modules/c8` absent, no `package.json`/lock entry); the existing `test:coverage` script only worked via on-the-fly `npx` fetch. Pin it so `node_modules/c8/bin/c8.js` resolves deterministically, and set up the unshipped-analysis tsconfig.

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.scripts.json`
- Create: `tsconfig.analysis.json`

- [ ] **Step 1: Install and pin c8**

Run: `npm install --save-dev c8@^11.0.0`
Expected: `package.json` devDependencies gains `"c8": "^11.0.0"`, `package-lock.json` gains a `node_modules/c8` entry, and `node_modules/c8/bin/c8.js` exists.

- [ ] **Step 2: Verify the local binary resolves**

Run: `node node_modules/c8/bin/c8.js --version`
Expected: prints `11.x` (the installed version), proving the hardcoded path in the runner will work.

- [ ] **Step 3: Exclude the analysis dir from the shipped build**

Edit `tsconfig.scripts.json` — add `scripts/analysis/**` to `exclude` (which already lists `scripts/delete-logs.ts`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": [
    "scripts/**/*.ts"
  ],
  "exclude": [
    "scripts/delete-logs.ts",
    "scripts/analysis/**"
  ]
}
```

- [ ] **Step 4: Create the analysis typecheck project**

Create `tsconfig.analysis.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": [
    "scripts/analysis/**/*.ts"
  ]
}
```

- [ ] **Step 5: Wire it into `npm run typecheck`**

Edit `package.json` scripts: add a `typecheck:analysis` entry and append it to the `typecheck` chain.

```json
"typecheck": "tsc -p .\\tsconfig.json --noEmit && tsc -p .\\tsconfig.scripts.json --noEmit && tsc -p .\\dashboard\\tsconfig.json --noEmit && npm run typecheck:bench && npm run typecheck:test && npm run typecheck:dashboard-test && npm run typecheck:analysis",
"typecheck:analysis": "tsc -p .\\tsconfig.analysis.json --noEmit",
```

- [ ] **Step 6: Verify nothing breaks (analysis dir is empty so far — typecheck must still pass)**

Run: `npx tsc -p tsconfig.analysis.json --noEmit`
Expected: no errors (no files yet → trivially passes).
Run: `npx tsc -p tsconfig.scripts.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.scripts.json tsconfig.analysis.json
git commit -m "chore(test-tooling): pin c8 devDep; add unshipped analysis tsconfig"
```

---

## Task 3: Core module — istanbul branch extraction (TDD)

**Files:**
- Create: `scripts/analysis/coverage-attribution-core.ts`
- Test: `scripts/analysis/coverage-attribution-core.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/analysis/coverage-attribution-core.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCoveredBranchKeys,
  type CoverageFinal,
} from './coverage-attribution-core.js';

test('collectCoveredBranchKeys keeps only taken edges of src files, normalized to posix relpaths', () => {
  const repoRoot = process.cwd();
  const srcPath = `${repoRoot}\\src\\foo\\bar.ts`.replace(/\\/g, '/');
  const nodeModulesPath = `${repoRoot}/node_modules/x/y.ts`;
  const coverage: CoverageFinal = {
    [srcPath]: {
      path: srcPath,
      branchMap: { '0': { line: 1, type: 'if' }, '1': { line: 2, type: 'if' } },
      b: { '0': [3, 0], '1': [0, 0] },
      statementMap: {},
      s: {},
    },
    [nodeModulesPath]: {
      path: nodeModulesPath,
      branchMap: { '0': { line: 9, type: 'if' } },
      b: { '0': [5, 5] },
      statementMap: {},
      s: {},
    },
  };

  const keys = collectCoveredBranchKeys(coverage, repoRoot);

  assert.deepEqual(
    [...keys].sort(),
    ['src/foo/bar.ts|0|0'],
    'only the taken edge (count>0) of the src file survives; node_modules excluded',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: FAIL — cannot find module `./coverage-attribution-core.js`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/analysis/coverage-attribution-core.ts`:

```ts
import * as path from 'node:path';

export interface IstanbulBranch {
  line: number;
  type: string;
}

export interface IstanbulFileCoverage {
  path: string;
  branchMap: Record<string, IstanbulBranch>;
  b: Record<string, number[]>;
  statementMap: Record<string, unknown>;
  s: Record<string, number>;
}

export type CoverageFinal = Record<string, IstanbulFileCoverage>;

export function collectCoveredBranchKeys(coverage: CoverageFinal, repoRoot: string): Set<string> {
  const keys = new Set<string>();
  for (const fileCoverage of Object.values(coverage)) {
    const relPath = path.relative(repoRoot, fileCoverage.path).replace(/\\/g, '/');
    if (!relPath.startsWith('src/')) {
      continue;
    }
    for (const [branchId, counts] of Object.entries(fileCoverage.b)) {
      for (let pathIndex = 0; pathIndex < counts.length; pathIndex++) {
        if (counts[pathIndex] > 0) {
          keys.add(`${relPath}|${branchId}|${pathIndex}`);
        }
      }
    }
  }
  return keys;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/coverage-attribution-core.ts scripts/analysis/coverage-attribution-core.test.ts
git commit -m "feat(test-tooling): istanbul branch-key extraction core"
```

---

## Task 4: Core module — test-name extraction and pattern escaping (TDD)

**Files:**
- Modify: `scripts/analysis/coverage-attribution-core.ts`
- Test: `scripts/analysis/coverage-attribution-core.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/analysis/coverage-attribution-core.test.ts`:

```ts
import {
  extractTestNames,
  escapeForNamePattern,
} from './coverage-attribution-core.js';

test('extractTestNames pulls literal names from test()/it() with options arg and mixed quotes', () => {
  const source = [
    `test('plain name', async () => {});`,
    `test("double quoted", () => {});`,
    `test('with "inner" double quotes', () => {});`,
    `test('with timeout opts', { timeout: 5000 }, async () => {});`,
    `  it('indented it block', () => {});`,
    `notTest('should be ignored');`,
  ].join('\n');

  assert.deepEqual(extractTestNames(source), [
    'plain name',
    'double quoted',
    'with "inner" double quotes',
    'with timeout opts',
    'indented it block',
  ]);
});

test('escapeForNamePattern anchors and escapes regex metacharacters', () => {
  assert.equal(
    escapeForNamePattern('finish (a) needs 90% of remaining + 1'),
    '^finish \\(a\\) needs 90% of remaining \\+ 1$',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: FAIL — `extractTestNames`/`escapeForNamePattern` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/analysis/coverage-attribution-core.ts`:

```ts
export function extractTestNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    names.push(match[2].replace(/\\(['"`\\])/g, '$1'));
    match = pattern.exec(source);
  }
  return names;
}

export function escapeForNamePattern(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/coverage-attribution-core.ts scripts/analysis/coverage-attribution-core.test.ts
git commit -m "feat(test-tooling): test-name extraction and pattern escaping"
```

---

## Task 5: Core module — candidate detection and subset diff (TDD)

**Files:**
- Modify: `scripts/analysis/coverage-attribution-core.ts`
- Test: `scripts/analysis/coverage-attribution-core.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/analysis/coverage-attribution-core.test.ts`:

```ts
import {
  buildCandidates,
  missingBranchKeys,
  type TestBranchSet,
} from './coverage-attribution-core.js';

test('buildCandidates flags A when A\\B is within threshold and reports residual keys', () => {
  const tests: TestBranchSet[] = [
    { index: 0, name: 'broad E2E', branchKeys: ['f|0|0', 'f|1|0', 'f|2|0', 'f|3|0'] },
    { index: 1, name: 'narrow near-dup', branchKeys: ['f|0|0', 'f|1|0', 'f|9|0'] },
    { index: 2, name: 'unrelated', branchKeys: ['g|0|0'] },
  ];

  const candidates = buildCandidates(tests, 1);

  // narrow (index 1) has exactly one branch (f|9|0) not in broad (index 0): residual 1 <= threshold.
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    deleteIndex: 1,
    deleteName: 'narrow near-dup',
    keepIndex: 0,
    keepName: 'broad E2E',
    residualCount: 1,
    residualKeys: ['f|9|0'],
  });
});

test('buildCandidates ignores empty-coverage tests and self-pairs', () => {
  const tests: TestBranchSet[] = [
    { index: 0, name: 'empty', branchKeys: [] },
    { index: 1, name: 'covers', branchKeys: ['f|0|0'] },
  ];
  assert.deepEqual(buildCandidates(tests, 8), []);
});

test('missingBranchKeys returns deleted keys not covered by the union', () => {
  const deleted = ['a|0|0', 'a|1|0', 'a|2|0'];
  const covering = [['a|0|0'], ['a|2|0']];
  assert.deepEqual(missingBranchKeys(deleted, covering), ['a|1|0']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: FAIL — `buildCandidates`/`missingBranchKeys`/`TestBranchSet` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/analysis/coverage-attribution-core.ts`:

```ts
export interface TestBranchSet {
  index: number;
  name: string;
  branchKeys: string[];
}

export interface DeletionCandidate {
  deleteIndex: number;
  deleteName: string;
  keepIndex: number;
  keepName: string;
  residualCount: number;
  residualKeys: string[];
}

export function buildCandidates(tests: TestBranchSet[], threshold: number): DeletionCandidate[] {
  const sets = tests.map((entry) => new Set(entry.branchKeys));
  const candidates: DeletionCandidate[] = [];
  for (let a = 0; a < tests.length; a++) {
    if (sets[a].size === 0) {
      continue;
    }
    for (let b = 0; b < tests.length; b++) {
      if (a === b || sets[b].size === 0) {
        continue;
      }
      const residualKeys: string[] = [];
      for (const key of sets[a]) {
        if (!sets[b].has(key)) {
          residualKeys.push(key);
        }
      }
      if (residualKeys.length <= threshold) {
        candidates.push({
          deleteIndex: a,
          deleteName: tests[a].name,
          keepIndex: b,
          keepName: tests[b].name,
          residualCount: residualKeys.length,
          residualKeys,
        });
      }
    }
  }
  candidates.sort((left, right) => left.residualCount - right.residualCount);
  return candidates;
}

export function missingBranchKeys(deletedKeys: string[], coveringSets: string[][]): string[] {
  const union = new Set<string>();
  for (const set of coveringSets) {
    for (const key of set) {
      union.add(key);
    }
  }
  return deletedKeys.filter((key) => !union.has(key));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/coverage-attribution-core.ts scripts/analysis/coverage-attribution-core.test.ts
git commit -m "feat(test-tooling): near-duplicate candidate detection and subset diff"
```

---

## Task 6: Isolation runner — drained stdio, exit-code gating, TAP-summary check, on-disk cache

**Files:**
- Create: `scripts/analysis/coverage-isolation-runner.ts`

This module spawns processes, so it is verified by running it against a real file in Task 7 rather than a unit test. It must (a) drain child stdio to avoid pipe-buffer deadlock on noisy E2E, (b) treat a nonzero exit code, a TAP `fail > 0`, a TAP `tests 0` (no name match), or a missing `coverage-final.json` as a **failed** isolation (`ok: false`), and (c) cache per-test results keyed by test-file hash + test name + tool versions so unchanged tests are not re-run.

- [ ] **Step 1: Write the implementation**

Create `scripts/analysis/coverage-isolation-runner.ts`:

```ts
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  collectCoveredBranchKeys,
  escapeForNamePattern,
  type CoverageFinal,
  type TestBranchSet,
} from './coverage-attribution-core.js';

const repoRoot = process.cwd();
const tsxCli = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const c8Cli = path.resolve(repoRoot, 'node_modules', 'c8', 'bin', 'c8.js');
const cacheDir = path.join(repoRoot, '.coverage-attr', 'cache');

function readToolVersions(): string {
  const c8Pkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'node_modules', 'c8', 'package.json'), 'utf8')) as { version: string };
  const tsxPkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'node_modules', 'tsx', 'package.json'), 'utf8')) as { version: string };
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
  return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as IsolationResult;
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
      const coverage = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as CoverageFinal;
      const result: IsolationResult = { index, name, branchKeys: [...collectCoveredBranchKeys(coverage, repoRoot)], ok: true, exitCode: 0 };
      writeCache(key, result);
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.analysis.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/analysis/coverage-isolation-runner.ts
git commit -m "feat(test-tooling): per-test c8 isolation runner (exit-gated, cached)"
```

---

## Task 7: Attribution CLI + first real run (pilot: runtime-summarize)

**Files:**
- Create: `scripts/analysis/coverage-attribution.ts`

`runtime-summarize.test.ts` (1048 lines, smallest in-scope — re-verify with `wc -l` at execution) is the pilot: it exercises the CLI end-to-end and calibrates the threshold on real data.

- [ ] **Step 1: Write the CLI**

Create `scripts/analysis/coverage-attribution.ts`:

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.analysis.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the pilot attribution**

Run: `npx tsx scripts/analysis/coverage-attribution.ts tests/runtime-summarize.test.ts --concurrency 4`
Expected: per-test progress on stderr; then `report: .../report.runtime-summarize.json` and a candidate list. **The CLI exits nonzero if any isolation failed** — if it does, open the named `run.log`, fix the cause (most often `extractTestNames` missing a name shape, e.g. a templated name → exit with `tests 0`), add a core unit test for the fix, and re-run. Do not proceed past a failing pilot.

- [ ] **Step 4: Calibrate the threshold**

Open `.coverage-attr/report.runtime-summarize.json`. Confirm every test has `ok: true` and a nonzero `branchCount`. Inspect candidate `residualKeys`. If nearly every pair is a candidate, the threshold is too loose → **lower** `--threshold`; if obviously-similar pairs are missed, **raise** it. Record the chosen value in the per-file commit message. Default 8 per the spec.

- [ ] **Step 5: Commit the CLI (no test deletions yet)**

```bash
git add scripts/analysis/coverage-attribution.ts
git commit -m "feat(test-tooling): attribution CLI; pilot run on runtime-summarize"
```

---

## Task 8: Verify-subset CLI (the per-deletion gate)

**Files:**
- Create: `scripts/analysis/coverage-verify-subset.ts`

This is the hard gate run before every deletion: it proves the deleted test's branches are covered by the kept E2E plus any backfill.

- [ ] **Step 1: Write the CLI**

Create `scripts/analysis/coverage-verify-subset.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.analysis.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test against two real tests**

Pick two distinct test names from `tests/runtime-summarize.test.ts` (call them NAME_X, NAME_Y).

Self-cover (must pass): `npx tsx scripts/analysis/coverage-verify-subset.ts --deleted "tests/runtime-summarize.test.ts::NAME_X" --cover "tests/runtime-summarize.test.ts::NAME_X"`
Expected: `MISSING: 0`, exit 0.

Insufficient cover (must fail): same command but `--cover` = NAME_Y.
Expected: nonzero `MISSING`, exit 2 — proving the gate fails when coverage is insufficient.

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/coverage-verify-subset.ts
git commit -m "feat(test-tooling): per-deletion subset-coverage verify gate"
```

---

## Task 9: Capture the global coverage baseline

**Files:** none (records numbers used by every later task)

- [ ] **Step 1: Run full coverage**

Run: `npm run test:coverage 2>&1 | tail -40`
Expected: the c8 `text-summary` block with `Branches : <N>%`.

- [ ] **Step 2: Record the baseline**

Note exact `Branches`, `Lines`, `Functions`, `Statements` percentages into `.coverage-attr/BASELINE.txt` (gitignored). Every per-file task's final gate: post-pass `Branches %` ≥ this baseline.

- [ ] **Step 3: No commit** (analysis only).

---

## Per-File Dedup Procedure

Tasks 10–16 each apply this exact procedure to one in-scope file. `<FILE>` is the file's path; `<ID>` is its basename without `.test.ts`.

1. **Attribute the file:**
   `npx tsx scripts/analysis/coverage-attribution.ts <FILE> --concurrency 4`
   The CLI exits nonzero if any isolation failed — resolve before continuing. Then open `.coverage-attr/report.<ID>.json`.

2. **Triage candidates.** For each `DELETE A <= KEEP B` candidate, open both tests and the candidate's `residualKeys`. Accept the deletion **only if** the residual is **unit-coverable** — pure behavior (parsing, normalization, classification, budget math) reachable without live server/sqlite state. If a residual branch is only reachable through live server state, **reject** (keep both). Record rejected candidates and why.

3. **Per accepted candidate (TDD backfill → verify → delete):**
   a. Identify the seam file for the residual by area (see Conventions). Read the residual `src/**` lines.
   b. **Write a failing focused unit test** in the seam file exercising exactly the residual branches:
      `npx tsx --test --test-name-pattern="^<new test name>$" tests/<seam>.test.ts` → expect FAIL.
   c. **Make it pass** (production code already exists; the test calls it directly). Re-run → expect PASS.
   d. **Run the subset gate:**
      `npx tsx scripts/analysis/coverage-verify-subset.ts --deleted "<FILE>::<A name>" --cover "<FILE>::<B name>" --cover "tests/<seam>.test.ts::<new test name>"`
      Expect `MISSING: 0`, exit 0. If MISSING > 0, the backfill is incomplete — extend it (back to step b) until zero. **No deletion while MISSING > 0.**
   e. **Delete test A** from `<FILE>` (remove the whole `test('A', …)` block).
   f. Commit:
      `git add <FILE> tests/<seam>.test.ts && git commit -m "test(<ID>): dedup '<A>' into <seam> seam (coverage-verified)"`

4. **Re-attribute and re-run the file** after all accepted deletions:
   `npx tsx scripts/analysis/coverage-attribution.ts <FILE>` (sanity) and `npm run test -- <FILE>` (green).

5. **Global gate:** `npm run test:coverage 2>&1 | tail -40` → `Branches %` ≥ baseline. If it dropped, a residual was missed — restore the last deleted test, widen its backfill, repeat.

> If a file yields **zero** unit-coverable candidates, that is a valid outcome: record "no safe dedup" and move on. The goal is safe trimming, not a deletion quota.

---

## Task 10: Dedup `tests/runtime-summarize.test.ts` (`<ID>` = runtime-summarize)

**Files:**
- Modify: `tests/runtime-summarize.test.ts`
- Modify (backfill): seam files per the residual's area (e.g. `tests/summary-*.test.ts`, `tests/llm-protocol.test.ts`).

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/runtime-summarize.test.ts`. Attribution was already run in Task 7 — re-run if the file changed since.
- [ ] **Step 2:** Confirm `npm run test -- tests/runtime-summarize.test.ts` is green.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.
- [ ] **Step 4:** Each accepted deletion is its own commit (per the procedure). If zero safe candidates, commit nothing and note it.

---

## Task 11: Dedup `tests/runtime-status-server.test.ts` (`<ID>` = runtime-status-server)

**Files:**
- Modify: `tests/runtime-status-server.test.ts`
- Modify (backfill): primarily `tests/routes-*.test.ts`, `tests/status-route-table.test.ts`, `tests/runtime-metrics-aggregation.test.ts`.

**File-specific note:** Flakiness hotspot (managed-llama startup/idle, metrics aggregation). When a candidate's residual is deterministic logic (metrics math, status normalization), prefer moving it to a seam and deleting the flaky E2E. When the residual is only the managed-llama timing path, keep one hardened E2E and delete redundant siblings.

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/runtime-status-server.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/runtime-status-server.test.ts` is green across 3 consecutive runs (flakiness check).
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 12: Dedup `tests/repo-search-status-server.test.ts` (`<ID>` = repo-search-status-server)

**Files:**
- Modify: `tests/repo-search-status-server.test.ts`
- Modify (backfill): `tests/routes-core-lease.test.ts`, `tests/engine-*.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/model-request-queue.test.ts`.

**File-specific note:** Contains queue-timeout window assertions (the ~30ms flake class). A residual that is queue-diagnostics shape or command-logging formatting is unit-coverable; the live queue-serialization timing path is not — keep one E2E for it.

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/repo-search-status-server.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/repo-search-status-server.test.ts` is green across 3 consecutive runs.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 13: Dedup `tests/runtime-planner-mode.test.ts` (`<ID>` = runtime-planner-mode)

**Files:**
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify (backfill): `tests/engine-*.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/summary-planner-runtime.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/runtime-planner-mode.tools.test.ts`.

**File-specific note:** Many cases assert pure planner behavior (json_filter bounds, read_lines compaction, oversized-output fitting) mapping directly onto engine seams — a rich source of unit-coverable residuals.

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/runtime-planner-mode.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/runtime-planner-mode.test.ts` is green.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 14: Dedup `tests/repo-search-loop.core.test.ts` (`<ID>` = repo-search-loop.core)

**Files:**
- Modify: `tests/repo-search-loop.core.test.ts`
- Modify (backfill): `tests/engine-*.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/repo-search.test.ts`.

**File-specific note:** Already contains many **pure-function** tests (`ModelJson` parsing, `normalizePlannerCommand`, `classifySearchExit`, `parseDirectRgCommand`, `evaluateCommandSafety`, `getDynamicMaxOutputTokens`, `retryProviderRequest`) interleaved with a few server-booting cases. Those pure tests are already unit-level — not deletion candidates against each other unless attribution shows true branch redundancy. Focus deletions on server-booting cases whose branches a kept E2E already covers; leave the pure tests in place (relocating them is out of scope — no aesthetic moves).

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/repo-search-loop.core.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/repo-search-loop.core.test.ts` is green.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 15: Dedup `tests/mock-repo-search-loop.test.ts` (`<ID>` = mock-repo-search-loop)

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts`
- Modify (backfill): `tests/engine-*.test.ts` (read-window-governor, read-overlap, tool-result-budgeter, prompt-preparer), prompt-budget seams.

**File-specific note:** `runTaskLoop` integration tests against a mock HTTP provider — many assert oversized-output fitting, repo_read_file unread-span advancement, and compaction, all with engine seams. Strong source of unit-coverable residuals. Mock-server cases differing only in input shape from a kept case are prime candidates.

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/mock-repo-search-loop.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/mock-repo-search-loop.test.ts` is green.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 16: Dedup `tests/dashboard-status-server.test.ts` (`<ID>` = dashboard-status-server)

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`
- Modify (backfill): `tests/routes-dashboard-metrics.test.ts`, `tests/dashboard-http-helpers.test.ts`, `tests/routes-chat-helpers.test.ts`, `tests/web-search-usage.test.ts`, `tests/status-server-chat.test.ts`.

**File-specific note:** Largest suite; boots real HTTP + sqlite + tokenizer stub. Several cases differ only by web-on/web-off or by which dashboard endpoint they hit while traversing the same `src/**` branches — prime near-duplicates. `normalizeWebSearchConfig` cases at the top are already pure unit tests; leave them.

- [ ] **Step 1:** Apply the Per-File Dedup Procedure with `<FILE>` = `tests/dashboard-status-server.test.ts`.
- [ ] **Step 2:** Confirm `npm run test -- tests/dashboard-status-server.test.ts` is green.
- [ ] **Step 3:** Confirm global `Branches %` ≥ baseline.

---

## Task 17: Final verification and wrap-up

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (prune the resolved part of F14)

- [ ] **Step 1: Harness self-tests green**

Run: `npx tsx --test scripts/analysis/coverage-attribution-core.test.ts`
Expected: all core tests pass (these are not in the default suite, so run them explicitly).

- [ ] **Step 2: Full suite green**

Run: `npm run test 2>&1 | tail -20`
Expected: all tests pass (typecheck:test + build:test + run-tests). Confirm the harness self-test was NOT picked up (it lives outside `tests/`).

- [ ] **Step 3: Global coverage gate + size delta**

Run: `npm run test:coverage 2>&1 | tail -40`
Expected: `Branches %` ≥ the Task 9 baseline.
Run: `wc -l tests/dashboard-status-server.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/runtime-planner-mode.test.ts tests/repo-search-status-server.test.ts tests/runtime-status-server.test.ts tests/runtime-summarize.test.ts`
Record the before/after line delta.

- [ ] **Step 4: Typecheck everything (including analysis project + new seam tests)**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: no errors. Confirms `typecheck:analysis` runs and the harness + new seam tests typecheck.

- [ ] **Step 5: Confirm the harness is unshipped**

Run: `npm run build 2>&1 | tail -5 && ls dist/scripts/analysis 2>/dev/null && echo "LEAKED INTO DIST" || echo "not shipped (good)"`
Expected: `not shipped (good)` — `scripts/analysis/**` must not appear under `dist`.

- [ ] **Step 6: Prune F14 in the architecture review**

Edit `ARCHITECTURE-REVIEW.md`: update the F14 bullet about giant E2E suites not being rebalanced to reflect that redundant E2E in the 7 suites were removed with coverage-verified backfills. Leave genuinely-unaddressed F14 sub-points intact. Remove item 1 from the Priority order if fully addressed.

- [ ] **Step 7: Commit**

```bash
git add ARCHITECTURE-REVIEW.md
git commit -m "docs(architecture): F14 E2E dedup landed via coverage-diff; prune resolved item"
```

---

## Self-review notes

- **Spec coverage:** c8 pinning + unshipped harness (Tasks 2, 17 step 5) = spec §"Attribution harness"; core (Tasks 3–5) + isolation runner with exit/TAP gating + cache (Task 6) = spec §"Attribution harness" + §"Risks" (caching); threshold/criterion (Task 7 step 4, procedure step 2) = spec §"Near-duplicate criterion"; seam routing (Conventions, per-file notes) = spec §"Seam targets"; flakiness (Tasks 11–12 notes) = spec §"Flakiness"; per-deletion + global gates (Tasks 8, 9, procedure 3d/5) = spec §"Verification". All covered.
- **Review fixes applied:** c8 pinned before first use (Task 2); runner gates on exit code + TAP `tests>=1`/`fail==0` + coverage presence, drains stdio, writes `run.log` (Task 6); harness + its test live under `scripts/analysis/`, excluded from default runner and from `dist` (Tasks 2, 3, 17 step 5); per-test cache keyed by file-hash + name + tool versions (Task 6); attribution CLI exits nonzero on any failed isolation (Task 7); spec threshold wording corrected.
- **Line counts:** verified `1048` for runtime-summarize via `wc -l` on a clean tree; the "974" figure did not reproduce. Re-verify note added.
- **No deletion quota:** procedure explicitly allows "zero safe candidates" per file.
- **Frozen `src/**`:** plan never edits production code; backfill tests call existing functions directly.
- **Type consistency:** `IsolationResult` (extends `TestBranchSet`, adds `ok`/`exitCode`), `DeletionCandidate`, `TestBranchSet`, `CoverageFinal` names are used consistently across runner/CLI/core; `runOneTestInIsolation`/`attributeFile`/`buildCandidates`/`missingBranchKeys`/`collectCoveredBranchKeys`/`extractTestNames`/`escapeForNamePattern` signatures match between definition and call sites.
