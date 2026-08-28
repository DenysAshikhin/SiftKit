# Incremental Build Pipeline + Desktop Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every build layer incremental (tsc -b project references, dashboard content stamp, cargo-native) and add Rust-toolchain provisioning + desktop build to `refresh-global`.

**Architecture:** Replace the `paths`-to-contracts-source mapping with a project reference to the already-composite `packages/contracts`, so tsc emits flat to `dist/` and the wipe/flatten steps in `sync-dist-runtime.ts` are deleted. A new `scripts/dashboard-stamp.ts` hashes dashboard inputs and skips the Vite build on match. `refresh-global.ps1` gains a toolchain-presence check and `cargo tauri build`.

**Tech Stack:** TypeScript 5.9 (`tsc -b`), Node `--experimental-strip-types` scripts, Vite 7, PowerShell 5.1, cargo/tauri 2.

**Spec:** `docs/superpowers/specs/2026-08-28-incremental-build-and-desktop-refresh-design.md`

**Constraints from the user:** No repo-agent; implement directly. `siftkit repo-search` for discovery, `siftkit summary` for large output. Leave the running status server on :4765 alone (refresh-global stops the global one itself).

---

### Task 1: Convert the TS build to project references (atomic cutover)

This task is one atomic commit: tsconfigs, `sync-dist-runtime.ts`, `build-test.ts`, `package.json`, and the tests pinning the old wiring must change together, because removing `--clean` support breaks every caller that still passes it.

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.scripts.json`
- Modify: `scripts/sync-dist-runtime.ts`
- Create: `scripts/build-clean.ts`
- Modify: `scripts/build-test.ts:186-196`
- Modify: `package.json` (scripts `build`, `purge:temp`, new `build:clean`)
- Modify: `tests/benchmark-spec-settings.test.ts` (import line 9; tests at ~:642, ~:686, ~:700, ~:719, ~:733, ~:740, ~:767, ~:786)

- [ ] **Step 1: Update the pinned wiring tests (they will fail until the implementation lands)**

In `tests/benchmark-spec-settings.test.ts`:

1. Line 9 — change the import:

```ts
// OLD
import { cleanCompiledOutputs, syncDistRuntime } from '../scripts/sync-dist-runtime.js';
// NEW: only ensureCliShebang survives; this file no longer needs any import from it.
// Delete the import line entirely.
```

2. Replace test `package build command syncs dist runtime output after compiling TypeScript`:

```ts
test('package build compiles with project references and finishes with runtime markers', () => {
  const pkg = readPackageJson();

  assert.match(String(pkg.scripts?.build || ''), /tsc\s+-b\s+\.\\tsconfig\.json/u);
  assert.match(
    String(pkg.scripts?.build || ''),
    /node\s+--experimental-strip-types\s+\.\\scripts\\sync-dist-runtime\.ts/u,
  );
  assert.doesNotMatch(String(pkg.scripts?.build || ''), /--clean/u);
  assert.doesNotMatch(String(pkg.scripts?.build || ''), /experimental-default-type/u);
});
```

3. Replace test `compiled purge-temp-dirs module can be evaluated as ESM without purging OS temp` (dist/scripts no longer exists) with a wiring assertion:

```ts
test('purge:temp runs from source via tsx instead of a compiled scripts tree', () => {
  const pkg = readPackageJson();

  assert.equal(String(pkg.scripts?.['purge:temp']), 'tsx .\\scripts\\purge-temp-dirs-main.ts');
});
```

4. In test `build:test reuses only a current content-addressed artifact set`, replace the `--clean` assertion:

```ts
// OLD
  assert.match(buildScript, /\['--clean'\]/u);
// NEW
  assert.doesNotMatch(buildScript, /--clean/u);
  assert.match(buildScript, /'-b'/u);
```

5. In test `scripts TypeScript build includes both build entrypoints and purge`, add:

```ts
  assert.match(scriptsConfig, /"scripts\/build-clean\.ts"/u);
  assert.match(scriptsConfig, /"noEmit":\s*true/u);
