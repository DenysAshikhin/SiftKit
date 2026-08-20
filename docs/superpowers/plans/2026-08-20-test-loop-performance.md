# Test-Loop Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the edit→build→test→typecheck loop from ~4.7 min to ~1.5 min by removing measured waste: ESLint linting 198 MB of generated bundles, cold tsc compiles, quadruple manifest hashing, full rebuilds on test-only edits, and real multi-second sleeps in tests.

**Architecture:** No production behavior changes except one env-var override for a progress-emit interval (mirrors the existing `SIFTKIT_TEST_RUN_BUDGET_MS` pattern). Everything else is build/lint/test infrastructure: an ignore entry, incremental-compile flags, a single-pass staleness check, a tests-only fast path in `build:test`, and scaled-down time budgets in three slow tests.

**Tech Stack:** node:test, esbuild, tsc `--incremental`, ESLint flat config.

**Measured baseline (2026-08-20, 24-core Ryzen 7900X):**

| Component | Time | Cause |
|---|---|---|
| `npm run lint` (inside typecheck) | 160 s | lints `.test-build/**` — 1467 generated JS files, 198 MB |
| 8 tsc project checks | ~30 s | cold, no incremental state |
| `npm run build:test` after a 1-line test edit | 20 s | all-or-nothing stamp → full pipeline |
| full suite (`npm test`) | ~65 s wall / 499 s budget | 145 tests >1 s hold 276 s; several are pure real-time sleeps |
| runner startup | ~0.9 s | hashes every input file 4× per invocation |

Expected after all tasks: lint ~9 s cold (~3 s warm), tsc ~30 s cold / ~8 s warm, test-edit rebuild ~4 s, suite ~57 s, runner startup ~0.35 s.

**Ordering constraint:** Task 6 (watchdog budget) depends on Task 3 (runner startup cut). Task 4 depends on Task 3's state refactor and benefits from Task 2's incremental test-build compile. Tasks 1, 2, 5, 7 are independent.

**Note on rebuild churn while executing:** `tsconfig*.json`, `package.json`, `scripts/**`, and `tests/**` are all inputs of the test-build stamp, so each task's edits force one full `npm run build:test` (~20 s) before `npm test`. Expected; do not chase it.

---

## File Map

