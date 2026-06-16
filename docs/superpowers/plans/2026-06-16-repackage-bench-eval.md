# Repackage bench/eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping dev/benchmark harnesses to npm consumers and remove the standalone benchmark + repro harnesses from the build graph, while leaving the server/dashboard-wired `eval.ts` and `benchmark-matrix/` untouched (F2 + the shippable half of F15).

**Architecture:** Two independent outcomes. (A) Correct the npm `files` whitelist so the tarball ships only runtime (`bin`, `SiftKit`, `dist`, `scripts/postinstall.js`, `README.md`, `docs`) — dropping the untracked `eval/` dir and the broad `scripts/` dev tree. (B) Relocate the genuinely-standalone harness code (`src/benchmark/` and the three repro scripts) into a new top-level `bench/` directory that is excluded from the TS build, the package, and the test runner; it gets its own `tsconfig.bench.json` so it stays type-checked. The benchmark/repro *integration tests* are welded to the 1573-line `tests/_runtime-helpers.ts` harness, so they STAY in `tests/`; only their import paths repoint from `dist/...` to the `bench/` source (run via tsx). `eval.ts` (server engine) and `benchmark-matrix/` (dashboard) remain in `src/`.

**Tech Stack:** TypeScript (NodeNext), `tsx` test/dev runner, Node `node:test`, npm `files` packaging.

---

## Boundary facts (verified against working tree, 2026-06-16)

- Importers of `src/benchmark/`: `package.json` script `benchmark` (`src\benchmark\index.ts`); `tests/_runtime-helpers.ts:50` (`../dist/benchmark/index.js`, re-exported at `:1660`); `tests/runtime-benchmark.test.ts:14` (`require('../dist/benchmark/index.js')`). No `src/` module imports `src/benchmark/`. `benchmark-matrix/` has its own runner and does NOT reference `src/benchmark`.
- `src/benchmark/*` cross-boundary imports into core (these become `../../src/...` after the move):
  - `types.ts:1` `../config/index.js`; `types.ts:2` `../summary/types.js`
  - `interrupt.ts:1` `../lib/time.js`
  - `args.ts:3` `../config/index.js`; `args.ts:4` `../summary/prompt.js`; `args.ts:5` `../lib/time.js`
  - `runner.ts:3` `../config/index.js`; `runner.ts:4` `../lib/json-types.js`; `runner.ts:5` `../summary/core.js`; `runner.ts:6` `../lib/time.js`; `runner.ts:29` `../state/runtime-artifacts.js`; `runner.ts:30` `../state/runtime-results.js`
  - `index.ts`, `fixtures.ts`, `report.ts`, and the `./types.js`/`./runner.js`/`./args.js`/`./interrupt.js`/`./fixtures.js`/`./report.js` specifiers are internal — unchanged.
- Repro scripts (moving to `bench/repro/`) and their `__dirname`-relative depth assumptions (currently 1 level below repo root in `scripts/`; become 2 levels in `bench/repro/`):
  - `scripts/repro-fixture60-malformed-json.ts:6` `path.resolve(__dirname, '..', 'dist')`; `:8` `path.resolve(__dirname, '..')`; `:238` `path.resolve(__dirname, '..')`
  - `scripts/run-benchmark-fixture-debug.ts:9` `path.resolve(__dirname, '..', 'dist', 'summary.js')`; `:10` `path.resolve(__dirname, '..', '..', 'dist', 'summary.js')`; `:198` `path.resolve(__dirname, '..')`; `:36` `path.join(process.cwd(), 'eval', ...)` (cwd-relative — unchanged)
  - `scripts/repro-repo-search-pipe-from.ts:43-47` `runningFromDist` dist-detection + `path.resolve(__dirname, '..', 'src')` source branch; `:49` `require(path.join(base, 'repo-search', 'command-safety.js'))`