```

6. Replace test `syncDistRuntime copies current output and removes its source staging directory` and test `cleanCompiledOutputs removes the complete dist output tree` (their subjects are deleted) with:

```ts
test('sync-dist-runtime no longer stages, moves, or wipes compiled output', () => {
  const syncScript = fs.readFileSync(path.join('scripts', 'sync-dist-runtime.ts'), 'utf8');

  assert.doesNotMatch(syncScript, /cleanCompiledOutputs/u);
  assert.doesNotMatch(syncScript, /syncDistRuntime/u);
  assert.doesNotMatch(syncScript, /--clean/u);
  assert.match(syncScript, /ensureCliShebang/u);
});

test('package build:clean removes every incremental output tree', () => {
  const pkg = readPackageJson();

  assert.equal(
    String(pkg.scripts?.['build:clean']),
    'node --experimental-strip-types .\\scripts\\build-clean.ts',
  );
});
```

Leave untouched: `compiled runtime uses one flattened ESM package marker without aliases` (still valid: `dist/package.json` marker, no `dist/scripts/package.json`), `compiled test runner executes after source staging is removed` (asserts `dist/src` absent — remains true because it is never created), `native type-stripped source build scripts are warning-free…`, `explicit ESM source execution…`, and the `typecheck` equality test (the typecheck script string does not change).

- [ ] **Step 2: Run the changed tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js benchmark-spec-settings.test.ts 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and one-line root errors." }`

Expected: FAIL — build wiring assertions do not match current `package.json`/scripts.

- [ ] **Step 3: Rewrite `tsconfig.json` with a project reference**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "incremental": true,
    "tsBuildInfoFile": ".tscache/main-build.tsbuildinfo",
    "types": [
      "node"
    ]
  },
  "include": [
    "src/**/*.ts"
  ],
  "references": [
    { "path": "./packages/contracts" }
  ]
}
```

Notes: no `composite` on the root (five configs `extends` this file; inherited `composite` conflicts with their `noEmit`). `references` are not inherited via `extends`, so the extending configs stay plain typecheck projects. Removing `paths` means every config resolves `@siftkit/contracts` through the workspace symlink to `packages/contracts/dist` — contracts must be built before any typecheck, which `tsc -b` and the existing `typecheck` chain (starts with `tsc -b .\packages\contracts\tsconfig.json`) both guarantee.

- [ ] **Step 4: Rewrite `tsconfig.scripts.json` as typecheck-only**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "tsBuildInfoFile": ".tscache/scripts.tsbuildinfo",
    "rewriteRelativeImportExtensions": true
  },
  "include": [
    "src/types/better-sqlite3.d.ts",
    "scripts/build-clean.ts",
    "scripts/build-test.ts",
    "scripts/sync-dist-runtime.ts",
    "scripts/purge-temp-dirs.ts",
    "scripts/purge-temp-dirs-main.ts",
    "scripts/extract-invalid-action-corpus.ts",
    "scripts/report-invalid-action-rate.ts",
    "scripts/approval-red-team/**/*.ts"
  ]
}
```

The explicit `tsBuildInfoFile` override matters: without it this config would inherit `.tscache/main-build.tsbuildinfo` from the root and a bare `tsc -p tsconfig.scripts.json` would clobber the emitting build's state.

- [ ] **Step 5: Reduce `scripts/sync-dist-runtime.ts` to markers + shebang**

Full new content:

```ts
#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function writeRuntimePackageMarkers(distRoot: string): void {
  const runtimePackageJson = {
    type: 'module',
  };
  writeFileSync(
    join(distRoot, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    'utf8',
  );
}

const CLI_SHEBANG = '#!/usr/bin/env node\n';

/** npm's sh-shim executes dist/cli/main.js directly; without a shebang, sh parses ESM as shell. */
export function ensureCliShebang(distRoot: string): void {
  const mainPath = join(distRoot, 'cli', 'main.js');
  if (!existsSync(mainPath)) {
    throw new Error(`Expected CLI entry point at ${mainPath}; build layout changed.`);
  }
  const content = readFileSync(mainPath, 'utf8');
  if (content.startsWith(CLI_SHEBANG)) {
    return;
  }
  writeFileSync(mainPath, `${CLI_SHEBANG}${content}`, 'utf8');
}

function main(): void {
  const extraArgument = process.argv[2];
  if (extraArgument !== undefined) {
    throw new Error(`sync-dist-runtime no longer accepts arguments; got: ${extraArgument}`);
  }
  const repoRoot = resolve(import.meta.dirname, '..');
  const distRoot = join(repoRoot, 'dist');
  writeRuntimePackageMarkers(distRoot);
  ensureCliShebang(distRoot);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
```

(`tests/sync-dist-runtime-shebang.test.ts` keeps passing: `ensureCliShebang` is unchanged. The unknown-argument throw makes any missed `--clean` caller fail loudly.)

- [ ] **Step 6: Create `scripts/build-clean.ts`**

```ts
#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Escape hatch for corrupted incremental state: removes every build output and buildinfo. */
function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const targets = [
    join(repoRoot, 'dist'),
    join(repoRoot, '.tscache', 'main-build.tsbuildinfo'),
    join(repoRoot, 'packages', 'contracts', 'dist'),
    join(repoRoot, 'dashboard', 'dist'),
  ];
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
```