- Modify: `eslint.config.mjs` — add `.test-build/**` to ignores (Task 1)
- Modify: `package.json` — lint scripts gain `--cache`; typecheck script gains per-project `--incremental` flags (Tasks 1, 2)
- Modify: `.gitignore` — `.eslintcache`, `/.tscache` (Tasks 1, 2)
- Modify: `tsconfig.test.json`, `tsconfig.bench.json`, `tsconfig.analysis.json`, `dashboard/tsconfig.json`, `dashboard/tsconfig.test.json`, `tsconfig.test-build.json` — incremental + distinct buildinfo paths (Task 2)
- Modify: `src/test-runner/test-build-state.ts` — single hash pass, `changedInputPaths`, `isTestsOnlyChange` (Tasks 3, 4)
- Modify: `src/test-runner/run-tests.ts` — drop duplicate `assertCurrentTestBuild` (Task 3)
- Modify: `scripts/build-test.ts` — tests-only fast path (Task 4)
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts` — interval env override (Task 5)
- Test: `tests/eslint-gate.test.ts` (Task 1), `tests/test-build-state.test.ts` (Tasks 3, 4), `tests/benchmark-spec-settings.test.ts` (Task 4), `tests/streamed-repo-search-endpoint.test.ts` (Task 5), `tests/run-tests-watchdog.test.ts` (Task 6), `tests/powershell-async.test.ts` (Task 7)

---

### Task 1: Stop ESLint from linting `.test-build`; cache lint results

Measured: `npx eslint .` = 160 s; with `.test-build` ignored = 9 s. Flat config lints `**/*.js` by default and the ignores list in `eslint.config.mjs` never mentions `.test-build`, so every run chews through 1467 generated bundle files (198 MB).

**Files:**
- Modify: `eslint.config.mjs:47-67` (ignores array)
- Modify: `package.json:46-47` (lint scripts)
- Modify: `.gitignore`
- Test: `tests/eslint-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/eslint-gate.test.ts` (the suite always runs from compiled artifacts, so `.test-build/tests/eslint-gate.test.bundle.js` is guaranteed to exist — it is this very file's bundle):

```ts
// Generated test bundles are 198MB of esbuild output; linting them once cost 160s per run.
// ESLint reports an explicitly-named ignored file with a single "ignored" warning.
test('eslint gate ignores the generated test build tree', () => {
  const output = execFileSync(
    process.execPath,
    [eslintExecutable, '--format', 'json', '.test-build/tests/eslint-gate.test.bundle.js'],
    { encoding: 'utf8' },
  );
  const results = z.array(LintFileResultSchema).parse(JSON.parse(output));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.errorCount, 0);
  assert.match(results[0]?.messages[0]?.message ?? '', /ignored/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js eslint-gate
```
Expected: FAIL — the new test's `assert.match(... /ignored/u)` fails (file is currently linted, so `messages` is empty or contains rule hits, not an "ignored" warning).

- [ ] **Step 3: Add the ignore entry**

In `eslint.config.mjs`, inside the `ignores` array, directly after `'dist/**',`:

```js
      'dist/**',
      // Generated test bundles: 198MB of esbuild output. Linting them costs ~150s
      // per run and can only ever flag code that originated in already-linted sources.
      '.test-build/**',
```

- [ ] **Step 4: Enable the lint cache**

In `package.json`, replace the two lint scripts:

```json
    "lint": "eslint . --cache --cache-location .eslintcache",
    "lint:fix": "eslint . --fix --cache --cache-location .eslintcache"
```

- [ ] **Step 5: Ignore the cache file**

In `.gitignore`, under `# Temp/debug files`, add:

```
.eslintcache
```

- [ ] **Step 6: Run the test to verify it passes**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js eslint-gate
```
Expected: PASS (all 9 tests — the 8 existing fixtures still lint because `lintFixtures` passes `--no-ignore`, which is unaffected by the new ignore entry).

- [ ] **Step 7: Verify the timing win**

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run lint; $sw.Stop(); "cold: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run lint; $sw.Stop(); "warm: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
```
Expected: exit 0 both times; cold ≈ 9–15 s, warm ≤ 5 s.

- [ ] **Step 8: Commit**

```powershell
git add eslint.config.mjs package.json .gitignore tests/eslint-gate.test.ts
git commit -m "perf(lint): ignore generated .test-build tree and cache results"
```

---

### Task 2: Incremental type-checking for the check-only tsc runs

The 8 project checks in `npm run typecheck` are cold every run (~30 s). Constraint discovered during planning: `scripts/sync-dist-runtime.ts --clean` deletes `dist/` wholesale and the sync step relocates `dist/src/*`, while tsc's buildinfo never verifies outputs still exist — so the **emitting** configurations must not become incremental via their config files. Incremental state is therefore attached only to check-only runs: via CLI flags for the two dual-use configs (`tsconfig.json`, `tsconfig.scripts.json`), and via config for the pure-`noEmit` configs. `tsconfig.test-build.json` (which emits into `.test-build`) keeps its buildinfo **inside** `.test-build` so `resetTestBuildRoot` deletes both together — stale-buildinfo-over-missing-outputs cannot occur.

**Files:**
- Modify: `package.json:17` (typecheck script)
- Modify: `tsconfig.test.json`, `tsconfig.bench.json`, `tsconfig.analysis.json`, `tsconfig.test-build.json`, `dashboard/tsconfig.json`, `dashboard/tsconfig.test.json`
- Modify: `.gitignore`

No new test: config-only change, validated by running the checks twice (behavioral output of tsc is identical; only wall time changes). `*.tsbuildinfo` is already gitignored (`.gitignore:14`); the `.tscache` directories get their own entries.

- [ ] **Step 1: Flag the dual-use configs on the CLI only**

In `package.json`, replace the `typecheck` script's two root-project invocations (leave the rest of the chain untouched):

```json
    "typecheck": "tsc -b .\\packages\\contracts\\tsconfig.json && tsc -p .\\tsconfig.json --noEmit --incremental --tsBuildInfoFile .tscache\\main.tsbuildinfo && tsc -p .\\tsconfig.scripts.json --noEmit --incremental --tsBuildInfoFile .tscache\\scripts.tsbuildinfo && tsc -p .\\dashboard\\tsconfig.json --noEmit && npm run typecheck:bench && npm run typecheck:test && npm run typecheck:dashboard-test && npm run typecheck:analysis && npm run lint",
```

- [ ] **Step 2: Add incremental to the pure check-only configs**

`tsconfig.test.json` — add to `compilerOptions`:

```json
    "incremental": true,
    "tsBuildInfoFile": "./.tscache/test.tsbuildinfo",
```

`tsconfig.bench.json` — add to `compilerOptions`:

```json
    "incremental": true,
    "tsBuildInfoFile": "./.tscache/bench.tsbuildinfo",
```

`tsconfig.analysis.json` — add to `compilerOptions`:

```json
    "incremental": true,
    "tsBuildInfoFile": "./.tscache/analysis.tsbuildinfo",
```

`dashboard/tsconfig.json` — add to `compilerOptions` (path is relative to `dashboard/`):

```json
    "incremental": true,
    "tsBuildInfoFile": "./.tscache/dashboard.tsbuildinfo",
```

`dashboard/tsconfig.test.json` — add to `compilerOptions`. This override is **mandatory**: it extends `dashboard/tsconfig.json` and would otherwise share (and corrupt) the same buildinfo file:

```json
    "incremental": true,
    "tsBuildInfoFile": "./.tscache/dashboard-test.tsbuildinfo",
```

- [ ] **Step 3: Add incremental to the test-build emit config, buildinfo inside the tree it emits into**

`tsconfig.test-build.json` — add to `compilerOptions`:

```json
    "incremental": true,
    "tsBuildInfoFile": "./.test-build/.tsbuildinfo",
```

The buildinfo must live under `.test-build` and nowhere else: `resetTestBuildRoot` (scripts/build-test.ts:112) deletes the whole tree, and a surviving buildinfo would make the next tsc run skip emit over missing outputs. Task 4's fast path skips the reset, so there the buildinfo survives and the compile is warm — which is the point.

- [ ] **Step 4: Ignore the cache directories**

In `.gitignore`, under `# Build artifacts`, add:

```
/.tscache
dashboard/.tscache
```

- [ ] **Step 5: Verify cold and warm runs**

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run typecheck; $sw.Stop(); "cold: $([math]::Round($sw.Elapsed.TotalSeconds,1))s exit=$LASTEXITCODE"
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run typecheck; $sw.Stop(); "warm: $([math]::Round($sw.Elapsed.TotalSeconds,1))s exit=$LASTEXITCODE"
```
Expected: exit 0 both; with Task 1 landed, cold ≈ 40–45 s, warm ≈ 12–20 s (tsc portion drops from ~30 s to a few seconds; lint cache does the rest).

- [ ] **Step 6: Verify the reset hazard is closed**

```powershell
npm run build:test; npm run build:test
```
Expected: first run does a full rebuild (tsconfig edits made the stamp stale), second prints `[build:test] up to date`. Then confirm a fresh reset still emits:

```powershell
Remove-Item -Recurse -Force .test-build; npm run build:test; node .\dist\test-runner\run-tests.js test-build-state
```
Expected: full rebuild succeeds and the test file passes (proves no stale-buildinfo skip after the tree was deleted).

- [ ] **Step 7: Run the suite**

```powershell
npm test
```
Expected: 3255 tests, 0 fail.

- [ ] **Step 8: Commit**

```powershell
git add package.json tsconfig.test.json tsconfig.bench.json tsconfig.analysis.json tsconfig.test-build.json dashboard/tsconfig.json dashboard/tsconfig.test.json .gitignore
git commit -m "perf(typecheck): incremental state for check-only tsc runs"
```

---

### Task 3: Hash the build manifest once per runner invocation

`node dist/test-runner/run-tests.js <file>` costs ~1.0 s before any test runs vs ~0.1 s for running the compiled file directly. Cause: every input file is SHA-256 hashed **four times** — `run-tests.ts:39` calls `assertCurrentTestBuild`, then `buildNodeTestArgs` → `readCurrentTestBuildManifest` → `assertCurrentTestBuild` again, and each `getTestBuildState` internally hashes twice (`createInputs` for the diff, then `createManifest` → `createInputs` again). This task also introduces `changedInputPaths` on the `stale` state, which Task 4 consumes.

**Files:**
- Modify: `src/test-runner/test-build-state.ts`
- Modify: `src/test-runner/run-tests.ts:6,39`
- Test: `tests/test-build-state.test.ts`

- [ ] **Step 1: Update the stale-state assertions to demand `changedInputPaths` (failing first)**

In `tests/test-build-state.test.ts`, update the three `stale` assertions:

Line 125 (test "names a changed input when artifacts are stale"):
```ts
  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath,
    changedInputPaths: ['src/input.ts'],
  });
```

Line 135 (test "detects changed input content when its mtime is restored"):
```ts
  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath,
    changedInputPaths: ['src/input.ts'],
  });
```

Line 157 (test "rejects artifacts after a source input is deleted"):
```ts
  assert.deepEqual(getTestBuildState(root), {
    kind: 'stale',
    newestInputPath: deletedInputPath,
    changedInputPaths: ['src/input.ts'],
  });
```

Append a new test covering multiple changes (order: changed/added inputs in listing order, then deleted ones):

```ts
test('test build state lists every changed input for the fast-path decision', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'dashboard', 'tests', 'input.test.ts'), 'changed', 'utf8');

  const state = getTestBuildState(root);
  assert.equal(state.kind, 'stale');
  assert.deepEqual(
    state.kind === 'stale' ? state.changedInputPaths : [],
    ['dashboard/tests/input.test.ts', 'tests/input.test.ts'],
  );
});
```

- [ ] **Step 2: Run to verify the updated tests fail**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js test-build-state
```
Expected: FAIL — `deepEqual` mismatches (`changedInputPaths` absent from actual).

- [ ] **Step 3: Refactor `test-build-state.ts` to one hash pass**

Replace the `TestBuildState` type (line 75-80):

```ts
export type TestBuildState =
  | { kind: 'missing' }
  | { kind: 'malformed'; stampPath: string }
  | { kind: 'stale'; newestInputPath: string; changedInputPaths: string[] }
  | { kind: 'incomplete'; missingOutputPath: string }
  | { kind: 'current' };
```

Replace `createManifest` (lines 152-169) with an inputs-reusing builder:

```ts
function createManifestFromInputs(inputs: TestBuildManifest['inputs']): TestBuildManifest {
  const inputPaths = inputs.map((input) => input.path);
  const tests = createTestEntries(inputPaths);
  const outputs = [
    ...STATIC_OUTPUT_PATHS.map((outputPath) => outputPath.replace(/\\/gu, '/')),
    ...createMirroredOutputs(inputPaths),
    ...tests.flatMap((entry) => [entry.entrypoint, entry.bundle]),
  ];
  return TestBuildManifestSchema.parse({
    version: 2,
    inputs,
    outputs: [...new Set(outputs)].sort((left, right) => left.localeCompare(right)),
    tests,
  });
}
```

Replace `createTestBuildStampContent` (lines 171-173):

```ts
export function createTestBuildStampContent(repoRoot: string): string {
  const inputPaths = listInputFiles(repoRoot);
  if (!inputPaths) {
    throw new Error('Cannot create a test build manifest while required inputs are missing.');
  }
  return `${JSON.stringify(createManifestFromInputs(createInputs(repoRoot, inputPaths)))}\n`;
}
```

Replace `findChangedInput` (lines 183-193) with an all-changes variant returning manifest-relative paths:

```ts
function findChangedInputPaths(
  manifestInputs: TestBuildManifest['inputs'],
  currentInputs: TestBuildManifest['inputs'],
): string[] {
  const manifestByPath = new Map(manifestInputs.map((input) => [input.path, input.sha256]));
  const currentByPath = new Map(currentInputs.map((input) => [input.path, input.sha256]));
  const changed = currentInputs
    .filter((input) => manifestByPath.get(input.path) !== input.sha256)
    .map((input) => input.path);
  const removed = manifestInputs
    .filter((input) => !currentByPath.has(input.path))
    .map((input) => input.path);
  return [...changed, ...removed];
}
```

Replace `getTestBuildState` (lines 195-228) — `createInputs` now runs exactly once:

```ts
export function getTestBuildState(repoRoot: string): TestBuildState {
  const stampPath = path.resolve(repoRoot, TEST_BUILD_STAMP_PATH);
  if (!fs.existsSync(stampPath)) {
    return { kind: 'missing' };
  }
  const manifest = readManifest(stampPath);
  if (!manifest) {
    return { kind: 'malformed', stampPath };
  }

  const currentInputPaths = listInputFiles(repoRoot);
  if (!currentInputPaths) {
    return { kind: 'missing' };
  }
  const currentInputs = createInputs(repoRoot, currentInputPaths);
  const changedInputPaths = findChangedInputPaths(manifest.inputs, currentInputs);
  if (changedInputPaths.length > 0) {
    return {
      kind: 'stale',
      newestInputPath: path.resolve(repoRoot, changedInputPaths[0] ?? ''),
      changedInputPaths,
    };
  }

  const expectedManifest = createManifestFromInputs(currentInputs);
  if (JSON.stringify(manifest.outputs) !== JSON.stringify(expectedManifest.outputs)
    || JSON.stringify(manifest.tests) !== JSON.stringify(expectedManifest.tests)) {
    // Inputs all match yet derived outputs disagree: the stamp itself is inconsistent.
    // No input to blame, so the fast path must not engage — an empty list signals that.
    return { kind: 'stale', newestInputPath: stampPath, changedInputPaths: [] };
  }
  const missingOutput = manifest.outputs.find((outputPath) => !fs.existsSync(path.resolve(repoRoot, outputPath)));
  if (missingOutput) {
    return { kind: 'incomplete', missingOutputPath: path.resolve(repoRoot, missingOutput) };
  }
  return { kind: 'current' };
}
```

- [ ] **Step 4: Drop the duplicate assert in `run-tests.ts`**

Delete line 39 (`assertCurrentTestBuild(repoRoot);`) — `buildNodeTestArgs` on the next line reaches `readCurrentTestBuildManifest`, which asserts. Remove `assertCurrentTestBuild` from the import on line 6:

```ts
import { buildNodeTestArgs } from './test-targets.js';
```

(The `test-build-state.js` import line disappears entirely if nothing else from it is used — check and let `@typescript-eslint/no-unused-vars` be the backstop.)

- [ ] **Step 5: Run the affected files, then the suite**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js test-build-state test-targets run-tests-watchdog benchmark-spec-settings
```
Expected: PASS. Then:

```powershell
npm test
```
Expected: 3255 tests, 0 fail.

- [ ] **Step 6: Verify the startup win**

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew(); node .\dist\test-runner\run-tests.js gitattributes *>$null; $sw.Stop(); "runner+1file: $([math]::Round($sw.Elapsed.TotalSeconds,2))s"
```
Expected: ≈ 0.3–0.45 s (baseline 1.03 s).

- [ ] **Step 7: Commit**

```powershell
git add src/test-runner/test-build-state.ts src/test-runner/run-tests.ts tests/test-build-state.test.ts
git commit -m "perf(test-runner): hash the build manifest once and report every changed input"
```

---

### Task 4: Tests-only fast path in `build:test`

A one-line edit under `tests/` currently triggers the full pipeline (~20 s): dist clean, contracts build, two tsc emits, dist sync, test-build tsc, npm-pack dry run, and re-bundling all 466 entries. A change confined to `tests/` or `dashboard/tests/` cannot alter `dist`, contracts, or the pack manifest. The fast path keeps the type gate (tsc over `tsconfig.test-build.json`, warm via Task 2's buildinfo) and re-bundles only what the change can reach: the changed entries themselves, or — when a non-entry file under `tests/` changed (helpers are inlined into an unknowable set of bundles) — every entry.

**Files:**
- Modify: `scripts/build-test.ts:120-159`
- Modify: `src/test-runner/test-build-state.ts` (add `isTestsOnlyChange`)
- Test: `tests/test-build-state.test.ts`, `tests/benchmark-spec-settings.test.ts:728-733`

- [ ] **Step 1: Write failing tests for the decision helper**

Append to `tests/test-build-state.test.ts` (add `isTestsOnlyChange` to the import from `../src/test-runner/test-build-state.js`):

```ts
test('a change confined to test directories qualifies for the tests-only fast path', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'dashboard', 'tests', 'input.test.ts'), 'changed', 'utf8');

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), true);
});

test('a source change alongside a test change disqualifies the fast path', () => {
  const { root } = createCurrentBuildLayout();
  fs.writeFileSync(path.join(root, 'tests', 'input.test.ts'), 'changed', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'input.ts'), 'changed', 'utf8');

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), false);
});

test('non-stale states never qualify for the fast path', () => {
  const { root } = createCurrentBuildLayout();

  assert.equal(isTestsOnlyChange(getTestBuildState(root)), false);
  assert.equal(isTestsOnlyChange({ kind: 'missing' }), false);
  // An inconsistent stamp reports stale with no changed inputs; that must rebuild fully.
  assert.equal(
    isTestsOnlyChange({ kind: 'stale', newestInputPath: root, changedInputPaths: [] }),
    false,
  );
});
```

- [ ] **Step 2: Run to verify they fail**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js test-build-state
```
Expected: FAIL — `isTestsOnlyChange` is not exported.

- [ ] **Step 3: Implement the helper in `test-build-state.ts`**

Append after `getTestBuildState`:

```ts
/**
 * True when every stale input lives under a test directory. Such a change cannot alter
 * dist, the contracts build, or the pack manifest, so build:test may skip those stages.
 * An empty change list means the stamp itself is inconsistent — never fast-path that.
 */
