# Test Temp-Directory Leak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the test suite leaking temp directories into `%LOCALAPPDATA%\Temp`, purge the ~58,000 already there, and add a gate that keeps new leaks out.

**Architecture:** One shared `TempDirRegistry` owns every temp directory a test creates and removes them from a `process.on('exit')` handler, so a test cannot forget. All directory-removal retry logic lives in one module — `removeDirectoryWithRetries` moves there, stops swallowing failures, and shares its single-attempt primitive with the registry's synchronous variant. A static hygiene gate bans bare `fs.mkdtempSync` in `tests/**`, forcing the helper. A standalone purge script clears the existing backlog.

**Tech Stack:** TypeScript (strict, no casts, no `any`, no `!`), `node:test` + `node:assert/strict`, `node:fs`.

---

## Measured baseline (2026-07-31, green tree)

`npm test`: **1950 tests, 1948 pass, 2 skipped, 0 fail, 46.2 s, exit 0.** There is no deadlock to fix.

One green run leaks **113** top-level directories across 32 prefixes:

| prefix | leaked per run | cause |
|---|---|---|
| `siftkit-repo-tools` | 38 | `makeRepo()` called 42×, only 3 `rmSync` in the file |
| `siftkit-node-test` | 18 | cleanup runs but `removeDirectoryWithRetries` fails and swallows it |
| `siftkit-repo-search-ignore` | 14 | no cleanup |
| `siftkit-test` | 12 | no cleanup |
| `siftkit-usage` / `siftkit-mock-loop` / `siftkit-dashboard-benchmark` | 2 each | no cleanup |
| 25 other prefixes | 1 each | no cleanup |

Counted as the set difference of `ls -1 "$LOCALAPPDATA/Temp"` before and after a full run, matching top-level entries against `^siftkit-`. **Count top-level entries only** — a recursive count inflates every figure roughly 4× because `makeRepo` and friends build nested directories inside each temp root.

Backlog on disk: **58,510** `siftkit-*` directories, of which 23,030 are `siftkit-node-test-*` (~0.69 GB). Oldest 2026-03-19.

### Why `siftkit-node-test` fails to clean up

Not "Windows briefly holds handles". Probed on this machine:

- An **open file handle does not block** `fs.rmSync` — it succeeds.
- A **live child process whose `cwd` is inside the directory** makes `fs.rmSync` throw **`EPERM`**, indefinitely, for as long as that process lives.

So the 18 leaks are spawned CLIs outliving the cleanup, and no retry window fixes them — the child has to be dead first. Moving cleanup to `process.on('exit')` (Task 1) gets it for free in every case where the child dies with the test file; anything still surviving is a genuine process leak and Task 7 requires it be reported loudly and fixed at the test, not retried harder.

### Why `process.on('exit')` and not `after()`

Probed with `node --test`. Root `after()` hooks run **in registration order**, and a hook registered from inside a test body runs **before** all of them:

```
TEST-BODY
HOOK-C-lazy-from-inside-test
HOOK-A-import-time
HOOK-B-file-teardown
```

An `after()` registered when `temp-dirs.ts` is imported therefore runs **before** the test file's own teardown — before the server is closed or the child is killed — so cleanup would race exactly the thing that holds the directory, and a later hook cannot run until the earlier one resolves. `process.on('exit')` runs after every root hook:

```
TEST-BODY
AFTER-teardown
EXIT-HOOK removed=true
```

Exit handlers are synchronous-only, which is why the registry needs `removeDirectorySync` alongside the async `removeDirectoryWithRetries`. The two share `tryRemoveDirectory`; only the wait differs.

**Test command shape:** `npm run build:test && node .\dist\scripts\run-tests.js <suite-name>` where `<suite-name>` is the test file basename without `.test.ts`. Full suite: `npm test`. Typecheck (tsc ×7 + eslint): `npm run typecheck`.