- Repro-script importers/readers: `tests/_runtime-helpers.ts:75` (`run-benchmark-fixture-debug`), `:76` (`repro-fixture60-malformed-json`); `tests/runtime-benchmark.test.ts:17` (`run-benchmark-fixture-debug`); `tests/runtime-benchmark.repro-{range,malformed,valid}.test.ts` consume `runFixture60MalformedJsonRepro` via the `tests/_runtime-helpers.ts` barrel re-export; `tests/repo-search-pipe-from-repro.test.ts:7,34` read `scripts/repro-repo-search-pipe-from.ts` via `fs.readFileSync`.
- `scripts/postinstall.js` is self-contained (`node:fs`, `node:path` only) and is required by the `postinstall` hook (`package.json:30`).
- `git ls-files eval` is empty: the `eval` entry in `files` packs whatever untracked content happens to be on disk.

## File structure

- Create: `bench/benchmark/` (moved from `src/benchmark/`, 11 files)
- Create: `bench/repro/repro-fixture60-malformed-json.ts`, `bench/repro/run-benchmark-fixture-debug.ts`, `bench/repro/repro-repo-search-pipe-from.ts` (moved from `scripts/`)
- Create: `tsconfig.bench.json`
- Create: `tests/package-files.test.ts` (packaging regression guard)
- Modify: `package.json` (`files`, `benchmark` script, `typecheck`/`typecheck:bench` scripts)
- Modify: `tests/_runtime-helpers.ts` (lines 50, 75, 76 import paths)
- Modify: `tests/runtime-benchmark.test.ts` (lines 14, 17 require paths)
- Modify: `tests/repo-search-pipe-from-repro.test.ts` (lines 7, 34 script path)
- Modify: `tsconfig.test.json` (add `tests/package-files.test.ts` to include)

**Out of scope (residual — belongs to later priorities):** `src/eval.ts`, `src/benchmark-matrix/`, `src/benchmark-spec-settings.ts` (server/dashboard-wired or test-only-with-dashboard-types); trimming general compiled dev scripts (`dist/scripts/start-dev*`, etc.) from the shipped `dist`; the `test-full.ts` phantom include in `tsconfig.json:18` (priority-2 dead-code sweep); typing/rebalancing the `@ts-nocheck` runtime harness (priority-3).

---

### Task 1: Fix the npm `files` array (F2)

**Files:**
- Create: `tests/package-files.test.ts`
- Modify: `package.json:42-50` (`files` array)
- Modify: `tsconfig.test.json:4-32` (add the new test to `include`)

- [ ] **Step 1: Write the failing packaging guard test**

Create `tests/package-files.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PackageManifest {
  files: string[];
  scripts: Record<string, string>;
}

function readManifest(): PackageManifest {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

test('package files whitelist ships only runtime, not dev harnesses', () => {
  const { files } = readManifest();
  assert.ok(!files.includes('eval'), 'eval dir (untracked dev fixtures) must not be packed');
  assert.ok(!files.includes('scripts'), 'broad scripts/ dev tree must not be packed');
  assert.ok(files.includes('scripts/postinstall.js'), 'postinstall hook script must be packed');
  for (const required of ['bin', 'SiftKit', 'dist', 'README.md', 'docs']) {
    assert.ok(files.includes(required), `${required} must be packed`);
  }
});

test('postinstall hook references the packed postinstall script', () => {
  const { scripts } = readManifest();
  assert.equal(scripts.postinstall, 'node scripts/postinstall.js');
});
```

- [ ] **Step 2: Register the test for typechecking**