export function isTestsOnlyChange(state: TestBuildState): boolean {
  return state.kind === 'stale'
    && state.changedInputPaths.length > 0
    && state.changedInputPaths.every(
      (inputPath) => inputPath.startsWith('tests/') || inputPath.startsWith('dashboard/tests/'),
    );
}
```

- [ ] **Step 4: Run to verify the helper tests pass**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js test-build-state
```
Expected: PASS.

- [ ] **Step 5: Update the build-script contract test (failing first)**

In `tests/benchmark-spec-settings.test.ts:728-733`, replace the test body — the script will hold the state in a variable and branch on the fast path:

```ts
test('build:test reuses only a current content-addressed artifact set', () => {
  const buildScript = fs.readFileSync('scripts/build-test.ts', 'utf8');

  assert.match(buildScript, /state\.kind === 'current'/u);
  assert.match(buildScript, /isTestsOnlyChange\(state\)/u);
  assert.match(buildScript, /\['--clean'\]/u);
});
```

Run:
```powershell
npm run build:test; node .\dist\test-runner\run-tests.js benchmark-spec-settings
```
Expected: FAIL on the two new `assert.match` calls (build script not yet restructured).

- [ ] **Step 6: Restructure `scripts/build-test.ts`**

Update the import from `../src/test-runner/test-build-state.ts` to include `isTestsOnlyChange`:

```ts
import {
  TEST_BUILD_ROOT,
  TEST_BUILD_STAMP_PATH,
  createTestBuildStampContent,
  getTestBuildState,
  isTestsOnlyChange,
} from '../src/test-runner/test-build-state.ts';
```

Add the fast-path builder above `buildTestArtifacts`:

```ts
/**
 * A change confined to tests/ or dashboard/tests/ cannot alter dist, contracts, or the
 * pack manifest, so only the type gate and the reachable bundles need rebuilding. The
 * .test-build tree is NOT reset here: tsconfig.test-build.json keeps its incremental
 * state inside it, which is what makes the type gate warm on this path.
 */
async function rebuildTestBundlesOnly(changedInputPaths: string[]): Promise<void> {
  // esbuild strips types without checking them; the gate must still fail loudly on a
  // type-broken test. Incremental state keeps this to the affected files.
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.test-build.json')]);

  const testSourcePaths = [
    ...listTestEntries(path.join(repoRoot, 'tests')),
    ...listTestEntries(path.join(repoRoot, 'dashboard', 'tests')),
  ];
  const testSourceByManifestPath = new Map(testSourcePaths.map((sourcePath) => [
    path.relative(repoRoot, sourcePath).replace(/\\/gu, '/'),
    sourcePath,
  ]));
  // A changed helper (any non-entry file under tests/) is inlined into an unknowable set
  // of bundles, so anything that is not itself a test entry forces a full re-bundle.
  const everyChangeIsAnEntry = changedInputPaths.every(
    (inputPath) => testSourceByManifestPath.has(inputPath) || /\.test\.tsx?$/u.test(inputPath),
  );
  const changedEntrySources = changedInputPaths
    .map((inputPath) => testSourceByManifestPath.get(inputPath))
    .filter((sourcePath): sourcePath is string => sourcePath !== undefined);
  const sourcesToBundle = everyChangeIsAnEntry ? changedEntrySources : testSourcePaths;
  if (sourcesToBundle.length > 0) {
    await emitBundledTests(sourcesToBundle);
  }
  // The tsc gate above re-emits compiled test files over the runner's entrypoint shims;
  // rewrite every shim so each entrypoint imports its bundle again.
  for (const sourcePath of testSourcePaths) {
    emitIsolatedTestEntry(sourcePath);
  }
  // A deleted test entry leaves artifacts the manifest no longer lists; remove them so
  // the tree matches the stamp exactly.
  for (const inputPath of changedInputPaths) {
    if (/\.test\.tsx?$/u.test(inputPath) && !testSourceByManifestPath.has(inputPath)) {
      const entrypointPath = path.resolve(testBuildRoot, inputPath.replace(/\.tsx?$/u, '.js'));
      fs.rmSync(entrypointPath, { force: true });
      fs.rmSync(entrypointPath.replace(/\.js$/u, '.bundle.js'), { force: true });
    }
  }

  fs.writeFileSync(
    path.resolve(repoRoot, TEST_BUILD_STAMP_PATH),
    createTestBuildStampContent(repoRoot),
    'utf8',
  );
  process.stdout.write('[build:test] tests-only rebuild\n');
}
```