Tests run from **source** via the tsx loader (`dist/tests` is empty), so `__dirname` inside a test is the `tests/` source directory.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `tests/helpers/temp-dirs.ts` | `tryRemoveDirectory`, `removeDirectorySync`, `removeDirectoryWithRetries`, `TempDirRegistry`, `createManagedTempDir`. The single home for temp-directory lifecycle. |
| `tests/temp-dirs.test.ts` | Coverage for the registry and both removal wrappers, including the failure branch. |
| `scripts/purge-temp-dirs.ts` | One-shot purge of leftover `siftkit-*` directories in the OS temp dir. |
| `tests/purge-temp-dirs.test.ts` | Coverage for the purge script's selection rules. |

**Modified:** `tests/helpers/dashboard-http.ts`, `tests/_runtime-helpers.ts`, `tests/repo-tools.test.ts`, `tests/test-hygiene-gate.test.ts`, `package.json`, and the 7 other files importing `removeDirectoryWithRetries`.

---

## Task 1: The temp-directory module

**Files:**
- Create: `tests/helpers/temp-dirs.ts`
- Test: `tests/temp-dirs.test.ts`

`removeDirectoryWithRetries` moves here from `tests/helpers/dashboard-http.ts` (an HTTP helper is the wrong home for it) and starts returning whether the path is gone. Task 2 repoints its 8 importers. No re-export is left behind.

- [ ] **Step 1: Write the failing tests**

Create `tests/temp-dirs.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  TempDirRegistry,
  removeDirectorySync,
  removeDirectoryWithRetries,
} from './helpers/temp-dirs.js';

/**
 * Returns a directory that cannot be removed, and the kill switch that frees it. A live child
 * process whose cwd is the directory is the only thing that reliably makes fs.rmSync throw
 * EPERM on Windows — an open file handle does not.
 */
async function lockDirectory(): Promise<{ directory: string; release: () => void }> {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-lock-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    cwd: directory,
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    directory,
    release: (): void => {
      child.kill();
    },
  };
}

test('TempDirRegistry creates a directory under the OS temp dir', () => {
  const registry = new TempDirRegistry();
  try {
    const directory = registry.create('siftkit-registry-test-');
    assert.equal(fs.existsSync(directory), true);
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^siftkit-registry-test-/u);
    assert.equal(registry.pendingCount, 1);
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

  assert.deepEqual(registry.removeAll(), []);

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test('TempDirRegistry.removeAll forgets directories so a second call is a no-op', () => {
  const registry = new TempDirRegistry();
  const directory = registry.create('siftkit-registry-test-');
  registry.removeAll();
  assert.equal(registry.pendingCount, 0);
  assert.deepEqual(registry.removeAll(), []);
  assert.equal(fs.existsSync(directory), false);
});

test('TempDirRegistry.removeAll tolerates a directory deleted out from under it', () => {
  const registry = new TempDirRegistry();
  const directory = registry.create('siftkit-registry-test-');
  fs.rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(registry.removeAll(), []);
});

test('TempDirRegistry.removeAll returns the directories it could not delete', async () => {
  const locked = await lockDirectory();
  const registry = new TempDirRegistry();
  const removable = registry.create('siftkit-registry-test-');
  registry.adopt(locked.directory);

  const survivors = registry.removeAll(2, 10);

  assert.deepEqual(survivors, [locked.directory]);
  assert.equal(fs.existsSync(removable), false);
  assert.equal(registry.pendingCount, 0);

  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(locked.directory, { recursive: true, force: true });
});

test('removeDirectorySync reports success and failure', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-sync-'));
  assert.equal(removeDirectorySync(directory, 2, 10), true);
  assert.equal(fs.existsSync(directory), false);

  const locked = await lockDirectory();
  assert.equal(removeDirectorySync(locked.directory, 2, 10), false);
  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(locked.directory, { recursive: true, force: true });
});

test('removeDirectoryWithRetries reports success and failure', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-async-'));
  assert.equal(await removeDirectoryWithRetries(directory, 2, 10), true);
  assert.equal(fs.existsSync(directory), false);

  const missing = path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-async-absent-does-not-exist');
  assert.equal(await removeDirectoryWithRetries(missing, 2, 10), true);

  const locked = await lockDirectory();
  assert.equal(await removeDirectoryWithRetries(locked.directory, 2, 10), false);
  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(locked.directory, { recursive: true, force: true });
});
```

