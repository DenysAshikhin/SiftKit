# Test Temp-Directory Leak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the test suite leaking temp directories into `%LOCALAPPDATA%\Temp`, purge the ~40,000 already there, and add a gate that keeps new leaks out.

**Architecture:** One shared `TempDirRegistry` helper owns every temp directory a test creates and removes them from a `node:test` `after()` hook, so a test cannot forget. `removeDirectoryWithRetries` stops swallowing failures — it reports what it could not delete instead of returning silently. A static hygiene gate bans bare `fs.mkdtempSync` in `tests/**`, forcing the helper. A standalone purge script clears the existing backlog.

**Tech Stack:** TypeScript (strict, no casts, no `any`, no `!`), `node:test` + `node:assert/strict`, `node:fs`.

**Measured baseline (2026-07-31):** `npm test` is green — 1950 tests, 1948 pass, 2 skipped, 0 fail, 46 s, exit 0. There is no deadlock to fix. One green run leaks **452** directories:

| prefix | leaked per run | cause |
|---|---|---|
| `siftkit-repo-tools` | 152 | `makeRepo()` called 42×, only 3 `rmSync` in the file |
| `siftkit-node-test` | 71 | cleanup runs but `removeDirectoryWithRetries` fails and swallows it |
| `siftkit-repo-search-ignore` | 57 | no cleanup |
| `siftkit-test` | 48 | no cleanup |
| `siftkit-mock-loop` | 9 | no cleanup |
| ~26 other prefixes | 2–8 each | no cleanup |

Backlog on disk: 23,030 `siftkit-node-test-*` (~0.69 GB) plus ~16,000 under other `siftkit-*` prefixes, oldest 2026-03-19.

**Test command shape:** `npm run build:test && node .\dist\scripts\run-tests.js <suite-name>` where `<suite-name>` is the test file basename without `.test.ts`. Full suite: `npm test`. Typecheck (tsc ×7 + eslint): `npm run typecheck`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `tests/helpers/temp-dirs.ts` | `TempDirRegistry` + `createManagedTempDir`: makes a temp dir and guarantees its removal after the file's tests finish. |
| `tests/temp-dirs.test.ts` | Unit coverage for the registry. |
| `scripts/purge-temp-dirs.ts` | One-shot purge of leftover `siftkit-*` directories in the OS temp dir. |

**Modified:** `tests/helpers/dashboard-http.ts`, `tests/repo-tools.test.ts`, `tests/_runtime-helpers.ts`, `tests/test-hygiene-gate.test.ts`, `package.json`.

---

## Task 1: The managed temp-directory registry

**Files:**
- Create: `tests/helpers/temp-dirs.ts`
- Test: `tests/temp-dirs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/temp-dirs.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TempDirRegistry } from './helpers/temp-dirs.js';

test('TempDirRegistry creates a directory under the OS temp dir', () => {
  const registry = new TempDirRegistry();
  try {
    const dir = registry.create('siftkit-registry-test-');
    assert.equal(fs.existsSync(dir), true);
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(dir), /^siftkit-registry-test-/u);
  } finally {
    registry.removeAll();
  }
});

test('TempDirRegistry.removeAll deletes every directory it handed out', () => {
  const registry = new TempDirRegistry();
  const first = registry.create('siftkit-registry-test-');
  const second = registry.create('siftkit-registry-test-');
  fs.writeFileSync(path.join(first, 'nested.txt'), 'content', 'utf8');
  fs.mkdirSync(path.join(second, 'sub'));

  registry.removeAll();

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test('TempDirRegistry.removeAll forgets directories so a second call is a no-op', () => {
  const registry = new TempDirRegistry();
  const dir = registry.create('siftkit-registry-test-');
  registry.removeAll();
  assert.equal(registry.pendingCount, 0);
  registry.removeAll();
  assert.equal(fs.existsSync(dir), false);
});

test('TempDirRegistry.removeAll reports directories it could not delete', () => {
  const registry = new TempDirRegistry();
  const dir = registry.create('siftkit-registry-test-');
  // Deleting it out from under the registry is the closest portable stand-in for a
  // locked directory: the path is gone, so removal must still succeed silently.
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(registry.removeAll(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js temp-dirs`
Expected: FAIL — `Cannot find module './helpers/temp-dirs.js'`

- [ ] **Step 3: Implement the registry**

