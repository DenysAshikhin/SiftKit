# Delete Stale Src Build Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use a worktree.

**Goal:** Remove tracked generated `src/**/*.js` and generated `src/**/*.d.ts` siblings so Node and tooling cannot resolve stale build output from `src/`.

**Architecture:** This is a repo hygiene fix, not a runtime feature. Add one repository policy regression in the existing settings/spec test file, then delete the tracked generated artifacts and generalize `.gitignore` so future in-place TypeScript emits fail at review time and stay untracked. Keep the intentional ambient declaration `src/types/better-sqlite3.d.ts` as the only allowed tracked `src/**/*.d.ts` file.

**Tech Stack:** TypeScript, Node test runner, Git, npm scripts, `.gitignore`.

---

## Current Evidence

`ARCHITECTURE-REVIEW.md` identifies two linked findings:

- F5: generated `.d.ts` declarations are tracked beside their `.ts` implementations.
- F9: generated CommonJS `.js` files are tracked beside the same `.ts` implementations and are stale.

Current tracked files to remove:

```text
src/config/paths.d.ts
src/config/paths.js
src/lib/fs.d.ts
src/lib/fs.js
src/lib/json.d.ts
src/lib/json.js
src/lib/paths.d.ts
src/lib/paths.js
src/lib/time.d.ts
src/lib/time.js
src/lib/types.d.ts
src/lib/types.js
src/presets.d.ts
src/presets.js
src/state/chat-sessions.d.ts
src/state/chat-sessions.js
src/state/runtime-db.d.ts
src/state/runtime-db.js
```

Intentional tracked declaration to keep:

```text
src/types/better-sqlite3.d.ts
```

Existing `.gitignore` only blocks web-search generated siblings:

```gitignore
# Web-search build output lives in dist/; never track compiled siblings in src.
src/web-search/*.js
src/web-search/*.d.ts
```

The fix must replace that narrow ignore with a `src/**` policy while explicitly unignoring `src/types/better-sqlite3.d.ts`.

## File Structure

- Modify: `tests/benchmark-spec-settings.test.ts`
  - Add a focused repository policy regression near the existing package/build/typecheck policy tests.
  - Add a helper that reads tracked `src` files through `git -C <repo> ls-files -- src`.
  - Assert no tracked `src/**/*.js` files exist.
  - Assert no tracked generated `src/**/*.d.ts` files exist, excluding `src/types/better-sqlite3.d.ts`.
  - Assert `.gitignore` contains the generalized rules and the ambient declaration exception.
- Modify: `.gitignore`
  - Replace `src/web-search/*.js` and `src/web-search/*.d.ts` with `src/**/*.js`, `src/**/*.d.ts`, and `!src/types/better-sqlite3.d.ts`.
- Delete:
  - `src/config/paths.d.ts`
  - `src/config/paths.js`
  - `src/lib/fs.d.ts`
  - `src/lib/fs.js`
  - `src/lib/json.d.ts`
  - `src/lib/json.js`
  - `src/lib/paths.d.ts`
  - `src/lib/paths.js`
  - `src/lib/time.d.ts`
  - `src/lib/time.js`
  - `src/lib/types.d.ts`
  - `src/lib/types.js`
  - `src/presets.d.ts`
  - `src/presets.js`
  - `src/state/chat-sessions.d.ts`
  - `src/state/chat-sessions.js`
  - `src/state/runtime-db.d.ts`
  - `src/state/runtime-db.js`
- Do not modify:
  - `src/types/better-sqlite3.d.ts`
  - `.claude/settings.local.json`

---

### Task 1: Add Failing Repository Artifact Guard

**Files:**
- Modify: `tests/benchmark-spec-settings.test.ts`
- Test: `tests/benchmark-spec-settings.test.ts`

- [ ] **Step 1: Add the child-process import**

Add this import after the existing `node:assert/strict` import:

```ts
import { execFileSync } from 'node:child_process';
```

The top import block should become:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
```

- [ ] **Step 2: Add explicit artifact guard helpers**

Add this block after the `syncDistRuntime` require block and before the first test:

```ts
const INTENTIONAL_SRC_DECLARATION_FILES = new Set<string>(['src/types/better-sqlite3.d.ts']);