Replace the head of `buildTestArtifacts` (currently `if (getTestBuildState(repoRoot).kind === 'current') { ... }`):

```ts
async function buildTestArtifacts(): Promise<void> {
  const state = getTestBuildState(repoRoot);
  if (state.kind === 'current') {
    process.stdout.write('[build:test] up to date\n');
    return;
  }
  if (isTestsOnlyChange(state) && state.kind === 'stale') {
    await rebuildTestBundlesOnly(state.changedInputPaths);
    return;
  }
  // ...existing full pipeline unchanged from here...
```

- [ ] **Step 7: Run the contract tests**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js benchmark-spec-settings test-build-state
```
Expected: PASS. (This `build:test` itself takes the full path — `scripts/build-test.ts` and `src/**` changed.)

- [ ] **Step 8: Exercise the fast path end-to-end**

```powershell
Add-Content tests\gitattributes.test.ts "`n// fast-path probe"
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run build:test; $sw.Stop(); "tests-only: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
node .\dist\test-runner\run-tests.js gitattributes
git checkout -- tests\gitattributes.test.ts
npm run build:test
```
Expected: output contains `[build:test] tests-only rebuild`, time ≤ 8 s (vs 20 s baseline), the probed test file passes, and the final `build:test` (after revert) takes the fast path again back to the original content.

Then prove a src change still takes the full path:

```powershell
Add-Content src\lib\errors.ts "`n// full-path probe"
npm run build:test
git checkout -- src\lib\errors.ts
npm run build:test
```
Expected: neither run prints `tests-only rebuild`; both succeed.

- [ ] **Step 9: Run the whole suite**

```powershell
npm test
```
Expected: 3255 tests, 0 fail.

- [ ] **Step 10: Commit**

```powershell
git add scripts/build-test.ts src/test-runner/test-build-state.ts tests/test-build-state.test.ts tests/benchmark-spec-settings.test.ts
git commit -m "perf(build:test): rebuild only bundles when a change is confined to tests"
```

---

### Task 5: Injectable lock-wait emit interval; retire the multi-second hold

`queued repo-search sees lock_wait progress while a slow run holds the lock` (tests/streamed-repo-search-endpoint.test.ts:69) spends 5.8 s holding a lock because the server's first `lock_wait` frame only fires after `LOCK_WAIT_EMIT_INTERVAL_MS = 2000` ms. An env override (same parse-guard pattern as `SIFTKIT_TEST_RUN_BUDGET_MS` in run-tests.ts:26-29) lets the test use a 250 ms interval against a 1.5 s hold — larger absolute margin than today's 4.5 s hold gives, at a third of the runtime. The harness runs the status server in-process (tests/helpers/streamed-op-harness.ts:60), so a plain `process.env` set reaches it; the endpoint reads the value per request, not at module load.

**Files:**
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts:18,89-95`
- Test: `tests/streamed-repo-search-endpoint.test.ts:69-109`

- [ ] **Step 1: Rewrite the test to use the injected interval (failing first)**

Replace the opening of the test (lines 69-88 today, including the margin comment added 2026-08-20 — the 4.5 s hold this replaces):

```ts
test('queued repo-search sees lock_wait progress while a slow run holds the lock', async (t) => {
  // The queued request only starts waiting after the holder's tool_start frame crosses
  // SSE. A 250ms emit interval against a 1500ms hold keeps over a second of absolute
  // margin for that propagation under full-suite load, without spending real seconds
  // waiting out the production 2s first tick.
  process.env.SIFTKIT_LOCK_WAIT_EMIT_INTERVAL_MS = '250';
  t.after(() => {
    delete process.env.SIFTKIT_LOCK_WAIT_EMIT_INTERVAL_MS;
  });
  const harness = await startHarness('siftkit-streamed-rs-lock-', t);
  const slowBody = {
    ...REPO_SEARCH_BODY,
    repoRoot: process.cwd(),
    mockCommandResults: {
      'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 1_500 },
    },
  };
```

(The rest of the test — holder promise, queued request, assertions — stays exactly as it is.)

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js streamed-repo-search-endpoint
```
Expected: FAIL — `expected lock_wait progress while queued` (env is ignored, so the first tick at 2000 ms outlives the 1500 ms hold).

- [ ] **Step 3: Implement the override**

In `src/status-server/routes/streamed-operation-endpoint.ts`, replace line 18:

```ts
const DEFAULT_LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

// An unparseable override must not become the interval: setInterval clamps NaN to 1ms,
// which would flood every stream with lock_wait frames instead of pacing them.
function readLockWaitEmitIntervalMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_LOCK_WAIT_EMIT_INTERVAL_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_WAIT_EMIT_INTERVAL_MS;
}
```

And at line 95, change the interval creation's final argument:

```ts
    }, readLockWaitEmitIntervalMs());
```

- [ ] **Step 4: Run to verify it passes, repeatedly**

```powershell
npm run build:test
foreach ($i in 1..5) { node .\dist\test-runner\run-tests.js streamed-repo-search-endpoint *>$null; "run ${i}: exit=$LASTEXITCODE" }
```
Expected: exit=0 all five runs; the lock test's reported duration drops from ~5.8 s to ~2 s.

- [ ] **Step 5: Run the suite**

```powershell
npm test
```
Expected: 3255 tests, 0 fail.

- [ ] **Step 6: Commit**

```powershell
git add src/status-server/routes/streamed-operation-endpoint.ts tests/streamed-repo-search-endpoint.test.ts
git commit -m "perf(tests): inject the lock_wait emit interval instead of waiting out 2s"
```

---

### Task 6: Shrink the watchdog run budget (depends on Task 3)

`the test runner ends a run that exceeds its budget and reaps its descendants` (tests/run-tests-watchdog.test.ts:35) waits out a real `RUN_BUDGET_MS = 5000`. The budget's lower bound is the time until the nested runner's fixture grandchild writes its PID file: nested runner startup (now ~0.3 s after Task 3) plus a two-process spawn chain (~1–1.5 s under full-suite load). 3000 ms keeps ~1.5 s of margin. Failure mode if the margin is ever wrong is loud, not silent: the tree kill lands before the grandchild exists, `waitForGrandchildPidFile` throws after its own 10 s deadline, and the test fails with a clear message.

**Files:**
- Modify: `tests/run-tests-watchdog.test.ts:18`

- [ ] **Step 1: Lower the budget with the margin documented**

Replace line 18:

```ts
// Must exceed nested-runner startup (~0.3s, one manifest hash pass) plus the fixture's
// child+grandchild spawn chain (~1.5s under full-suite load) before the tree kill fires,
// or the grandchild PID file never appears and waitForGrandchildPidFile fails loudly.
const RUN_BUDGET_MS = 3_000;
```

- [ ] **Step 2: Verify repeatedly in isolation**

```powershell
npm run build:test
foreach ($i in 1..5) { node .\dist\test-runner\run-tests.js run-tests-watchdog *>$null; "run ${i}: exit=$LASTEXITCODE" }
```
Expected: exit=0 all five; the budget test's duration drops from ~6.9 s to ~4.5 s.

- [ ] **Step 3: Verify under full-suite load**

```powershell
npm test
```
Expected: 3255 tests, 0 fail. If the watchdog test flakes here, revert to `5_000` and stop — the margin call was wrong, and 2 s of budget is not worth a flaky guard test.

- [ ] **Step 4: Commit**

```powershell
git add tests/run-tests-watchdog.test.ts
git commit -m "perf(tests): 3s watchdog budget now that runner startup is one hash pass"
```

---

### Task 7: Shrink the PowerShell tree-kill timeout

Both timeout tests in `tests/powershell-async.test.ts` wait out a real `TREE_KILL_TIMEOUT_MS = 4000` (~4.4 s each). The bound is powershell.exe startup (~0.5 s idle, worse under load) plus two node startups before the grandchild exists. 3000 ms keeps ~1 s of margin over the worst observed chain; the failure mode is loud (`waitForGrandchildPid` throws at its 10 s deadline). `PROCESS_LIFETIME_MS / 2 = 10 s` stays comfortably above the new value, so the promptness assertion keeps its meaning.

**Files:**
- Modify: `tests/powershell-async.test.ts:17-23`

- [ ] **Step 1: Lower the timeout, updating the comment's reasoning**

Replace lines 17-23:

```ts
/**
 * Must outlast powershell.exe startup (~0.5s idle, worse under load) plus two node
 * startups, so the grandchild exists before the tree kill fires — otherwise the kill
 * lands on a lone powershell.exe and the PID file the fixture waits on never appears
 * (waitForGrandchildPid then fails loudly at its own deadline).
 * Must stay well under PROCESS_LIFETIME_MS / 2 to keep the promptness assertion meaningful.
 */