In `tsconfig.test.json`, add `"tests/package-files.test.ts"` to the `include` array (after `"tests/status-route-table.test.ts"`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `node .\dist\scripts\run-tests.js package-files` (run `npm run build:test` first if `dist/scripts/run-tests.js` is stale)
Expected: FAIL — first assertion trips because `files` still contains `eval` and `scripts`.

- [ ] **Step 4: Fix the `files` array**

In `package.json`, replace the `files` array:

```json
  "files": [
    "bin",
    "SiftKit",
    "dist",
    "scripts/postinstall.js",
    "README.md",
    "docs"
  ],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node .\dist\scripts\run-tests.js package-files`
Expected: PASS (both tests).

- [ ] **Step 6: Confirm the tarball contents**

Run: `npm pack --dry-run`
Expected: file list includes `bin/`, `SiftKit/`, `dist/`, `scripts/postinstall.js`, `README.md`, `docs/`; EXCLUDES any `eval/` entry and any `scripts/` entry other than `scripts/postinstall.js`.

- [ ] **Step 7: Run the typecheck for tests**

Run: `npm run typecheck:test`
Expected: PASS (the new typed test compiles clean).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.test.json tests/package-files.test.ts
git commit -m "fix(pkg): drop eval/ and scripts/ from npm files whitelist (F2)"
```

---

### Task 2: Relocate `src/benchmark/` to `bench/benchmark/`

**Files:**
- Move: `src/benchmark/**` → `bench/benchmark/**` (git mv)
- Modify (in moved copies): `bench/benchmark/types.ts`, `interrupt.ts`, `args.ts`, `runner.ts` (cross-boundary import depth)
- Create: `tsconfig.bench.json`
- Modify: `package.json` (`benchmark` script + `typecheck`/`typecheck:bench`)
- Modify: `tests/_runtime-helpers.ts:50`
- Modify: `tests/runtime-benchmark.test.ts:14`

- [ ] **Step 1: Move the directory preserving history**

```bash
git mv src/benchmark bench/benchmark
```

- [ ] **Step 2: Fix cross-boundary imports in the moved files**

Apply these exact `../` → `../../src/` rewrites (internal `./...` specifiers stay unchanged):

`bench/benchmark/types.ts`:
```ts
import type { RuntimeLlamaCppConfig } from '../../src/config/index.js';
import type { SummaryClassification, SummaryRequest } from '../../src/summary/types.js';
```

`bench/benchmark/interrupt.ts` (line 1 only):
```ts
import { formatElapsed } from '../../src/lib/time.js';
```

`bench/benchmark/args.ts` (lines 3-5):
```ts
import { initializeRuntime } from '../../src/config/index.js';
import { buildPrompt } from '../../src/summary/prompt.js';
import { getLocalTimestamp } from '../../src/lib/time.js';
```

`bench/benchmark/runner.ts` (lines 3-6 and 29-30):
```ts
import { getConfiguredModel, loadConfig } from '../../src/config/index.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { summarizeRequest } from '../../src/summary/core.js';
import { formatElapsed } from '../../src/lib/time.js';
```
```ts
import { upsertRuntimeJsonArtifact } from '../../src/state/runtime-artifacts.js';
import { persistBenchmarkRun } from '../../src/state/runtime-results.js';
```

- [ ] **Step 3: Create `tsconfig.bench.json`**

Create `tsconfig.bench.json` at repo root:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": [
    "bench/**/*.ts"
  ]
}
```

- [ ] **Step 4: Wire the bench typecheck and update the benchmark script**

In `package.json`, change the `benchmark` script and add `typecheck:bench`, then chain it into `typecheck`:

```json
    "benchmark": "tsx .\\bench\\benchmark\\index.ts",
```
```json
    "typecheck": "tsc -p .\\tsconfig.json --noEmit && tsc -p .\\tsconfig.scripts.json --noEmit && tsc -p .\\dashboard\\tsconfig.json --noEmit && npm run typecheck:bench && npm run typecheck:test",
    "typecheck:bench": "tsc -p .\\tsconfig.bench.json --noEmit",