Every branch is covered: both wrappers succeed and fail, `removeAll` returns empty and non-empty, and the already-deleted path is exercised. The `attempts`/`delayMs` arguments keep the failure cases at ~10 ms instead of 4 s.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node .\dist\scripts\run-tests.js temp-dirs`
Expected: FAIL — `Cannot find module './helpers/temp-dirs.js'`

- [ ] **Step 3: Implement**

Create `tests/helpers/temp-dirs.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYNC_ATTEMPTS = 20;
const SYNC_DELAY_MS = 25;
const ASYNC_ATTEMPTS = 40;
const ASYNC_DELAY_MS = 100;

/** One removal attempt. The only place `fs.rmSync` is called, so both wrappers agree. */
function tryRemoveDirectory(directory: string): boolean {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Blocking removal, for `process.on('exit')` where nothing async can run. Returns whether the
 * path is gone. The window is deliberately short — by exit time every teardown has already
 * run, so a directory that is still locked is a live process, and no retry budget fixes that.
 */
export function removeDirectorySync(
  directory: string,
  attempts: number = SYNC_ATTEMPTS,
  delayMs: number = SYNC_DELAY_MS,
): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryRemoveDirectory(directory)) {
      return true;
    }
    if (attempt < attempts - 1) {
      waitSync(delayMs);
    }
  }
  return false;
}

/**
 * Removal from async test code, yielding between attempts so whatever holds the directory can
 * finish closing. Returns whether the path is gone; callers that leak temp directories depend
 * on the answer, so it is never swallowed.
 */
export async function removeDirectoryWithRetries(
  directory: string,
  attempts: number = ASYNC_ATTEMPTS,
  delayMs: number = ASYNC_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryRemoveDirectory(directory)) {
      return true;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** Owns every temp directory a test file creates so none can be forgotten. */
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

  /** Takes ownership of a directory made elsewhere. Used by the registry's own tests. */
  adopt(directory: string): void {
    this.directories.push(directory);
  }

  /** Removes every registered directory and forgets them all. Returns the ones that survived. */
  removeAll(attempts: number = SYNC_ATTEMPTS, delayMs: number = SYNC_DELAY_MS): string[] {
    const survivors: string[] = [];
    for (const directory of this.directories) {
      if (!removeDirectorySync(directory, attempts, delayMs)) {
        survivors.push(directory);
      }
    }
    this.directories.length = 0;
    return survivors;
  }
}

const fileRegistry = new TempDirRegistry();

// Not a node:test `after()` hook. Root after() hooks run in registration order, so one
// registered when this module is imported would run BEFORE the test file's own teardown —
// before the server is closed or the child is killed — and race the very thing holding the
// directory. `exit` runs after every hook. Cost: it must be synchronous.
process.on('exit', () => {
  const survivors = fileRegistry.removeAll();
  if (survivors.length === 0) {
    return;
  }
  let report = `\nTEMP DIRECTORIES LEFT BEHIND (${process.argv[1]}):\n`;
  for (const directory of survivors) {
    report += `  - ${directory}\n`;
  }
  // Loud, not fatal: failing here would hide whatever the test itself proved. A survivor is
  // almost always a spawned process that outlived its test — fix that, do not retry harder.
  process.stderr.write(report);
});

/**
 * Creates a temp directory removed automatically once this test file's process exits. Every
 * test that needs a scratch directory must use this instead of `fs.mkdtempSync`, which
 * `tests/test-hygiene-gate.test.ts` enforces.
 */
