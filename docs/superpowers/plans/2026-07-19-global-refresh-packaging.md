# Self-Contained Global Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run refresh-global` install a self-contained SiftKit tarball through one authoritative npm path.

**Architecture:** npm will bundle the private `@siftkit/contracts` workspace package inside the root artifact. The refresh script will pack, stop the old global server, install the tarball, resolve the npm shim, and smoke-test it without switching to a second installer.

**Tech Stack:** npm workspaces and package artifacts, TypeScript, Node.js test runner, PowerShell.

## Global Constraints

- `@siftkit/contracts` remains private and is not published separately.
- The tarball must contain `package/node_modules/@siftkit/contracts/dist/index.js`.
- `refresh-global.ps1` must surface npm failures directly and must not invoke shell integration as a fallback.
- The explicit public `Install-SiftKitShellIntegration` command remains unchanged.
- Production changes follow TDD and introduce no compatibility shim.
- Preserve unrelated untracked workspace files.

---

### Task 1: Bundle the contracts workspace in the package artifact

**Files:**
- Create: `tests/package-artifact.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: npm's `bundleDependencies` package metadata and the compiled `packages/contracts/dist/index.js` artifact produced by the existing build.
- Produces: a root npm tarball containing `package/node_modules/@siftkit/contracts/dist/index.js`.

- [ ] **Step 1: Write failing metadata and artifact tests**

Create `tests/package-artifact.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseJsonText } from '../src/lib/json.js';
import { z } from '../src/lib/zod.js';

const PackageMetadataSchema = z.object({
  bundleDependencies: z.array(z.string()).optional(),
});

const PackOutputSchema = z.array(z.object({
  files: z.array(z.object({ path: z.string() })),
}));

const repoRoot = path.resolve(__dirname, '..');

test('package metadata bundles the private contracts workspace', () => {
  const packageJson = parseJsonText(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    PackageMetadataSchema,
  );

  assert.deepEqual(packageJson.bundleDependencies, ['@siftkit/contracts']);
});

test('npm pack includes the compiled contracts entrypoint', () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr);

  const artifacts = parseJsonText(result.stdout, PackOutputSchema);
  const artifact = artifacts[0];
  assert.ok(artifact);

  let contractsEntrypointFound = false;
  for (const file of artifact.files) {
    if (file.path === 'node_modules/@siftkit/contracts/dist/index.js') {
      contractsEntrypointFound = true;
      break;
    }
  }
  assert.equal(contractsEntrypointFound, true);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js package-artifact.test.ts
```

Expected: both tests fail because `bundleDependencies` is absent and the dry-run tarball omits the contracts entrypoint.

- [ ] **Step 3: Add the bundled dependency metadata**

Add this root field to `package.json` without changing the existing workspace dependency version:

```json
"bundleDependencies": [
  "@siftkit/contracts"
]
```

Refresh only lockfile metadata:

```powershell
npm install --package-lock-only --ignore-scripts
```

Confirm the root package entry in `package-lock.json` now records:

```json
"bundleDependencies": [
  "@siftkit/contracts"
]
```

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js package-artifact.test.ts
```

Expected: 2 tests pass, 0 fail. The dry-run artifact lists `node_modules/@siftkit/contracts/dist/index.js`.

- [ ] **Step 5: Commit the self-contained artifact**

```powershell
git add -- tests/package-artifact.test.ts package.json package-lock.json
git commit -m "fix: bundle contracts in package artifact"
```

---

### Task 2: Remove the automatic shell-installer fallback

**Files:**
- Create: `tests/refresh-global-script.test.ts`
- Modify: `scripts/refresh-global.ps1`

**Interfaces:**
- Consumes: the tarball name from `Get-SiftKitPackageTarballName` and the existing retryable npm command helper.
- Produces: a single global-refresh flow that throws the original npm error on failure and resolves only npm's global shim.

- [ ] **Step 1: Write the failing single-path regression**

Create `tests/refresh-global-script.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'refresh-global.ps1');

test('global refresh uses only the npm tarball installation path', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /Install-SiftKitViaShellIntegration/u);
  assert.doesNotMatch(script, /Falling back to Install-SiftKitShellIntegration/u);
  assert.doesNotMatch(script, /^catch\s*\{/mu);
  assert.match(
    script,
    /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$tarballName, '--force', '--loglevel', 'error'\)/u,
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js refresh-global-script.test.ts
```

Expected: FAIL because the script still defines and invokes `Install-SiftKitViaShellIntegration` from its catch block.

- [ ] **Step 3: Remove the fallback and keep the npm flow linear**

Delete `Install-SiftKitViaShellIntegration` from `scripts/refresh-global.ps1`. Replace the bottom-level `try`/`catch` installation block with this linear flow:

```powershell
$tarballName = Get-SiftKitPackageTarballName

Write-Host 'Packing current repo...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('pack', '--loglevel', 'error') -Description 'Packing current repo'

Stop-ExistingGlobalSiftKitStatusServer

Write-Host 'Installing packed tarball globally...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('i', '-g', $tarballName, '--force', '--loglevel', 'error') -Description 'Installing packed tarball globally'

Write-Host 'Resolving freshly installed global siftkit command...'
$globalSiftKit = Get-GlobalSiftKitCommandPath
```

Leave the existing CLI smoke checks after this block unchanged.

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js refresh-global-script.test.ts
```

Expected: 1 test passes, 0 fail.

- [ ] **Step 5: Run both packaging regressions**

```powershell
node .\dist\scripts\run-tests.js package-artifact.test.ts refresh-global-script.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Commit the single-path refresh script**

```powershell
git add -- tests/refresh-global-script.test.ts scripts/refresh-global.ps1
git commit -m "fix: remove global refresh fallback"
```

---

### Task 3: Validate the packed global installation

**Files:**
- Verify only; no planned file changes.

**Interfaces:**
- Consumes: the bundled package artifact and single-path refresh script from Tasks 1 and 2.
- Produces: a working global `siftkit` command whose public help surfaces load without registry access to `@siftkit/contracts`.

- [ ] **Step 1: Run the real global refresh**

```powershell
npm run refresh-global
```

Expected: pack and global npm installation succeed without `E404`, no fallback warning appears, and both built-in public CLI smoke checks pass.

- [ ] **Step 2: Verify the installed contracts package**

```powershell
$globalPrefix = (npm prefix -g).Trim()
Test-Path (Join-Path $globalPrefix 'node_modules\siftkit\node_modules\@siftkit\contracts\dist\index.js')
```

Expected: `True`.

- [ ] **Step 3: Run full repository validation**

```powershell
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass except the intentional POSIX-only skip on Windows; typecheck and lint pass; diff check reports no whitespace errors.

- [ ] **Step 4: Audit managed processes**

```powershell
$managed = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -match '(?i)siftkit|llama-server|tabbyapi|start-dev\.ts|status-server'
})
$managed.Count
```

Expected: `0`. If validation leaves a process, identify its owning test and fix teardown before completion.

- [ ] **Step 5: Confirm final repository state**

```powershell
git status --short --branch
git log -5 --oneline
```

Expected: the two implementation commits are on `main`; only the pre-existing unrelated untracked plan remains.