Create `tests/helpers/temp-dirs.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const REMOVE_ATTEMPTS = 40;
const REMOVE_DELAY_MS = 100;

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Owns every temp directory a test file creates so none can be forgotten. Windows holds
 * handles open briefly after a sqlite connection or a child process closes, so removal
 * retries; anything still undeletable at the end is returned rather than swallowed.
 */
export class TempDirRegistry {
  private readonly directories: string[] = [];

  get pendingCount(): number {
    return this.directories.length;
  }

  create(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    this.directories.push(directory);
    return directory;
  }

  /** Removes every registered directory. Returns the ones that survived. */
  removeAll(): string[] {
    const survivors: string[] = [];
    for (const directory of this.directories) {
      if (!this.remove(directory)) {
        survivors.push(directory);
      }
    }
    this.directories.length = 0;
    return survivors;
  }

  private remove(directory: string): boolean {
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
        return true;
      } catch {
        if (attempt === REMOVE_ATTEMPTS - 1) {
          return false;
        }
        waitSync(REMOVE_DELAY_MS);
      }
    }
    return false;
  }
}

const fileRegistry = new TempDirRegistry();

after(() => {
  const survivors = fileRegistry.removeAll();
  if (survivors.length > 0) {
    // Loud, not fatal: a locked directory is an environment problem, and failing the
    // run here would hide whatever the test itself proved.
    process.stderr.write(
      `\nTEMP DIRECTORIES LEFT BEHIND by ${process.argv[1]}:\n`
      + survivors.map((directory) => `  - ${directory}\n`).join(''),
    );
  }
});

/**
 * Creates a temp directory that is removed automatically once this test file finishes.
 * Every test that needs a scratch directory must use this instead of `fs.mkdtempSync`,
 * which `tests/test-hygiene-gate.test.ts` enforces.
 */
export function createManagedTempDir(prefix: string): string {
  return fileRegistry.create(prefix);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\scripts\run-tests.js temp-dirs`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/temp-dirs.ts tests/temp-dirs.test.ts
git commit -m "test: add a managed temp-directory registry"
```

---

## Task 2: Stop `removeDirectoryWithRetries` swallowing failures

**Files:**
- Modify: `tests/helpers/dashboard-http.ts:210-222`
- Test: `tests/dashboard-http-helpers.test.ts`

This is the `siftkit-node-test` leak: `runWithTempEnv` always calls this helper, and it returns
normally whether or not the directory is gone.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-http-helpers.test.ts` (match the file's existing import style; it
already imports `removeDirectoryWithRetries`):

```typescript
test('removeDirectoryWithRetries reports whether the directory is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-remove-report-'));
  assert.equal(await removeDirectoryWithRetries(dir), true);
  assert.equal(fs.existsSync(dir), false);
});

test('removeDirectoryWithRetries returns true for a path that never existed', async () => {
  const missing = path.join(os.tmpdir(), 'siftkit-remove-report-absent-does-not-exist');
  assert.equal(await removeDirectoryWithRetries(missing), true);
});
```

Add `import os from 'node:os';` and `import path from 'node:path';` at the top of that file if
they are not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js dashboard-http-helpers`
Expected: FAIL — `Expected values to be strictly equal: undefined !== true`

- [ ] **Step 3: Implement**

In `tests/helpers/dashboard-http.ts`, replace the whole function at line 210:

```typescript
/**
 * Removes a directory, retrying while Windows releases handles. Returns whether the path is
 * actually gone; callers that leak temp directories depend on the answer, so it is never
 * swallowed.
 */