export function createManagedTempDir(prefix: string): string {
  return fileRegistry.create(prefix);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js temp-dirs`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/temp-dirs.ts tests/temp-dirs.test.ts
git commit -m "test: add a managed temp-directory registry"
```

---

## Task 2: Repoint `removeDirectoryWithRetries` and stop swallowing

**Files:**
- Modify: `tests/helpers/dashboard-http.ts` (delete the function), and the 8 files importing it

This is the `siftkit-node-test` leak: `runWithTempEnv` always calls the helper, and it returns normally whether or not the directory is gone.

- [ ] **Step 1: Delete the old copy**

Remove `removeDirectoryWithRetries` from `tests/helpers/dashboard-http.ts:210-222` entirely. Do **not** leave a re-export.

- [ ] **Step 2: Repoint the importers**

These 8 files import it from `./helpers/dashboard-http.js` (or `./dashboard-http.js`). Move the name into an import from `temp-dirs.js` at the matching depth, leaving their other named imports on the `dashboard-http.js` line:

- `tests/_runtime-helpers.ts`
- `tests/dashboard-http-helpers.test.ts`
- `tests/dashboard-status-server.test.ts`
- `tests/dashboard-status-server.run-logs.test.ts`
- `tests/inference-passthrough-status-server.test.ts`
- `tests/processed-input-metrics.test.ts`
- `tests/helpers/dashboard-model-queue-harness.ts`
- `tests/helpers/dashboard-server-fixture.ts`

The two files under `tests/helpers/` use `./temp-dirs.js`; the rest use `./helpers/temp-dirs.js`.

The existing `removeDirectoryWithRetries` tests in `tests/dashboard-http-helpers.test.ts` move to `tests/temp-dirs.test.ts` (Task 1 already contains their replacements) — delete them there rather than leaving the coverage split across two files.

- [ ] **Step 3: Report the failure at the call site that leaks**

In `tests/_runtime-helpers.ts`, in the `cleanup` closure inside `runWithTempEnv`, replace `await removeDirectoryWithRetries(tempRoot);` with:

```typescript
    if (!await removeDirectoryWithRetries(tempRoot)) {
      process.stderr.write(`\nTEMP DIRECTORY LEFT BEHIND: ${tempRoot}\n`);
    }
```

Every other caller ignores the new return value, which is valid TypeScript — a `Promise<boolean>` satisfies a `Promise<void>` position and a bare `await` of it is fine. No other call site changes.

- [ ] **Step 4: Run the affected suites**

Run: `npm run build:test && node .\dist\scripts\run-tests.js temp-dirs dashboard-http-helpers dashboard-status-server dashboard-status-server.run-logs inference-passthrough-status-server processed-input-metrics`
Expected: PASS

Run: `npm run typecheck`
Expected: exit 0 — eslint will flag any import left unused by the move.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: report undeletable temp directories instead of swallowing"
```

---

## Task 3: Fix `repo-tools.test.ts` — the largest leak

**Files:**
- Modify: `tests/repo-tools.test.ts:20-33`
- Test: its own existing suite is the regression check

42 `makeRepo()` calls, 3 `rmSync`, 38 leaked per run. Routing `makeRepo` through the registry fixes all 42 at once without touching a single test body.

- [ ] **Step 1: Route `makeRepo` through the registry**

Add next to the existing imports:

```typescript
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

Replace the first line of `makeRepo` (line 21):

```typescript
function makeRepo(): string {
  const root = createManagedTempDir('siftkit-repo-tools-');
```

Leave the rest of `makeRepo` and every test body unchanged. Leave the three existing `fs.rmSync(root, …)` calls in place — the registry tolerates an already-deleted path, and some tests assert on the directory being gone mid-test. Removing them is churn with no benefit.

- [ ] **Step 2: Run the suite and confirm the leak is gone**

```bash
npm run build:test
ls -1 "$LOCALAPPDATA/Temp" | grep -c "^siftkit-repo-tools-" || true
node .\dist\scripts\run-tests.js repo-tools
ls -1 "$LOCALAPPDATA/Temp" | grep -c "^siftkit-repo-tools-" || true
```

Expected: the suite passes, and the two counts are identical. Before this change the second count was **38** higher.

- [ ] **Step 3: Commit**

```bash
git add tests/repo-tools.test.ts
git commit -m "test: stop repo-tools leaking a temp repo per test"
```

---

## Task 4: Convert the remaining leaking test files

61 files contain `mkdtempSync`, 164 call sites total. Convert them in **three commits** grouped by prefix so each diff stays reviewable, verifying after each.

**Batch A** — `tests/_runtime-helpers.ts` (`siftkit-node-test`, 18/run) and `tests/web-search-usage.test.ts` (`siftkit-usage`).
**Batch B** — the remaining top offenders: `siftkit-repo-search-ignore` (14/run), `siftkit-test` (12/run), `siftkit-mock-loop`, `siftkit-dashboard-benchmark`.
**Batch C** — the ~25 single-directory prefixes.

- [ ] **Step 1: List the files to convert**

```bash
cd c:\Users\denys\Documents\GitHub\SiftKit
grep -rln "mkdtempSync" tests/
```

Every hit except `tests/helpers/temp-dirs.ts` (the module itself) and `tests/temp-dirs.test.ts` (which needs unmanaged directories to test removal) must be converted.

- [ ] **Step 2: Convert each file mechanically**

Add:

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

Keep the prefix string exactly as it was — the prefixes are how the leak was traced and how Tasks 3 and 7 verify the fix. Leave existing `rmSync` / `removeDirectoryWithRetries` teardown in place; the registry is idempotent. Do **not** delete a test's own cleanup, because some tests assert on the directory being gone mid-test.

If a file imports `os` or `path` solely for the `mkdtempSync` line, remove the now-unused import — `npm run typecheck` runs eslint and will flag it.

- [ ] **Step 3: After each batch, run and count**

```bash
npm run build:test && npm test
```

Expected: PASS — 1950 tests, 1948 pass, 0 fail, 2 skipped, matching the baseline. The leak delta should fall 113 → ~93 after batch A, → ~55 after batch B, → 0 after batch C.

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit each batch**

```bash
git add tests/
git commit -m "test: route batch <A|B|C> temp directories through the managed registry"
```

---

## Task 5: Gate against new bare `mkdtempSync`

**Files:**
- Modify: `tests/test-hygiene-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Append, matching the existing `filesMatching` style:

```typescript
// Temp directories must come from the registry in tests/helpers/temp-dirs.ts, which removes
// them in a process exit handler. A bare call depends on the test remembering to clean up,
// and 42 such calls in one file with 3 cleanups is how ~58,000 directories accumulated.
// The needle is built from fragments so this gate file does not match itself.
test('hygiene: no test creates a temp directory outside the managed registry', () => {
  const allowed = new Set([
    path.join(TESTS_DIR, 'helpers', 'temp-dirs.ts'),
    path.join(TESTS_DIR, 'temp-dirs.test.ts'),
  ]);
  const offenders = filesMatching(new RegExp('mkdtemp' + 'Sync')).filter(
    (file) => !allowed.has(file),
  );
  assert.deepEqual(offenders, []);
});
```

The fragment split is mandatory and follows the precedent the file already sets for `@ts-nocheck` two tests above. A literal `/mkdtempSync/` matches this file's own source — both in the regex and in the comment — so the gate would name itself and fail permanently.

`tests/temp-dirs.test.ts` is allowed because its removal tests must create directories the registry does not own.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js test-hygiene-gate`
Expected: FAIL if any file from Task 4 was missed, listing them. If Task 4 was complete, this passes immediately — that is the intended outcome, and it locks the invariant in.

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
- Create: `scripts/purge-temp-dirs.ts`, `tests/purge-temp-dirs.test.ts`
- Modify: `package.json`

`build:test` compiles `scripts/**/*.ts` via `tsconfig.scripts.json` into `dist/scripts/`, so no build change is needed.

- [ ] **Step 1: Write the failing test**

The selection rules are the part worth testing; the process-level driver is not. Create `tests/purge-temp-dirs.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createManagedTempDir } from './helpers/temp-dirs.js';
import { parseMinAgeMinutes, purgeTempDirectories } from '../scripts/purge-temp-dirs.js';

test('parseMinAgeMinutes defaults to 60 and reads an explicit value', () => {
  assert.equal(parseMinAgeMinutes([]), 60);
  assert.equal(parseMinAgeMinutes(['--min-age-minutes', '0']), 0);
  assert.equal(parseMinAgeMinutes(['--min-age-minutes', '5']), 5);
});

test('parseMinAgeMinutes rejects a missing or nonsensical value', () => {
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes']), /Invalid --min-age-minutes/u);
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes', 'soon']), /Invalid --min-age-minutes/u);
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes', '-1']), /Invalid --min-age-minutes/u);
});

test('purgeTempDirectories removes only old siftkit directories', () => {
  const root = createManagedTempDir('siftkit-purge-root-');
  const stale = path.join(root, 'siftkit-stale-abc123');
  const fresh = path.join(root, 'siftkit-fresh-abc123');
  const foreign = path.join(root, 'other-tool-abc123');
  const reserved = path.join(root, 'siftkit-temp-timing');
  for (const directory of [stale, fresh, foreign, reserved]) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(root, 'siftkit-loose-file.txt'), 'x', 'utf8');
  const old = new Date(2020, 0, 1);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(reserved, old, old);

  const result = purgeTempDirectories(root, Date.now() - 60_000);

  assert.deepEqual(result, { removed: 1, skipped: 3, failed: 0 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(reserved), true);
});
```

`siftkit-temp-timing` is excluded because `src/lib/temporary-timing-recorder.ts:145` creates it as a fixed-name production trace directory. It matches the `siftkit-` prefix but is not a leak.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js purge-temp-dirs`
Expected: FAIL — cannot resolve `../scripts/purge-temp-dirs.js`

- [ ] **Step 3: Implement**

Create `scripts/purge-temp-dirs.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Removes leftover `siftkit-*` directories from the OS temp dir. The suite leaked ~113 per run
 * before the registry landed; this clears whatever accumulated (58,510 as of 2026-07-31).
 *
 * Only directories whose name starts with `siftkit-` are touched, never the production
 * `siftkit-temp-timing` trace directory, and by default only those untouched for an hour, so a
 * concurrent test run is never disturbed.
 */
const PREFIX = 'siftkit-';
const RESERVED = 'siftkit-temp-timing';
const DEFAULT_MIN_AGE_MINUTES = 60;

export interface PurgeResult {
  removed: number;
  skipped: number;
  failed: number;
}

export function parseMinAgeMinutes(argv: string[]): number {
  const index = argv.indexOf('--min-age-minutes');
  if (index === -1) {
    return DEFAULT_MIN_AGE_MINUTES;
  }
  const raw = argv[index + 1];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --min-age-minutes value: ${raw}`);
  }
  return parsed;
}

export function purgeTempDirectories(root: string, cutoffMs: number): PurgeResult {
  const result: PurgeResult = { removed: 0, skipped: 0, failed: 0 };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) {
      continue;
    }
    if (entry.name === RESERVED) {
      result.skipped += 1;
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      if (fs.statSync(directory).mtimeMs > cutoffMs) {
        result.skipped += 1;
        continue;
      }
    } catch {
      result.skipped += 1;
      continue;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

if (require.main === module) {
  const minAgeMinutes = parseMinAgeMinutes(process.argv.slice(2));
  const tempRoot = fs.realpathSync(os.tmpdir());
  const result = purgeTempDirectories(tempRoot, Date.now() - minAgeMinutes * 60_000);
  process.stdout.write(
    `purge-temp-dirs: removed=${result.removed} skipped=${result.skipped} `
    + `failed=${result.failed} root=${tempRoot}\n`,
  );
}
```

The `require.main` guard is what lets the test import the module without purging the developer's temp directory. CommonJS is confirmed correct here: `dist/scripts/package.json` pins `{"type": "commonjs"}` and the emitted `dist/scripts/run-tests.js` starts with `"use strict"; … exports`, so no `import.meta.url` variant is needed.

- [ ] **Step 4: Add the npm script**

In `package.json`, next to the other `node .\dist\scripts\...` entries:

```json
    "purge:temp": "node .\\dist\\scripts\\purge-temp-dirs.js",
```

- [ ] **Step 5: Run the tests, then the purge**

```bash
npm run build:test && node .\dist\scripts\run-tests.js purge-temp-dirs
npm run purge:temp
```

Expected: tests PASS, then a line like `purge-temp-dirs: removed=58000 skipped=12 failed=3 root=...`. A non-zero `failed` count is fine — those are directories another process still holds; re-run later. Removing ~58,000 directories takes several minutes.

- [ ] **Step 6: Confirm the reclaim**

```bash
ls -1 "$LOCALAPPDATA/Temp" | grep -c "^siftkit-" || true
```

Expected: a small number (only directories newer than the age cutoff), down from 58,510.

- [ ] **Step 7: Commit**

```bash
git add scripts/purge-temp-dirs.ts tests/purge-temp-dirs.test.ts package.json
git commit -m "chore: add a purge script for leaked test temp directories"
```

---

## Task 7: Prove the leak is closed

**Files:** none — this is the acceptance check for the whole plan.

- [ ] **Step 1: Count, run the full suite, count again**

```bash
cd c:\Users\denys\Documents\GitHub\SiftKit
ls -1 "$LOCALAPPDATA/Temp" > before.txt
npm test 2>&1 | tee run.log
ls -1 "$LOCALAPPDATA/Temp" > after.txt
comm -13 <(sort before.txt) <(sort after.txt) | grep -c "^siftkit-" || true
```

Expected: `1950 tests / 1948 pass / 0 fail / 2 skipped`, and the final count is **0**. Before this plan it was 113. Delete `before.txt`, `after.txt`, `run.log` afterwards.

Count top-level entries only — `grep "^siftkit-"` on a flat `ls -1` does this. A recursive walk inflates the number ~4×.

- [ ] **Step 2: Confirm nothing was left behind loudly**

`run.log` must contain no `TEMP DIRECTORIES LEFT BEHIND` or `TEMP DIRECTORY LEFT BEHIND` lines. If it does, the named directory is held by a **live process** — on Windows that is almost always a spawned CLI whose `cwd` is inside it. Find which test spawns it and make that test wait for the child to exit. Do not widen the retry window; it cannot help while the process is alive.

- [ ] **Step 3: Confirm the gate holds**

Run: `npm run build:test && node .\dist\scripts\run-tests.js test-hygiene-gate temp-dirs purge-temp-dirs`
Expected: PASS

Run: `npm run typecheck`
Expected: exit 0

---

## Explicitly out of scope

- **The `npm test` deadlock.** It no longer reproduces. Measured 2026-07-31: 1950 tests, 0 fail, 46.2 s, exit 0. The ~40 zombie processes seen on 2026-07-29 came from an older arrangement that preloaded `tests/live-instance-guard.ts` through `NODE_OPTIONS`, which dragged the tsx loader into every spawned CLI. Moving the guard to the precompiled `scripts/live-instance-guard.js` already fixed it; the comment at `scripts/run-tests.ts:9-20` records why. No task here re-litigates that.
- **Reducing how many temp directories the suite creates.** 113 per run is fine once they are cleaned up; consolidating fixtures is a separate refactor with its own risk.
- **`bench/` and `src/` temp directories.** `grep` confirms no `mkdtempSync` outside `tests/`. The one production temp path is the fixed-name `siftkit-temp-timing` at `src/lib/temporary-timing-recorder.ts:145`, which does not multiply and which Task 6 explicitly refuses to delete.