```

- [ ] **Step 5: Repoint the benchmark importers**

`tests/_runtime-helpers.ts:50`:
```ts
import { runBenchmarkSuite } from '../bench/benchmark/index.ts';
```

`tests/runtime-benchmark.test.ts:14`:
```ts
const { runBenchmarkSuite } = require('../bench/benchmark/index.ts');
```

(The `.ts` specifier is resolved by tsx at runtime; both files are `@ts-nocheck`, so no tsc impact. The `../dist/benchmark-matrix/index.js` import at `_runtime-helpers.ts:51-59` stays — `benchmark-matrix` is not moving.)

- [ ] **Step 6: Verify the bench source type-checks**

Run: `npm run typecheck:bench`
Expected: PASS (bench files resolve `../../src/...` against the real source).

- [ ] **Step 7: Verify the product build no longer emits `dist/benchmark`**

Run: `npm run build`
Then: `node -e "process.exit(require('node:fs').existsSync('dist/benchmark') ? 1 : 0)"`
Expected: build succeeds; the node check exits 0 (no `dist/benchmark` directory).

- [ ] **Step 8: Verify the benchmark integration test still runs against the moved source**

Run: `npm run build:test` then `node .\dist\scripts\run-tests.js runtime-benchmark.test.ts`
Expected: PASS — `require('../bench/benchmark/index.ts')` loads via tsx. (If tsx fails to resolve the explicit `.ts` in `require`, the documented fallback is to keep the path but switch the specifier to `'../bench/benchmark/index.js'`, which tsx maps to the `.ts` source; re-run to confirm.)

- [ ] **Step 9: Commit**

```bash
git add bench/benchmark tsconfig.bench.json package.json tests/_runtime-helpers.ts tests/runtime-benchmark.test.ts
git commit -m "refactor(bench): move src/benchmark to non-shipped bench/ (F15)"
```

---

### Task 3: Relocate the repro scripts to `bench/repro/`

**Files:**
- Move: `scripts/repro-fixture60-malformed-json.ts`, `scripts/run-benchmark-fixture-debug.ts`, `scripts/repro-repo-search-pipe-from.ts` → `bench/repro/` (git mv)
- Modify (in moved copies): `__dirname`-relative depth fixes
- Modify: `tests/_runtime-helpers.ts:75-76`
- Modify: `tests/runtime-benchmark.test.ts:17`
- Modify: `tests/repo-search-pipe-from-repro.test.ts:7,34`

- [ ] **Step 1: Move the three scripts preserving history**

```bash
git mv scripts/repro-fixture60-malformed-json.ts bench/repro/repro-fixture60-malformed-json.ts
git mv scripts/run-benchmark-fixture-debug.ts bench/repro/run-benchmark-fixture-debug.ts
git mv scripts/repro-repo-search-pipe-from.ts bench/repro/repro-repo-search-pipe-from.ts
```

- [ ] **Step 2: Fix `__dirname` depth in `repro-fixture60-malformed-json.ts`**

`bench/repro/repro-fixture60-malformed-json.ts` — these scripts now sit two levels below repo root, so each `'..'` that targeted the repo root gains one more `'..'`:

Line 6:
```ts
const distRoot = path.resolve(__dirname, '..', '..', 'dist');
```
Line 8:
```ts
const base = distExists ? distRoot : path.resolve(__dirname, '..', '..');
```
Line 238:
```ts
  const repoRoot = path.resolve(__dirname, '..', '..');
```

- [ ] **Step 3: Fix `__dirname` depth in `run-benchmark-fixture-debug.ts`**

`bench/repro/run-benchmark-fixture-debug.ts`:

Lines 9-10 (both dist candidates deepen by one level):
```ts
    path.resolve(__dirname, '..', '..', 'dist', 'summary.js'),
    path.resolve(__dirname, '..', '..', '..', 'dist', 'summary.js'),
```
Line 198:
```ts
  const repoRoot = path.resolve(__dirname, '..', '..');
```
(Line 36 `path.join(process.cwd(), 'eval', ...)` is cwd-relative — leave unchanged.)

- [ ] **Step 4: Fix module resolution in `repro-repo-search-pipe-from.ts` and drop the dead dist branch**

`bench/repro/repro-repo-search-pipe-from.ts` no longer ships in `dist` (bench/ is excluded from the build), so the `runningFromDist` branch is dead. Replace lines 43-49:

```ts
  const base = path.resolve(__dirname, '..', '..', 'src');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(base, 'repo-search', 'command-safety.js')) as CommandSafetyModule;
```

(This removes the `runningFromDist` detection at 43-47 and always resolves the repo `src/`, since the script now only runs from `bench/repro/` source via tsx.)

- [ ] **Step 5: Repoint the repro importers**

`tests/_runtime-helpers.ts:75-76`:
```ts
import { runDebugRequest } from '../bench/repro/run-benchmark-fixture-debug.ts';
import { runFixture60MalformedJsonRepro } from '../bench/repro/repro-fixture60-malformed-json.ts';
```

`tests/runtime-benchmark.test.ts:17`:
```ts
const { runDebugRequest } = require('../bench/repro/run-benchmark-fixture-debug.ts');
```

`tests/repo-search-pipe-from-repro.test.ts` lines 7 and 34 (both occurrences):
```ts
  const scriptPath = path.resolve(process.cwd(), 'bench', 'repro', 'repro-repo-search-pipe-from.ts');