(Contracts' own `tsconfig.tsbuildinfo` lives inside `packages/contracts/dist`, so removing that directory clears it too.)

- [ ] **Step 7: Update `package.json` scripts**

```json
"start": "tsx .\\scripts\\start-dev.ts",
```
unchanged; change exactly these three entries:

```json
"build": "tsc -b .\\tsconfig.json && npm --prefix .\\dashboard run build && node --experimental-strip-types .\\scripts\\sync-dist-runtime.ts",
"build:clean": "node --experimental-strip-types .\\scripts\\build-clean.ts",
"purge:temp": "tsx .\\scripts\\purge-temp-dirs-main.ts",
```

(`tsc -b` builds `packages/contracts` first when stale, then the root project, emitting flat to `dist/`. The former explicit `npm --prefix packages/contracts run build` and `tsc -p tsconfig.scripts.json` invocations in `build` are gone. The dashboard build is stamped in Task 2.)

- [ ] **Step 8: Update `scripts/build-test.ts` full path**

Replace lines 186–196 (the `--clean` call through the second `tsc -p` call):

```ts
// OLD
  runTypeScriptScript(path.join('scripts', 'sync-dist-runtime.ts'), ['--clean']);
  resetTestBuildRoot();
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm_execpath is required to build test artifacts. Run npm run build:test.');
  }
  runCommand(process.execPath, [npmCliPath, '--prefix', path.join(repoRoot, 'packages', 'contracts'), 'run', 'build']);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.json')]);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.scripts.json')]);
  runTypeScriptScript(path.join('scripts', 'sync-dist-runtime.ts'), []);
```

```ts
// NEW
  resetTestBuildRoot();
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm_execpath is required to build test artifacts. Run npm run build:test.');
  }
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-b', path.join(repoRoot, 'tsconfig.json')]);
  runTypeScriptScript(path.join('scripts', 'sync-dist-runtime.ts'), []);
```

(`tsc -b` covers contracts; the scripts project is noEmit and belongs to `typecheck`, not artifact builds. The tests-only fast path at `build-test.ts:127-138` is untouched.)

- [ ] **Step 9: One-time migration clean + full build**

Run: `npm run build:clean; if ($?) { npm run build }`
Expected: contracts compiles, root project emits flat to `dist\cli`, `dist\status-server`, etc., dashboard Vite build runs, sync step writes `dist\package.json` + shebang. Zero errors.

Then verify the stale byproducts are gone and the layout is flat:

Run: `Test-Path dist\src; Test-Path dist\scripts; Test-Path dist\packages; Test-Path dist\cli\main.js; Test-Path dist\status-server\main.js; Get-Content dist\package.json`
Expected: `False False False True True` and `{"type": "module"}`.

- [ ] **Step 10: Verify incrementality**

Run: `Measure-Command { tsc -b .\tsconfig.json } | Select-Object TotalSeconds`
Expected: low single-digit seconds (up-to-date check only, no emit).

Touch one file and confirm a scoped rebuild:

Run: `(Get-Item src\cli\main.ts).LastWriteTime = Get-Date; tsc -b .\tsconfig.json; Test-Path dist\cli\main.js`
Expected: fast rebuild, True.

- [ ] **Step 11: Rebuild test artifacts and run the affected suites**

Run: `npm run build:test 2>&1 | siftkit summary --question "Return pass/fail and any errors with file anchors."`
Then: `node .\dist\test-runner\run-tests.js benchmark-spec-settings.test.ts sync-dist-runtime-shebang.test.ts package-artifact.test.ts 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors."`
Expected: PASS.

- [ ] **Step 12: Typecheck + lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and error categories with file:line."`
Expected: PASS (the `typecheck` script string itself is unchanged; the scripts config is now noEmit which its `--noEmit` flag already assumed).

- [ ] **Step 13: Commit**

```powershell
git add tsconfig.json tsconfig.scripts.json scripts/sync-dist-runtime.ts scripts/build-clean.ts scripts/build-test.ts package.json tests/benchmark-spec-settings.test.ts
git commit -m "build: replace dist flatten with tsc -b project references"
```

---

### Task 2: Dashboard content stamp

**Files:**
- Create: `scripts/dashboard-stamp.ts`
- Test: `tests/dashboard-stamp.test.ts`
- Modify: `package.json` (script `build`)
- Modify: `tsconfig.scripts.json` (include list)
- Modify: `tests/benchmark-spec-settings.test.ts` (build wiring test from Task 1 Step 1.2)

- [ ] **Step 1: Write the failing unit test**

`tests/dashboard-stamp.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { computeDashboardStamp } from '../scripts/dashboard-stamp.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function writeFixtureRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'dashboard', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'contracts', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'App.tsx'), 'export const App = 1;');
  fs.writeFileSync(path.join(root, 'packages', 'contracts', 'src', 'index.ts'), 'export const c = 1;');
  fs.writeFileSync(path.join(root, 'dashboard', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'dashboard', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'dashboard', 'vite.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(root, 'dashboard', 'tsconfig.json'), '{}');
}

test('computeDashboardStamp is deterministic for identical inputs', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);

  assert.equal(computeDashboardStamp(root), computeDashboardStamp(root));
});

test('computeDashboardStamp changes when a source file content changes', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  const before = computeDashboardStamp(root);

  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'App.tsx'), 'export const App = 2;');

  assert.notEqual(computeDashboardStamp(root), before);
});

test('computeDashboardStamp changes when a new source file appears', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  const before = computeDashboardStamp(root);

  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'New.tsx'), 'export const n = 1;');

  assert.notEqual(computeDashboardStamp(root), before);
});

test('computeDashboardStamp fails loudly when a pinned input file is missing', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  fs.rmSync(path.join(root, 'dashboard', 'index.html'));

  assert.throws(() => computeDashboardStamp(root), /Expected dashboard stamp input/u);
});
```

(`createManagedTempDir` is the existing helper at `tests/helpers/temp-dirs.ts`, already used by `benchmark-spec-settings.test.ts:25`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js dashboard-stamp.test.ts }`
Expected: FAIL — `scripts/dashboard-stamp.js` module not found.

- [ ] **Step 3: Implement `scripts/dashboard-stamp.ts`**

```ts
#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Skip-when-unchanged gate for the Vite production build. Vite cannot build
 * incrementally, so the whole dashboard build is skipped when every input that can
 * affect the bundle is byte-identical to the last stamped build.
 */
const INPUT_DIRECTORIES = [
  join('dashboard', 'src'),
  join('packages', 'contracts', 'src'),
] as const;

const INPUT_FILES = [
  join('dashboard', 'index.html'),
  join('dashboard', 'package.json'),
  join('dashboard', 'vite.config.ts'),
  join('dashboard', 'tsconfig.json'),
] as const;

function listFilesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

export function computeDashboardStamp(repoRoot: string): string {
  const inputPaths: string[] = [];
  for (const directory of INPUT_DIRECTORIES) {
    inputPaths.push(...listFilesRecursively(join(repoRoot, directory)));
  }
  for (const file of INPUT_FILES) {
    const filePath = join(repoRoot, file);
    if (!existsSync(filePath)) {
      throw new Error(`Expected dashboard stamp input: ${filePath}`);
    }
    inputPaths.push(filePath);
  }
  inputPaths.sort();

  const hash = createHash('sha256');
  for (const filePath of inputPaths) {
    hash.update(relative(repoRoot, filePath).replace(/\\/gu, '/'));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const stampPath = join(repoRoot, 'dashboard', 'dist', '.build-stamp');
  const stamp = computeDashboardStamp(repoRoot);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) {
    process.stdout.write('[dashboard-stamp] dashboard build is up to date; skipping vite build\n');
    return;
  }

  const npmCliPath = process.env.npm_execpath;
  if (npmCliPath === undefined) {
    throw new Error('npm_execpath is required to build the dashboard. Run via npm run build.');
  }
  const result = spawnSync(
    process.execPath,
    [npmCliPath, '--prefix', join(repoRoot, 'dashboard'), 'run', 'build'],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  writeFileSync(stampPath, stamp, 'utf8');
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
```

The stamp lives at `dashboard/dist/.build-stamp`, inside Vite's output directory: Vite empties `dashboard/dist` on build, so a fresh build always invalidates the previous stamp, and deleting the output by hand invalidates it too. The stamp is written only after a successful build.

- [ ] **Step 4: Wire into the build script**

`package.json`:

```json
"build": "tsc -b .\\tsconfig.json && node --experimental-strip-types .\\scripts\\dashboard-stamp.ts && node --experimental-strip-types .\\scripts\\sync-dist-runtime.ts",
```

`tsconfig.scripts.json` include list — add:

```json
    "scripts/dashboard-stamp.ts",
```

`tests/benchmark-spec-settings.test.ts` — extend the build wiring test from Task 1:

```ts
  assert.match(
    String(pkg.scripts?.build || ''),
    /node\s+--experimental-strip-types\s+\.\\scripts\\dashboard-stamp\.ts/u,
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js dashboard-stamp.test.ts benchmark-spec-settings.test.ts 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors." }`
Expected: PASS.

- [ ] **Step 6: Verify the skip behavior end-to-end**

Run: `npm run build` (builds dashboard, writes stamp), then `npm run build` again.
Expected: second run prints `[dashboard-stamp] dashboard build is up to date; skipping vite build` and finishes in seconds.

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and error categories with file:line."`
Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add scripts/dashboard-stamp.ts tests/dashboard-stamp.test.ts package.json tsconfig.scripts.json tests/benchmark-spec-settings.test.ts
git commit -m "build: gate dashboard vite build behind a content stamp"
```

---

### Task 3: Desktop toolchain + build in refresh-global

**Files:**
- Modify: `scripts/refresh-global.ps1` (insert after the workspace reconcile, before `Packing current repo`)
- Test: `tests/refresh-global-desktop.test.ts` (new)

- [ ] **Step 1: Write the failing wiring test**

`tests/refresh-global-desktop.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(path.join('scripts', 'refresh-global.ps1'), 'utf8');

test('refresh-global installs the Rust toolchain only when cargo-tauri is missing', () => {
  assert.match(script, /SIFTKIT_TOOLING_ROOT/u);
  assert.match(script, /cargo\\bin\\cargo-tauri\.exe/u);
  assert.match(script, /desktop:install-toolchain/u);
});

test('refresh-global builds the desktop shell before packing', () => {
  assert.match(script, /desktop:build/u);
  const desktopIndex = script.indexOf('desktop:build');
  const packIndex = script.indexOf('Packing current repo');
  assert.ok(desktopIndex >= 0 && packIndex >= 0 && desktopIndex < packIndex);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js refresh-global-desktop.test.ts }`
Expected: FAIL — no toolchain/desktop steps in the script yet.

- [ ] **Step 3: Implement the PowerShell changes**

In `scripts/refresh-global.ps1`, add this function next to the other helpers (mirrors `scripts/desktop/toolchain-paths.mjs`):

```powershell
function Get-SiftKitDesktopToolingRoot {
    if ($env:SIFTKIT_TOOLING_ROOT) {
        return $env:SIFTKIT_TOOLING_ROOT
    }

    Join-Path (Split-Path $script:RepoRoot -Parent) '.tooling\siftkit-gate-d'
}
```

Then insert between the `Reconciling workspace install` block and the `Packing current repo` block:

```powershell
$cargoTauriPath = Join-Path (Get-SiftKitDesktopToolingRoot) 'cargo\bin\cargo-tauri.exe'
if (-not (Test-Path -LiteralPath $cargoTauriPath)) {
    Write-Host 'Portable Rust toolchain missing; installing...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop:install-toolchain') -Description 'Installing the desktop Rust toolchain' -MaxAttempts 1
}

Write-Host 'Building the desktop shell...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop:build') -Description 'Building the desktop shell' -MaxAttempts 1
```

(`-MaxAttempts 1`: cargo/rustup failures are never the Windows npm file-lock condition the retry loop exists for, and a failed multi-minute build must not run four times.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js refresh-global-desktop.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/refresh-global.ps1 tests/refresh-global-desktop.test.ts
git commit -m "build: provision Rust toolchain and build desktop shell in refresh-global"
```

---

### Task 4: Full validation

No new code. Evidence before completion claims.

- [ ] **Step 1: Clean-slate double build**

Run: `npm run build:clean; if ($?) { npm run build }` then `Measure-Command { npm run build } | Select-Object TotalSeconds`
Expected: first build full; second build seconds (tsc up-to-date, dashboard stamp skip, sync markers only).

- [ ] **Step 2: Full test suite**

Run: `npm run build:test; if ($?) { npm test 2>&1 | siftkit summary --question "Return overall pass/fail, count, every failing test name with its root error and file:line." }`
Expected: green. Investigate any failure directly (raw output allowed for a named failing test).

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and error categories with file:line."`
Expected: PASS (this script already chains lint).

- [ ] **Step 4: refresh-global end-to-end**

Run `npm run refresh-global` in the background (first `cargo tauri build` may take many minutes; it downloads NSIS/WiX once). The script stops the *global* status server itself; the repo dev server on :4765 stays untouched.
Expected: toolchain detected (already installed at `..\.tooling\siftkit-gate-d`), desktop build succeeds (`desktop\src-tauri\target\release\siftkit-assistant-shell.exe` + `bundle\` installers), pack + global install + all smoke checks pass.

- [ ] **Step 5: Confirm tarball layout**

Run: `node .\dist\test-runner\run-tests.js package-artifact.test.ts`
Expected: PASS — `node_modules/@siftkit/contracts/dist/index.js` still vendored. (The tarball also *loses* the stale `dist/scripts/**` and `dist/packages/**` byproducts — an intentional shrink, not a regression.)

- [ ] **Step 6: Report**

State result, changed files, validation evidence, risks (stale-buildinfo escape hatch = `npm run build:clean`).