const TREE_KILL_TIMEOUT_MS = 3_000;
```

(`timeoutMessagePattern` on line 24 derives from the constant, so no other edit is needed.)

- [ ] **Step 2: Verify repeatedly in isolation**

```powershell
npm run build:test
foreach ($i in 1..5) { node .\dist\test-runner\run-tests.js powershell-async *>$null; "run ${i}: exit=$LASTEXITCODE" }
```
Expected: exit=0 all five; both timeout tests drop from ~4.4 s to ~3.4 s.

- [ ] **Step 3: Verify under full-suite load**

```powershell
npm test
```
Expected: 3255 tests, 0 fail. Same rule as Task 6: if either timeout test flakes under load, revert to `4_000` — the comment's original "seconds under load" warning was right and the saving is not worth it.

- [ ] **Step 4: Commit**

```powershell
git add tests/powershell-async.test.ts
git commit -m "perf(tests): 3s tree-kill timeout with the margin documented"
```

---

## Final Verification

- [ ] Full suite, three consecutive runs, all green:

```powershell
foreach ($i in 1..3) { npm test *>$null; "suite ${i}: exit=$LASTEXITCODE" }
```

- [ ] Timed loop comparison against the baseline table:

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm test; $sw.Stop(); "suite: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
$sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run typecheck; $sw.Stop(); "typecheck warm: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
Add-Content tests\gitattributes.test.ts "`n// timing probe"; $sw=[System.Diagnostics.Stopwatch]::StartNew(); npm run build:test; $sw.Stop(); "test-edit rebuild: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"; git checkout -- tests\gitattributes.test.ts; npm run build:test
```

Targets: suite ≤ 60 s, typecheck warm ≤ 20 s, test-edit rebuild ≤ 8 s.

- [ ] No scratch files left; `git status` shows only the committed changes.

## Risks

- **Tasks 6–7 trade margin for seconds.** Both have loud failure modes and explicit revert instructions; if either flakes in the three-run final verification, revert that constant and keep the rest.
- **Task 2's buildinfo placement is load-bearing.** Any future config that both emits and gains `incremental` must keep its buildinfo inside the tree that gets deleted with its outputs (the `tsconfig.test-build.json` comment in this plan is the reference).
- **Task 4's helper-change detection is name-based** (`*.test.ts` = entry, anything else under `tests/` = helper). A helper named `*.test.ts` would be mis-bundled as an entry — but `listTestEntries` already treats every `*.test.ts` under `tests/` as an entry, so that naming is impossible today without breaking the suite anyway.
