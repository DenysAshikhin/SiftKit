# F11 Dead-Code Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three genuinely-dead F11 artifacts (`src/llama-cpp-bridge.ts`, the `SIFT_LEGACY_*`/`SIFT_PREVIOUS_*` constants, the `test-full.ts` phantom `tsconfig` include) and de-duplicate `SIFTKIT_VERSION` against `package.json`.

**Architecture:** Pure deletions plus one single-source-of-truth refactor. No behavioral runtime changes. `execution-lock`/`execution-lease` is explicitly **out of scope** — re-verification proved it is live cross-process serialization (CLI acquires a lease from the status server over HTTP, heartbeats it, and a `skipExecutionLock` flag is threaded through 5 modules + server endpoints + ~15 test files), not dead code. The architecture review's "intra-process-only / candidate for deletion" characterization is stale; removing it is a behavioral refactor that belongs to the server/workspace split, not this sweep.

**Tech Stack:** TypeScript (NodeNext ESM), `node --test` via `tsx`, tests import compiled output from `dist/` (build step `npm run build:test` required before running any test).

**Verification gate (applies to every task):** For pure deletions there is no red-green unit test to author — the gates are (a) `grep`-proof of zero remaining references, (b) `npm run typecheck` clean, (c) the affected test file(s) green. Each task lists its exact gate. Do not claim a task complete without pasting the command output.

**Re-verification done 2026-06-16 (line numbers current as of this date):**
- `src/llama-cpp-bridge.ts` — zero importers in `src/`, `tests/`, `scripts/`, `bench/`. Not a `bin` entry (`package.json` bin is `bin/siftkit.js`). Only references are docs: `docs/prompt-dispatch-inventory.md:13` (F5 row) and `ARCHITECTURE-REVIEW.md`.
- `SIFT_LEGACY_DEFAULT_NUM_CTX`, `SIFT_LEGACY_DERIVED_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_MODEL`, `SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS` — defined `src/config/constants.ts:3-6,19`, re-exported `src/config/index.ts:7-10,22`, and imported (but **never used in any test body**) at `tests/config.test.ts:40-41`. Zero consumers in `src/` runtime logic.
- `tsconfig.json:18` lists `"test-full.ts"`, which does not exist (harmless to `tsc` but violates cleanliness).
- `SIFTKIT_VERSION = '0.1.0'` (`src/config/constants.ts:1`) hand-duplicates `package.json` `version` (`package.json:3`). Consumed at `src/config/defaults.ts:75` and asserted at `tests/config.test.ts:48-51`.

---

### Task 1: Remove the `test-full.ts` phantom `tsconfig` include

**Files:**
- Modify: `tsconfig.json:16-19`

- [ ] **Step 1: Confirm the file does not exist**

Run: `Test-Path .\test-full.ts`
Expected: `False`

- [ ] **Step 2: Edit `tsconfig.json` to drop the phantom entry**

Change the `include` array from:

```json
  "include": [
    "src/**/*.ts",
    "test-full.ts"
  ]
```

to:

```json
  "include": [
    "src/**/*.ts"
  ]
```

- [ ] **Step 3: Verify the project still typechecks**

Run: `npm run typecheck`
Expected: PASS (exit 0), no errors. Removing a non-matching literal include changes nothing tsc compiled, so output must be identical-clean.

- [ ] **Step 4: Commit**

```powershell
git add tsconfig.json
git commit -m @'
chore(config): drop phantom test-full.ts tsconfig include (F11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 2: Delete the dead `llama-cpp-bridge.ts` and fix the doc inventory

**Files:**
- Delete: `src/llama-cpp-bridge.ts`
- Modify: `docs/prompt-dispatch-inventory.md` (remove the F5 row + any F5 cross-references)

- [ ] **Step 1: Re-confirm zero code importers immediately before deleting**

Run: `rg -n "llama-cpp-bridge" src tests scripts bench`
Expected: NO matches (only docs reference it; docs are handled in Step 3). If any `src/tests/scripts/bench` hit appears, STOP — the file is not dead; do not delete.

- [ ] **Step 2: Delete the file**

Run: `git rm .\src\llama-cpp-bridge.ts`
Expected: `rm 'src/llama-cpp-bridge.ts'`

- [ ] **Step 3: Remove the F5 row from the dispatch inventory**

In `docs/prompt-dispatch-inventory.md`, delete the table row (currently line 13):

```
| F5 | Direct bridge utility (`llama-cpp-bridge generate`) | `src/llama-cpp-bridge.ts` -> `generateLlamaCppResponse` | Direct single prompt wrapper (no splitting/planner) |
```

Then update the "Mode A" heading on line 23 from `(F1/F2/F3/F5)` to `(F1/F2/F3)` and delete the trailing `or direct prompt text (bridge)` clause on line 24 so the mode description no longer references the removed bridge. Search the rest of the file for any other `F5` / `bridge` mention and remove it.

Run after editing: `rg -n "F5|bridge|llama-cpp-bridge" docs\prompt-dispatch-inventory.md`
Expected: NO matches.

- [ ] **Step 4: Verify build + typecheck are clean without the file**

Run: `npm run typecheck`
Expected: PASS (exit 0). No "cannot find module './llama-cpp-bridge.js'" errors anywhere — proves nothing imported it.

- [ ] **Step 5: Commit**

```powershell
git add src/llama-cpp-bridge.ts docs/prompt-dispatch-inventory.md
git commit -m @'
refactor: delete dead llama-cpp-bridge utility (F11)