export async function removeDirectoryWithRetries(
  targetPath: string,
  attempts: number = 40,
  delayMs: number = 100,
): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return true;
    } catch {
      if (index === attempts - 1) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
```

- [ ] **Step 4: Report the failure at the one call site that leaks**

In `tests/_runtime-helpers.ts`, in the `cleanup` closure inside `runWithTempEnv` (the
`await removeDirectoryWithRetries(tempRoot);` line), replace it with:

```typescript
    if (!await removeDirectoryWithRetries(tempRoot)) {
      process.stderr.write(`\nTEMP DIRECTORY LEFT BEHIND: ${tempRoot}\n`);
    }
```

Add `removeDirectoryWithRetries` to that file's existing import from
`./helpers/dashboard-http.js` if it is imported from elsewhere or not yet imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js dashboard-http-helpers dashboard-status-server`
Expected: PASS. Every other caller ignores the new return value, which is valid TypeScript, so
no other call site needs to change.

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/dashboard-http.ts tests/_runtime-helpers.ts tests/dashboard-http-helpers.test.ts
git commit -m "test: report undeletable temp directories instead of swallowing"
```

---

## Task 3: Fix `repo-tools.test.ts` — the largest leak

**Files:**
- Modify: `tests/repo-tools.test.ts:20-33`
- Test: `tests/repo-tools.test.ts` (its own existing suite is the regression check)

42 `makeRepo()` calls, 3 `rmSync`. Routing `makeRepo` through the registry fixes all 42 at once
without touching a single test body.

- [ ] **Step 1: Route `makeRepo` through the registry**

In `tests/repo-tools.test.ts`, add the import next to the existing ones:

```typescript
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

Replace the first line of `makeRepo` (line 21):

```typescript
function makeRepo(): string {
  const root = createManagedTempDir('siftkit-repo-tools-');
```

Leave the rest of `makeRepo` and every test body unchanged.

- [ ] **Step 2: Remove the now-redundant manual cleanups**

The three existing `fs.rmSync(root, { recursive: true, force: true });` calls in this file are
now handled by the registry. Deleting them is optional and they are harmless — the registry
tolerates an already-deleted path. Leave them; removing them is churn with no benefit.

- [ ] **Step 3: Run the suite and confirm the leak is gone**

```bash
npm run build:test
ls "$LOCALAPPDATA/Temp" | grep -c "^siftkit-repo-tools-" || true
node .\dist\scripts\run-tests.js repo-tools
ls "$LOCALAPPDATA/Temp" | grep -c "^siftkit-repo-tools-" || true
```

Expected: the suite passes, and the two counts are identical. Before this change the second
count was 152 higher.

- [ ] **Step 4: Commit**

```bash
git add tests/repo-tools.test.ts
git commit -m "test: stop repo-tools leaking a temp repo per test"
```

---

## Task 4: Fix the remaining leaking test files

**Files:**
- Modify: every `tests/**/*.test.ts` and `tests/helpers/*.ts` that calls `fs.mkdtempSync`

- [ ] **Step 1: List the files to convert**

```bash
cd c:\Users\denys\Documents\GitHub\SiftKit
grep -rln "mkdtempSync" tests/
```

Every hit except `tests/helpers/temp-dirs.ts` (the registry itself) and
`tests/temp-dirs.test.ts` (which tests the registry directly) must be converted.

- [ ] **Step 2: Convert each file mechanically**

In each file, add:

```typescript
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

(from `tests/helpers/*.ts` the specifier is `./temp-dirs.js`), then replace every

```typescript
fs.mkdtempSync(path.join(os.tmpdir(), 'some-prefix-'))
```

with

```typescript
createManagedTempDir('some-prefix-')
```

Keep the prefix string exactly as it was — the prefixes are how the leak was traced and how
Task 6 verifies the fix. Leave any existing `rmSync`/`removeDirectoryWithRetries` teardown in
place; the registry is idempotent and tolerates an already-removed path. Do **not** delete a
test's own cleanup, because some tests assert on the directory being gone mid-test.

If a file imports `os` or `path` solely for the `mkdtempSync` line, remove the now-unused
import — `npm run typecheck` runs eslint and will flag it.

- [ ] **Step 3: Run the full suite**

Run: `npm run build:test && npm test`
Expected: PASS — 1950 tests, 0 fail (2 skipped), matching the baseline.

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: route every temp directory through the managed registry"
```

---

## Task 5: Gate against new bare `mkdtempSync`

**Files:**
- Modify: `tests/test-hygiene-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/test-hygiene-gate.test.ts`, matching the existing `filesMatching` style:

```typescript
// Temp directories must come from the registry in tests/helpers/temp-dirs.ts, which removes
// them in an after() hook. A bare mkdtempSync depends on the test remembering to clean up,
// and 42 calls in one file with 3 cleanups is how ~40,000 directories accumulated.
test('hygiene: no test creates a temp directory outside the managed registry', () => {
  const allowed = new Set([
    path.join(TESTS_DIR, 'helpers', 'temp-dirs.ts'),
    path.join(TESTS_DIR, 'temp-dirs.test.ts'),
    path.join(TESTS_DIR, 'dashboard-http-helpers.test.ts'),
  ]);
  const offenders = filesMatching(/mkdtempSync/).filter((file) => !allowed.has(file));
  assert.deepEqual(offenders, []);
});
```

`tests/dashboard-http-helpers.test.ts` is allowed because Task 2's tests must create a directory
the registry does not own in order to assert on removal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js test-hygiene-gate`
Expected: FAIL if any file from Task 4 was missed, listing them. If Task 4 was complete, this
passes immediately — that is the intended outcome, and it locks the invariant in.

- [ ] **Step 3: Fix any file the gate names**

Convert it exactly as in Task 4 Step 2, then re-run until PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test-hygiene-gate.test.ts
git commit -m "test: gate against temp directories outside the registry"
```

---

## Task 6: Purge the existing backlog

**Files:**
- Create: `scripts/purge-temp-dirs.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Create `scripts/purge-temp-dirs.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Removes leftover `siftkit-*` directories from the OS temp dir. The suite used to leak
 * roughly 450 per run; this clears whatever accumulated before the registry landed.
 *
 * Only directories whose name starts with `siftkit-` are touched, and by default only those
 * untouched for an hour, so a concurrent test run is never disturbed.
 */
const PREFIX = 'siftkit-';
const DEFAULT_MIN_AGE_MINUTES = 60;

function parseMinAgeMinutes(argv: string[]): number {
  const index = argv.indexOf('--min-age-minutes');
  if (index === -1) {
    return DEFAULT_MIN_AGE_MINUTES;
  }
  const raw = argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --min-age-minutes value: ${raw}`);
  }
  return parsed;
}

const minAgeMinutes = parseMinAgeMinutes(process.argv.slice(2));
const cutoff = Date.now() - minAgeMinutes * 60_000;
const tempRoot = fs.realpathSync(os.tmpdir());

let removed = 0;
let skipped = 0;
let failed = 0;

for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) {
    continue;
  }
  const directory = path.join(tempRoot, entry.name);
  let modifiedAtMs: number;
  try {
    modifiedAtMs = fs.statSync(directory).mtimeMs;
  } catch {
    skipped += 1;
    continue;
  }
  if (modifiedAtMs > cutoff) {
    skipped += 1;
    continue;
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    removed += 1;
  } catch {
    failed += 1;
  }
}

process.stdout.write(
  `purge-temp-dirs: removed=${removed} skipped=${skipped} failed=${failed} root=${tempRoot}\n`,
);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `scripts` next to the other `node .\dist\scripts\...` entries:

```json
    "purge:temp": "node .\\dist\\scripts\\purge-temp-dirs.js",
```

- [ ] **Step 3: Build and run it**

```bash
npm run build:test
node .\dist\scripts\purge-temp-dirs.js
```

Expected: a line like `purge-temp-dirs: removed=39000 skipped=12 failed=3 root=...`. A non-zero
`failed` count is fine — those are directories another process still holds; re-run later.

- [ ] **Step 4: Confirm the reclaim**

```bash
ls "$LOCALAPPDATA/Temp" | grep -c "^siftkit-" || true
```

Expected: a small number (only directories newer than the age cutoff), down from ~39,000.

- [ ] **Step 5: Commit**

```bash
git add scripts/purge-temp-dirs.ts package.json
git commit -m "chore: add a purge script for leaked test temp directories"
```

---

## Task 7: Prove the leak is closed

**Files:** none — this is the acceptance check for the whole plan.

- [ ] **Step 1: Count, run the full suite, count again**

```bash
cd c:\Users\denys\Documents\GitHub\SiftKit
ls "$LOCALAPPDATA/Temp" | grep -c "^siftkit-" || true
npm test
ls "$LOCALAPPDATA/Temp" | grep -c "^siftkit-" || true
```

Expected: the suite reports 1950 tests / 0 fail, and **the two counts are equal**. Before this
plan the second count was 452 higher.

- [ ] **Step 2: Confirm nothing was left behind loudly**

The run's stderr must contain no `TEMP DIRECTORIES LEFT BEHIND` or `TEMP DIRECTORY LEFT BEHIND`
lines. If it does, the named directory is genuinely locked — identify which handle holds it
(usually a sqlite connection closed after the `after()` hook, or a child process that outlived
its test) and fix that test rather than widening the retry window.

- [ ] **Step 3: Confirm the gate holds**

Run: `npm run build:test && node .\dist\scripts\run-tests.js test-hygiene-gate`
Expected: PASS

Run: `npm run typecheck`
Expected: exit 0

---

## Explicitly out of scope

- **The `npm test` deadlock.** It no longer reproduces. Measured 2026-07-31: 1950 tests, 0 fail,
  46 s, exit 0. The ~40 zombie processes seen on 2026-07-29 came from an older arrangement that
  preloaded `tests/live-instance-guard.ts` through `NODE_OPTIONS`, which dragged the tsx loader
  into every spawned CLI. Moving the guard to the precompiled `scripts/live-instance-guard.js`
  already fixed it; the comment at `scripts/run-tests.ts:9-20` records why. No task here
  re-litigates that.
- **Reducing how many temp directories the suite creates.** 452 per run is fine once they are
  cleaned up; consolidating fixtures is a separate refactor with its own risk.
- **`bench/` and `src/` `mkdtempSync` calls.** The registry is a `node:test` helper and depends
  on `after()`. Production code that makes temp directories needs its own lifecycle and is not
  part of this leak.