```

- [ ] **Step 6: Verify the build no longer emits the repro scripts**

Run: `npm run build`
Then: `node -e "const fs=require('node:fs');const p=['dist/scripts/repro-fixture60-malformed-json.js','dist/scripts/run-benchmark-fixture-debug.js','dist/scripts/repro-repo-search-pipe-from.js'];process.exit(p.some(f=>fs.existsSync(f))?1:0)"`
Expected: build succeeds; node check exits 0 (none of the three compiled repro scripts remain in `dist/scripts`).

- [ ] **Step 7: Verify the repro tests run against the moved source**

Run: `npm run build:test` then:
```
node .\dist\scripts\run-tests.js runtime-benchmark.repro-malformed.test.ts
node .\dist\scripts\run-tests.js runtime-benchmark.repro-range.test.ts
node .\dist\scripts\run-tests.js runtime-benchmark.repro-valid.test.ts
node .\dist\scripts\run-tests.js repo-search-pipe-from-repro.test.ts
```
Expected: PASS for each (the repro fixtures resolve `dist`/`src` from the new two-level depth; the pipe-from test reads the script from `bench/repro/`).

- [ ] **Step 8: Verify bench typecheck still passes with the repro files included**

Run: `npm run typecheck:bench`
Expected: PASS (`bench/**/*.ts` now also covers `bench/repro/*`; the repro files are `@ts-nocheck`/self-resolving so they compile clean).

- [ ] **Step 9: Commit**

```bash
git add bench/repro tests/_runtime-helpers.ts tests/runtime-benchmark.test.ts tests/repo-search-pipe-from-repro.test.ts
git commit -m "refactor(bench): move repro scripts to bench/repro and fix dirname depth (F15)"
```

---

### Task 4: Full-suite verification and review-doc update

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (annotate F2 + F15 packaging items as resolved)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS across `tsconfig.json`, `tsconfig.scripts.json`, `dashboard`, `tsconfig.bench.json`, `tsconfig.test.json`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS (no test references a removed `dist/benchmark` or `dist/scripts/repro-*` path; `package-files.test.ts` green).

- [ ] **Step 3: Final tarball audit**

Run: `npm pack --dry-run`
Expected: tarball includes `bin/`, `SiftKit/`, `dist/` (with `dist/eval*` and `dist/benchmark-matrix/` still present — these are runtime), `scripts/postinstall.js`, `README.md`, `docs/`; excludes `eval/`, any `scripts/` entry except `postinstall.js`, and contains no `dist/benchmark/` or `dist/scripts/repro-*`/`dist/scripts/run-benchmark-fixture-debug` entries.

- [ ] **Step 4: Annotate the architecture review**

In `ARCHITECTURE-REVIEW.md`, update the F2 packaging note and the F15 finding to record that the npm `files` whitelist was corrected and `src/benchmark/` + repro scripts were moved to the non-shipped `bench/` tree, and update priority-list item 1 to note the bench-relocation half is done while `eval.ts`/`benchmark-matrix/` relocation remains for the full-sever/workspace epic.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE-REVIEW.md
git commit -m "docs: record bench/eval repackage (F2, F15 packaging half)"
```

---

## Self-review

- **Spec coverage:** F2 `files` fix → Task 1. F15 "bench/eval out of `src` and out of package" (shippable half: `src/benchmark/` + repro scripts; `eval.ts`/`benchmark-matrix` explicitly retained) → Tasks 2-3. Verification + doc → Task 4. Covered.
- **Type consistency:** `runBenchmarkSuite`, `runDebugRequest`, `runFixture60MalformedJsonRepro` symbol names preserved across moves; barrel re-exports (`tests/_runtime-helpers.ts:1660-1667`) keep working because their import sources are repointed, not removed. `tsconfig.bench.json` include (`bench/**/*.ts`) covers both `bench/benchmark` (Task 2) and `bench/repro` (Task 3).
- **No placeholders:** every edit lists exact file:line and final code.
- **Risk note:** the one runtime-resolution uncertainty (tsx resolving an explicit `.ts` specifier inside `require()`) is gated by Task 2 Step 8 with a documented `.js`-specifier fallback.