Zero importers in src/tests/scripts/bench; not a bin entry. Removes the
F5 row from the prompt-dispatch inventory.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 3: Remove the `SIFT_LEGACY_*` / `SIFT_PREVIOUS_*` constants

**Files:**
- Modify: `src/config/constants.ts:3-6,19`
- Modify: `src/config/index.ts:7-10,22`
- Modify: `tests/config.test.ts:40-41`

- [ ] **Step 1: Remove the constant definitions from `src/config/constants.ts`**

Delete these four contiguous lines (currently 3-6):

```ts
export const SIFT_LEGACY_DEFAULT_NUM_CTX = 16_384;
export const SIFT_LEGACY_DERIVED_NUM_CTX = 32_000;
export const SIFT_PREVIOUS_DEFAULT_NUM_CTX = 50_000;
export const SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5-4b-q8_0';
```

And delete this line (currently 19):

```ts
export const SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
```

Leave `SIFT_DEFAULT_NUM_CTX` (line 2), `SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN` (line 20), and all `SIFT_DEFAULT_*` constants untouched.

- [ ] **Step 2: Remove the re-exports from `src/config/index.ts`**

In the `export { ... } from './constants.js';` block, delete these four lines (currently 7-10):

```ts
  SIFT_LEGACY_DEFAULT_NUM_CTX,
  SIFT_LEGACY_DERIVED_NUM_CTX,
  SIFT_PREVIOUS_DEFAULT_NUM_CTX,
  SIFT_PREVIOUS_DEFAULT_MODEL,
```

And delete this line (currently 22):

```ts
  SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS,
```

- [ ] **Step 3: Remove the unused imports from `tests/config.test.ts`**

In the import block from `'../dist/config/index.js'`, delete these two lines (currently 40-41):

```ts
  SIFT_PREVIOUS_DEFAULT_MODEL,
  SIFT_LEGACY_DEFAULT_NUM_CTX,
```

(They are imported but never referenced in any test body — confirmed by `rg`. No assertions need rewriting.)

- [ ] **Step 4: Prove zero remaining references repo-wide (excluding the review doc)**

Run: `rg -n "SIFT_LEGACY_|SIFT_PREVIOUS_" src tests scripts bench dashboard`
Expected: NO matches. (`ARCHITECTURE-REVIEW.md` still mentions them — that doc is updated in Task 5.)

- [ ] **Step 5: Typecheck the source graph**

Run: `npm run typecheck`
Expected: PASS (exit 0). A leftover importer would fail here with "has no exported member 'SIFT_LEGACY_...'".

- [ ] **Step 6: Build test output and run the config suite**

Run: `npm run build:test; if ($?) { npx tsx --test .\tests\config.test.ts }`
Expected: all `config.test.ts` tests PASS, 0 failures. The `SIFTKIT_VERSION is a string` test and every other config test stay green.

- [ ] **Step 7: Commit**