function getTrackedSrcFiles(): string[] {
  const output = execFileSync('git', ['-C', process.cwd(), 'ls-files', '--', 'src'], {
    encoding: 'utf8',
  });

  return output.split(/\r?\n/u).filter((filePath) => filePath.length > 0);
}

function isForbiddenTrackedSrcArtifact(filePath: string): boolean {
  if (filePath.endsWith('.js')) {
    return true;
  }

  if (filePath.endsWith('.d.ts')) {
    return !INTENTIONAL_SRC_DECLARATION_FILES.has(filePath);
  }

  return false;
}

function readGitignoreLines(): string[] {
  return fs
    .readFileSync('.gitignore', 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim());
}
```

- [ ] **Step 3: Add branch-complete policy tests**

Add these tests after the helper block and before `test('buildBenchmarkCaseId is stable and descriptive', ...)`:

```ts
test('src artifact guard allows only intentional ambient declaration files', () => {
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.js'), true);
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.d.ts'), true);
  assert.equal(isForbiddenTrackedSrcArtifact('src/types/better-sqlite3.d.ts'), false);
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.ts'), false);
});

test('src contains no tracked generated JavaScript or declaration siblings', () => {
  assert.deepEqual(
    getTrackedSrcFiles().filter((filePath) => isForbiddenTrackedSrcArtifact(filePath)),
    [],
  );
});

test('gitignore blocks generated src JavaScript and declaration siblings', () => {
  const gitignoreLines = readGitignoreLines();

  assert.equal(gitignoreLines.includes('src/**/*.js'), true);
  assert.equal(gitignoreLines.includes('src/**/*.d.ts'), true);
  assert.equal(gitignoreLines.includes('!src/types/better-sqlite3.d.ts'), true);
});
```

- [ ] **Step 4: Run the focused test and verify it fails for the target reason**

Run:

```powershell
npx tsx --test .\tests\benchmark-spec-settings.test.ts
```

Expected: FAIL.

Expected failing assertions:

- `src contains no tracked generated JavaScript or declaration siblings` reports the 18 stale tracked files listed in Current Evidence.
- `gitignore blocks generated src JavaScript and declaration siblings` reports at least `src/**/*.js` missing.

If the failure is a TypeScript import/type error, fix the test file before continuing. Do not delete artifacts until the red test proves the target behavior.

- [ ] **Step 5: Commit the failing regression**

Run:

```powershell
git -C . add tests\benchmark-spec-settings.test.ts
git -C . commit -m "test: guard against tracked src build artifacts"
```

---

### Task 2: Delete Tracked Artifacts and Generalize Ignore Rules

**Files:**
- Modify: `.gitignore`
- Delete: the 18 tracked generated files listed in Current Evidence
- Test: `tests/benchmark-spec-settings.test.ts`

- [ ] **Step 1: Replace the narrow `.gitignore` rules**

Change this block:

```gitignore
# Web-search build output lives in dist/; never track compiled siblings in src.
src/web-search/*.js
src/web-search/*.d.ts
```

To this block:

```gitignore
# Build output lives in dist/; never track compiled siblings in src.
src/**/*.js
src/**/*.d.ts
!src/types/better-sqlite3.d.ts
```

- [ ] **Step 2: Delete the generated siblings through Git**

Run:

```powershell
git -C . rm -- src/config/paths.d.ts src/config/paths.js src/lib/fs.d.ts src/lib/fs.js src/lib/json.d.ts src/lib/json.js src/lib/paths.d.ts src/lib/paths.js src/lib/time.d.ts src/lib/time.js src/lib/types.d.ts src/lib/types.js src/presets.d.ts src/presets.js src/state/chat-sessions.d.ts src/state/chat-sessions.js src/state/runtime-db.d.ts src/state/runtime-db.js
```

Expected output includes one `rm` line for each deleted file.

- [ ] **Step 3: Verify only the intentional declaration remains from the known artifact set**

Run:

```powershell
git -C . ls-files -- src/config/paths.d.ts src/config/paths.js src/lib/fs.d.ts src/lib/fs.js src/lib/json.d.ts src/lib/json.js src/lib/paths.d.ts src/lib/paths.js src/lib/time.d.ts src/lib/time.js src/lib/types.d.ts src/lib/types.js src/presets.d.ts src/presets.js src/state/chat-sessions.d.ts src/state/chat-sessions.js src/state/runtime-db.d.ts src/state/runtime-db.js src/types/better-sqlite3.d.ts
```

Expected output:

```text
src/types/better-sqlite3.d.ts
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
npx tsx --test .\tests\benchmark-spec-settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the targeted test through the repo runner**