```powershell
git add src/config/constants.ts src/config/index.ts tests/config.test.ts
git commit -m @'
refactor(config): remove dead SIFT_LEGACY_*/SIFT_PREVIOUS_* constants (F11)

No runtime consumers; only re-exported and imported-but-unused in tests.
Violated the no-legacy-compatibility rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 4: Source `SIFTKIT_VERSION` from `package.json`

**Files:**
- Modify: `src/config/constants.ts:1`
- Modify: `tests/config.test.ts:48-51`

**Note on TDD:** The value is `0.1.0` in both places today, so an equality assertion cannot go red before the change. The honest framing: Step 1 strengthens the existing shape-only test into a drift guard (asserts the constant equals `package.json` `version`), and the refactor in Step 3 makes that guard structurally true instead of coincidentally true. This catches future hand-edit drift — the actual defect class F11 names.

- [ ] **Step 1: Strengthen the version test into a `package.json` drift guard**

In `tests/config.test.ts`, the existing test (currently lines 48-51):

```ts
test('SIFTKIT_VERSION is a string', () => {
  assert.equal(typeof SIFTKIT_VERSION, 'string');
  assert.match(SIFTKIT_VERSION, /^\d+\.\d+\.\d+$/u);
});
```

Replace it with a test that reads `package.json` and asserts equality. Add `import { createRequire } from 'node:module';` to the top of the file if not already present, and add this test:

```ts
test('SIFTKIT_VERSION matches package.json version', () => {
  const requireFromTest = createRequire(import.meta.url);
  const packageJson = requireFromTest('../package.json') as { version: string };
  assert.equal(typeof SIFTKIT_VERSION, 'string');
  assert.match(SIFTKIT_VERSION, /^\d+\.\d+\.\d+$/u);
  assert.equal(SIFTKIT_VERSION, packageJson.version);
});
```

(`tests/config.test.ts` lives at `tests/`, so `../package.json` resolves to the repo-root manifest.)

- [ ] **Step 2: Run the guard against the current hardcoded constant**

Run: `npm run build:test; if ($?) { npx tsx --test --test-name-pattern "SIFTKIT_VERSION matches package.json version" .\tests\config.test.ts }`
Expected: PASS today (both are `0.1.0`). This confirms the guard is wired correctly before the refactor; it will fail if anyone later bumps `package.json` without the constant tracking it.

- [ ] **Step 3: Read the version from `package.json` in `src/config/constants.ts`**

Replace line 1:

```ts
export const SIFTKIT_VERSION = '0.1.0';
```

with:

```ts
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const SIFTKIT_VERSION = packageJson.version;
```

Rationale for the path: `constants.ts` compiles to `dist/config/constants.js`; `../../package.json` from there resolves to the package root manifest in both the dev tree (`dist/config/ -> dist/ -> root`) and the published package (`dist`, `bin`, `package.json` all at package root, per `package.json` `files`). `new URL(..., import.meta.url)` + `readFileSync` is the NodeNext-correct, explicitly-typed approach (no `any` from `require`, no `resolveJsonModule` tsconfig change needed).

- [ ] **Step 4: Typecheck**

Run: `tsc -p .\tsconfig.json --noEmit`
Expected: PASS (exit 0). The `as { version: string }` cast keeps `SIFTKIT_VERSION` typed as `string`, so `src/config/defaults.ts:75` (`Version: SIFTKIT_VERSION`) still typechecks.

- [ ] **Step 5: Rebuild and re-run the config suite**

Run: `npm run build:test; if ($?) { npx tsx --test .\tests\config.test.ts }`
Expected: all tests PASS, including `SIFTKIT_VERSION matches package.json version`. The value is now sourced from the manifest, so the assertion is structurally guaranteed.

- [ ] **Step 6: Commit**

```powershell
git add src/config/constants.ts tests/config.test.ts
git commit -m @'
refactor(config): source SIFTKIT_VERSION from package.json (F11)

Removes the hand-maintained version duplication; package.json is now the
single source of truth. Test asserts equality to guard future drift.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 5: Update `ARCHITECTURE-REVIEW.md` to reflect resolved items and correct the exec-lock claim

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (F11 section, lines 16-22; priority order, line 174)

The review's convention is "Resolved findings are deleted as they are fixed." Three F11 bullets are now resolved; the `SIFTKIT_VERSION` bullet is resolved; the exec-lock bullet was re-verified as **wrong** (it is live cross-process code, not dead) and must be reclassified rather than deleted.

- [ ] **Step 1: Rewrite the F11 section**

Replace the current F11 body (lines 16-22):

```markdown
### F11. Dead code and "legacy" constants that violate the project's no-legacy rule

- `src/llama-cpp-bridge.ts` (107 lines) has **zero importers** in `src/`, `tests/`, or `scripts/`.
- `src/config/constants.ts` exports `SIFT_LEGACY_DEFAULT_NUM_CTX`, `SIFT_LEGACY_DERIVED_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_MODEL`, `SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS` — named legacy-compat values still re-exported through `src/config/index.ts`, against the stated "no legacy compatibility" rule.
- `SIFTKIT_VERSION = '0.1.0'` (`src/config/constants.ts:1`) duplicates `package.json` `version` by hand.
- `tsconfig.json:18` includes `test-full.ts`, which does not exist.
- `src/execution-lock.ts` and `src/config/execution-lease.ts` existed largely to coordinate the now-removed client/server split-brain execution; with the server as sole engine owner they are intra-process-only serialization and candidates for deletion (still imported by `summary/core.ts`, `eval.ts`, `install.ts`).
```

with:

```markdown
### F11. `execution-lock`/`execution-lease` re-evaluation (dead-code items resolved)

The dead-code half is done: `src/llama-cpp-bridge.ts` deleted (zero importers), the `SIFT_LEGACY_*`/`SIFT_PREVIOUS_*` constants removed, `SIFTKIT_VERSION` now sourced from `package.json`, and the phantom `test-full.ts` `tsconfig` include dropped. Remaining:

- `src/execution-lock.ts` + `src/config/execution-lease.ts` were re-verified and are **not** dead or intra-process-only. The client (`execution-lock`) acquires a lease from the status server over HTTP (`tryAcquireExecutionLease` -> `routes/core.ts` acquire/release/heartbeat endpoints; `server-ops.ts`; `ExecutionLease` type in `server-types.ts`), heartbeats it on a 3s timer, and a `skipExecutionLock` flag is threaded through `summary/types.ts` + callers (`command-output/analyzer.ts`, `status-server/preset-runner.ts`, `routes/core.ts:1055`). Live consumers: `install.ts`, `eval.ts`, `summary/request-runner.ts`. This is real cross-process serialization of the single-slot managed `llama-server`. Removing it is a behavioral refactor (it would let two concurrent CLI invocations both drive one slot) and belongs to the server/workspace split, not a dead-code sweep.
```

- [ ] **Step 2: Update the priority-order item 1**

Replace line 174:

```markdown
1. Dead-code sweep: `llama-cpp-bridge.ts`, `SIFT_LEGACY_*`, `execution-lock`/`execution-lease`, `test-full.ts` include (F11).
```

with:

```markdown
1. ~~Dead-code sweep~~ **(done):** `llama-cpp-bridge.ts`, `SIFT_LEGACY_*`, `SIFTKIT_VERSION` dedupe, `test-full.ts` include removed. `execution-lock`/`execution-lease` reclassified as live cross-process code — its removal is deferred to the server/workspace split (see F11), not a dead-code item.
```

- [ ] **Step 3: Commit**

```powershell
git add ARCHITECTURE-REVIEW.md
git commit -m @'
docs(architecture): mark F11 dead-code items resolved; reclassify exec-lock (F11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 6: Full-suite regression gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full typecheck across every project**

Run: `npm run typecheck`
Expected: PASS (exit 0) for `tsconfig.json`, `tsconfig.scripts.json`, dashboard, bench, and `tsconfig.test.json`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: typecheck:test passes, `build:test` compiles, and `dist/scripts/run-tests.js` reports 0 failures. If any `execution-lock`/lease test changed behavior, STOP — this sweep must not have touched it.

- [ ] **Step 3: Final reference sweep — prove the dead artifacts are gone**

Run: `rg -n "llama-cpp-bridge|SIFT_LEGACY_|SIFT_PREVIOUS_|test-full" src tests scripts bench dashboard tsconfig.json`
Expected: NO matches (all remaining mentions live only in `ARCHITECTURE-REVIEW.md`, which documents the resolution).

---

## Self-Review

**Spec coverage (priority-1 item 1 = `llama-cpp-bridge.ts`, `SIFT_LEGACY_*`, `execution-lock`/`execution-lease`, `test-full.ts`):**
- `llama-cpp-bridge.ts` → Task 2. ✓
- `SIFT_LEGACY_*` (+ `SIFT_PREVIOUS_*`) → Task 3. ✓
- `test-full.ts` include → Task 1. ✓
- `execution-lock`/`execution-lease` → explicitly out of scope per re-verification + user decision; documented in plan header and Task 5. ✓
- `SIFTKIT_VERSION` dedupe (F11 bullet, user opted in) → Task 4. ✓
- Review doc kept truthful → Task 5. Full regression gate → Task 6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every edit shows exact before/after text and exact commands with expected output. ✓

**Type consistency:** `SIFTKIT_VERSION` stays `string` (cast `as { version: string }`), preserving `defaults.ts:75` `Version: SIFTKIT_VERSION` and the `config-store` string handling. Removed constant names are identical across `constants.ts`, `index.ts`, and `config.test.ts`. ✓