Run:

```powershell
npm test -- tests\benchmark-spec-settings.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the cleanup**

Run:

```powershell
git -C . add .gitignore
git -C . add -u src tests\benchmark-spec-settings.test.ts
git -C . commit -m "fix: remove stale src build artifacts"
```

---

### Task 3: Full Validation and Final Evidence

**Files:**
- Read: `package.json`
- Read: `tsconfig.json`
- Read: `tsconfig.scripts.json`
- Read: `tsconfig.test.json`
- Read: `.gitignore`

- [ ] **Step 1: Verify TypeScript across repo, scripts, dashboard, and tests**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Verify the full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Verify Git no longer tracks generated `src` siblings**

Run:

```powershell
git -C . ls-files -- src/config/paths.d.ts src/config/paths.js src/lib/fs.d.ts src/lib/fs.js src/lib/json.d.ts src/lib/json.js src/lib/paths.d.ts src/lib/paths.js src/lib/time.d.ts src/lib/time.js src/lib/types.d.ts src/lib/types.js src/presets.d.ts src/presets.js src/state/chat-sessions.d.ts src/state/chat-sessions.js src/state/runtime-db.d.ts src/state/runtime-db.js src/types/better-sqlite3.d.ts
```

Expected output:

```text
src/types/better-sqlite3.d.ts
```

- [ ] **Step 4: Verify ignore rules protect future in-place emits**

Run:

```powershell
git -C . check-ignore -v src/lib/time.js src/lib/time.d.ts
```

Expected output references `.gitignore` lines for:

```text
src/**/*.js
src/**/*.d.ts
```

Run:

```powershell
git -C . check-ignore -v src/types/better-sqlite3.d.ts
```

Expected: non-zero exit with no output because the ambient declaration is explicitly unignored and remains tracked.

- [ ] **Step 5: Verify working tree scope**

Run:

```powershell
git -C . status --short
```

Expected after the two task commits:

```text
 M .claude/settings.local.json
```

If the plan file is intentionally left uncommitted, it may also appear as:

```text
?? docs/superpowers/plans/2026-06-10-delete-stale-src-build-artifacts.md
```

No deleted generated `src` artifacts should remain staged or unstaged after the cleanup commit.

---

## Acceptance Criteria

- `git -C . ls-files -- src/config/paths.d.ts src/config/paths.js src/lib/fs.d.ts src/lib/fs.js src/lib/json.d.ts src/lib/json.js src/lib/paths.d.ts src/lib/paths.js src/lib/time.d.ts src/lib/time.js src/lib/types.d.ts src/lib/types.js src/presets.d.ts src/presets.js src/state/chat-sessions.d.ts src/state/chat-sessions.js src/state/runtime-db.d.ts src/state/runtime-db.js src/types/better-sqlite3.d.ts` prints only `src/types/better-sqlite3.d.ts`.
- `.gitignore` contains `src/**/*.js`, `src/**/*.d.ts`, and `!src/types/better-sqlite3.d.ts`.
- `tests/benchmark-spec-settings.test.ts` fails before deletion and passes after deletion.
- `npm test -- tests\benchmark-spec-settings.test.ts` passes.
- `npm run typecheck` passes.
- `npm test` passes.
- No runtime source imports or package exports are changed.
- No compatibility shim or fallback path is introduced.

## Risk Notes

- Risk is low because the deleted files are generated siblings of existing `.ts` source files and are not part of the intended `dist` runtime output.
- The only protected exception is `src/types/better-sqlite3.d.ts`, an intentional ambient declaration with no `.ts` source sibling.
- If a current test or script imports one of the deleted `src/.../*.js` files through plain Node semantics, that is a real failure and should be fixed by importing the `.ts` source through `tsx` or the compiled `dist` output. Do not restore deleted artifacts.

## SiftKit Command Compliance

- Initial discovery must attempt `siftkit repo-search` with a specific extraction prompt.
- If the SiftKit status/config server is unreachable, stop retrying it and use direct targeted repo reads.
- Raw follow-up commands in this plan are narrow and use exact files or exact Git pathspecs.
