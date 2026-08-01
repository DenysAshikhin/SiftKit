# Dead-Port Constant Consolidation + Unused-Vars Gate Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the repo-wide `varsIgnorePattern: '^_'` escape hatch from the no-unused-vars gate, and collapse every copy of the dead-port URL `http://127.0.0.1:1` (2 named constants + 33 inline literals across 13 test files) onto the single existing `DEAD_BASE_URL`, with gate tests that make both re-drifts fail loud.

**Architecture:** Both fixes are made permanent by an executable gate before the cleanup lands, so each task is a real red-green cycle. The unused-vars fix adds a fixture to the existing `tests/eslint-gate.test.ts` harness (which lints `tests/fixtures/eslint-gate/*` with `--no-ignore` and asserts on the JSON result); the dead-port fix adds a source-scan test to the existing `tests/test-hygiene-gate.test.ts` harness (which walks `tests/**` and asserts an offender list is empty). No new harness, no new pattern.

**Tech Stack:** TypeScript (ESM, `tsx`), `node:test` + `node:assert/strict`, `typescript-eslint` flat config, zod for the lint-output DTO.

---

## File Structure

**Created:**
- `tests/fixtures/eslint-gate/unused-var.ts` — a fixture whose only lint error is an unused `_`-prefixed `const`. Sits alongside `cast.ts`, `namespace.ts`, `explicit-any.ts` etc.
- `tests/helpers/mock-loop-defaults.ts` — the one `createMockLoopDefaults(tempDirPrefix)` factory that replaces the three copies of `MOCK_LOOP_DEFAULTS`.

**Modified:**
- `eslint.config.mjs:24-27, 47-61` — drop `varsIgnorePattern`, register the new fixture in `ignores`.
- `tests/eslint-gate.test.ts:87` — one new gate test.
- `tests/http-client.test.ts:41-233` — add a `drainSse` helper, rewrite the 6 `_frame` loops.
- `tests/test-hygiene-gate.test.ts:51` — one new gate test.
- `tests/helpers/mock-config.ts:24-34` — delete `MOCK_OFFLINE_BASE_URL`, use `DEAD_BASE_URL`.
- 13 test files — swap the inline literal for the imported constant (enumerated in Task 3).
- `tests/mock-repo-search-loop.test.ts:29-38`, `tests/repo-search-loop.core.test.ts:27-37`, `tests/repo-search-terminal-synthesis-retry.test.ts:10-19` — use the shared factory.

**Explicitly out of scope** (found during validation, not part of findings #1/#2 — do not touch):
- The local `DeepPartial` re-declaration in `tests/mock-repo-search-loop.test.ts:43-47`.
- The hand-rolled `mockConfig` in `tests/repo-search-loop.core.test.ts:41-69` — it merges without `normalizeConfigObject`, so it is *not* a duplicate of `mockSiftConfig` and swapping it would change behaviour.
- `docs/superpowers/plans/*.md` occurrences of the literal — historical plan records.

---

## Task 1: Remove the `varsIgnorePattern` escape hatch

**Files:**
- Create: `tests/fixtures/eslint-gate/unused-var.ts`
- Modify: `eslint.config.mjs:18-27` (rule + comment), `eslint.config.mjs:47-61` (ignores)
- Modify: `tests/http-client.test.ts:41-233`
- Test: `tests/eslint-gate.test.ts`

- [ ] **Step 1: Create the lint fixture**

Create `tests/fixtures/eslint-gate/unused-var.ts`:

```ts
// Gate fixture: a `_`-prefixed variable binding that is never read. The
// no-unused-vars rule must flag it — an underscore prefix is not an opt-out.
export function unusedVariable(): number {
  const _dropped = 1;
  return 2;
}
```

- [ ] **Step 2: Register the fixture in the eslint ignores list**

In `eslint.config.mjs`, inside the `ignores` array (currently `eslint.config.mjs:47-61`), add the new entry immediately after the `broad-json-union.ts` line so a plain `npx eslint .` run stays green (the gate test lints it explicitly with `--no-ignore`):

```js
      'tests/fixtures/eslint-gate/broad-json-union.ts',
      'tests/fixtures/eslint-gate/unused-var.ts',
      'tests/fixtures/eslint-gate/declaration.d.ts',
```

- [ ] **Step 3: Write the failing gate test**

Append to `tests/eslint-gate.test.ts`, after the `'eslint gate passes clean code'` test (currently ends at line 87):

```ts
// An underscore prefix must not silence the unused-vars gate: renaming a dead
// binding to `_dead` would otherwise be a repo-wide, review-invisible opt-out.
test('eslint gate flags unused underscore-prefixed variables', () => {
  const result = lintFixtureAllowingFailure('unused-var.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/no-unused-vars');
});
```

- [ ] **Step 4: Run the gate test to verify it fails**

Run: `npx tsx --test tests/eslint-gate.test.ts`

Expected: FAIL on `eslint gate flags unused underscore-prefixed variables` with `AssertionError: Expected values to be strictly equal: 0 !== 1` (errorCount is 0 because `varsIgnorePattern: '^_'` currently silences it). Every other test in the file passes.

- [ ] **Step 5: Drop `varsIgnorePattern` from the rule**

In `eslint.config.mjs`, replace lines 18-27 (the comment block and the rule) with:

```js
  // tsc's noUnusedLocals is off (it would fail the editor mid-edit), so nothing else
  // catches an import or binding a refactor stopped using. Dead references keep
  // deleted concepts looking alive; a refactor must leave none behind.
  // Unused function parameters are position-bound in an interface implementation and
  // `const { dropped, ...rest }` is the idiomatic omit, so neither counts as dead.
  // There is deliberately no varsIgnorePattern: an unused variable has a real fix.
  '@typescript-eslint/no-unused-vars': [
    'error',
    { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
  ],
```

- [ ] **Step 6: Run eslint to see the 6 real violations**

Run: `npx eslint tests/http-client.test.ts`

Expected: 6 errors, all `'_frame' is assigned a value but never used  @typescript-eslint/no-unused-vars`, at lines 74, 79, 146, 176, 203, 223.

- [ ] **Step 7: Add the `drainSse` helper to the test file**

In `tests/http-client.test.ts`, insert after the `writeSse` function (which currently ends at line 48), before the first `test(` at line 50:

```ts
/** Consumes an SSE stream to completion and returns every frame it yielded. */
async function drainSse(stream: AsyncIterable<SseFrame>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of stream) {
    frames.push(frame);
  }
  return frames;
}
```

`SseFrame` is already imported at `tests/http-client.test.ts:13`. `HttpClient.streamSse` returns `AsyncGenerator<SseFrame>` (`src/lib/http-client.ts:205`), which satisfies `AsyncIterable<SseFrame>`.

- [ ] **Step 8: Rewrite the two drain loops in the sequential-socket test**

In `tests/http-client.test.ts`, replace the body of `'HttpClient.streamSse opens a fresh socket per sequential call'` (currently lines 73-84, from `try {` through the `assert.equal(server.connectionCount(), 2);`) with:

```ts
  try {
    const first = await drainSse(client.streamSse({
      url: `${server.baseUrl}/v1/chat/completions`, body: '{}', idleTimeoutMs: 5_000,
    }));
    const second = await drainSse(client.streamSse({
      url: `${server.baseUrl}/v1/chat/completions`, body: '{}', idleTimeoutMs: 5_000,
    }));
    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(server.connectionCount(), 2);
```

(Each stream yields the one `hi` delta plus the `[DONE]` frame, matching the frame shape asserted at lines 105-109.)

- [ ] **Step 9: Rewrite the 503-rejection drain loop**

In `tests/http-client.test.ts`, in `'HttpClient.streamSse rejects with HttpResponseError carrying status and body on >= 400'`, replace the `iterate` definition (currently lines 145-151) with:

```ts
    const iterate = async (): Promise<void> => {
      await drainSse(client.streamSse({
        url: `${server.baseUrl}/v1/chat/completions`, body: '{}', idleTimeoutMs: 5_000,
      }));
    };
```

- [ ] **Step 10: Rewrite the abort-mid-stream loop**

In `tests/http-client.test.ts`, in `'HttpClient.streamSse rejects with the abort reason when the signal aborts mid-stream'`, replace lines 173-191 (from `try {` through the closing of `assert.rejects`) with:

```ts
  try {
    const controller = new AbortController();
    const frames: SseFrame[] = [];
    const iterate = async (): Promise<void> => {
      for await (const frame of client.streamSse({
        url: `${server.baseUrl}/v1/chat/completions`,
        body: '{}',
        idleTimeoutMs: 5_000,
        abortSignal: controller.signal,
      })) {
        frames.push(frame);
        controller.abort(new Error('caller cancelled the stream'));
      }
    };
    await assert.rejects(
      iterate,
      /caller cancelled the stream/u,
    );
    // The partial delta must have been delivered before the abort took effect.
    assert.equal(frames.length, 1);
```

This keeps a `for await` (the abort has to fire from inside the loop body, on the first frame) but now consumes the binding and asserts what arrived.

- [ ] **Step 11: Rewrite the early-break loop**

In `tests/http-client.test.ts`, in `'HttpClient.streamSse destroys the request when iteration stops early'`, replace lines 202-209 (from `try {` through `assert.equal(requestClosed, true);`) with:

```ts
  try {
    const frames: SseFrame[] = [];
    for await (const frame of client.streamSse({
      url: `${server.baseUrl}/v1/chat/completions`, body: '{}', idleTimeoutMs: 5_000,
    })) {
      frames.push(frame);
      break;
    }
    assert.equal(frames.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requestClosed, true);
```

- [ ] **Step 12: Rewrite the idle-timeout drain loop**

In `tests/http-client.test.ts`, in `'HttpClient.streamSse applies an idle timeout to a silent stream'`, replace the `iterate` definition (currently lines 222-228) with:

```ts
    const iterate = async (): Promise<void> => {
      await drainSse(client.streamSse({
        url: `${server.baseUrl}/operation`, body: '{}', idleTimeoutMs: 100,
      }));
    };
```

- [ ] **Step 13: Verify lint is clean repo-wide**

Run: `npx eslint .`

Expected: exit 0, no output. Specifically: zero `no-unused-vars` errors.

- [ ] **Step 14: Verify both affected suites pass**

Run: `npx tsx --test tests/eslint-gate.test.ts tests/http-client.test.ts`

Expected: all tests pass, including `eslint gate flags unused underscore-prefixed variables`. Confirm the count of `pass` equals the count of `tests` and `fail 0`.

- [ ] **Step 15: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit 0, no output.

- [ ] **Step 16: Commit**

```bash
git add eslint.config.mjs tests/fixtures/eslint-gate/unused-var.ts tests/eslint-gate.test.ts tests/http-client.test.ts
git commit -m "refactor(lint): drop varsIgnorePattern and consume the drained SSE frames"
```

---

## Task 2: Gate the dead-port literal

**Files:**
- Modify: `tests/test-hygiene-gate.test.ts` (append after line 51)

- [ ] **Step 1: Write the failing hygiene test**

Append to `tests/test-hygiene-gate.test.ts`:

```ts
// `http://127.0.0.1:1` is the closed port sandboxed tests point at so an unstubbed
// call fails fast with ECONNREFUSED instead of reaching the developer's live SiftKit.
// It has exactly one definition, DEAD_BASE_URL in tests/helpers/dead-endpoints.ts;
// inline copies drift the day the port changes. The needle is built from fragments
// so this gate file does not match itself.
test('hygiene: no test inlines the dead-port URL instead of importing DEAD_BASE_URL', () => {
  const allowed = new Set([path.join(TESTS_DIR, 'helpers', 'dead-endpoints.ts')]);
  const offenders = filesMatching(new RegExp("'http://127\\.0\\.0\\.1:" + "1'")).filter(
    (file) => !allowed.has(file),
  );
  assert.deepEqual(offenders, []);
});
```

`TESTS_DIR`, `filesMatching`, `path` and `assert` are already defined/imported at the top of that file (lines 1-23).

- [ ] **Step 2: Run it to verify it fails and lists every offender**

Run: `npx tsx --test tests/test-hygiene-gate.test.ts`

Expected: FAIL on the new test. The assertion diff lists **13** files: `approval-verdict-request.test.ts`, `host-sync.test.ts`, `llama-cpp.test.ts`, `llm-auto-approval.test.ts`, `managed-tabby.test.ts`, `mock-repo-search-loop.test.ts`, `repo-search-agent-execute.test.ts`, `repo-search-chat-execute.test.ts`, `repo-search-chat-loop.test.ts`, `repo-search-loop.core.test.ts`, `repo-search-terminal-synthesis-retry.test.ts`, `tabby-model-client.test.ts`, `tool-action-approval.test.ts`, plus `helpers/mock-config.ts`. The other four tests in the file pass.

If the list differs from the 14 above, stop and reconcile before continuing — a file was added or moved since this plan was written.

- [ ] **Step 3: Commit the red gate**

```bash
git add tests/test-hygiene-gate.test.ts
git commit -m "test(hygiene): gate inline copies of the dead-port URL"
```

Committing red is deliberate here: Task 3 is the fix and the two commits are reviewed together. If your workflow forbids a red commit, fold Steps 1-3 into Task 3 and commit once at the end.

---

## Task 3: Collapse every dead-port copy onto `DEAD_BASE_URL`

**Files:**
- Modify: `tests/helpers/mock-config.ts:24-34`
- Modify: the 13 test files listed below
- Test: `tests/test-hygiene-gate.test.ts` (from Task 2)

- [ ] **Step 1: Delete `MOCK_OFFLINE_BASE_URL`**

In `tests/helpers/mock-config.ts`, replace lines 24-34 with:

```ts
export function mockOfflineSiftConfig(): SiftConfig {
  return mockSiftConfig({ Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL } } });
}
```

and add the import after line 5 (`import { mergeConfig, normalizeConfigObject } ...`):

```ts
import { DEAD_BASE_URL } from './dead-endpoints.js';
```

The rationale that lived in the deleted doc comment ("the default config's BaseUrl is the real llama.cpp port…") is already stated at `tests/helpers/dead-endpoints.ts:3-7`. Do not restate it.

- [ ] **Step 2: Replace the literal across all 13 test files**

Run this from the repo root. It rewrites only the exact quoted literal, so `127.0.0.1:9999`, `127.0.0.1:1234` and `${server.baseUrl}` interpolations are untouched:

```powershell
$files = @(
  'tests/approval-verdict-request.test.ts','tests/host-sync.test.ts','tests/llama-cpp.test.ts',
  'tests/llm-auto-approval.test.ts','tests/managed-tabby.test.ts','tests/mock-repo-search-loop.test.ts',
  'tests/repo-search-agent-execute.test.ts','tests/repo-search-chat-execute.test.ts',
  'tests/repo-search-chat-loop.test.ts','tests/repo-search-loop.core.test.ts',
  'tests/repo-search-terminal-synthesis-retry.test.ts','tests/tabby-model-client.test.ts',
  'tests/tool-action-approval.test.ts'
)
foreach ($f in $files) {
  $text = Get-Content $f -Raw
  $updated = $text.Replace("'http://127.0.0.1:1'", 'DEAD_BASE_URL')
  if ($updated -ne $text) { Set-Content -Path $f -Value $updated -Encoding utf8 -NoNewline }
}
```

Expected occurrence counts replaced per file: `approval-verdict-request` 2, `host-sync` 5, `llama-cpp` 2, `llm-auto-approval` 2, `managed-tabby` 1, `mock-repo-search-loop` 1, `repo-search-agent-execute` 1, `repo-search-chat-execute` 3, `repo-search-chat-loop` 10, `repo-search-loop.core` 2, `repo-search-terminal-synthesis-retry` 1, `tabby-model-client` 1, `tool-action-approval` 2 — **33 total**.

- [ ] **Step 3: Extend the two files that already import from `dead-endpoints.js`**

In `tests/repo-search-agent-execute.test.ts`, replace line 11:

```ts
import { DEAD_BASE_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';
```

In `tests/repo-search-chat-execute.test.ts`, replace line 9:

```ts
import { DEAD_BASE_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';
```

- [ ] **Step 4: Add the import to the remaining 11 files**

Insert `import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';` immediately after the anchor line in each file:

| File | Insert after this existing line |
|---|---|
| `tests/approval-verdict-request.test.ts` | `19: import { createManagedTempDir } from './helpers/temp-dirs.js';` |
| `tests/host-sync.test.ts` | `4: import { getAddressInfo } from './helpers/dashboard-http.js';` |
| `tests/llama-cpp.test.ts` | `15: import { mockSiftConfig } from './helpers/mock-config.js';` |
| `tests/llm-auto-approval.test.ts` | `20: import { createManagedTempDir } from './helpers/temp-dirs.js';` |
| `tests/managed-tabby.test.ts` | `13: import { FakeTabbyModelState, writeFakeTabby } from './helpers/tabby-fake.js';` |
| `tests/mock-repo-search-loop.test.ts` | `27: import { createManagedTempDir } from './helpers/temp-dirs.js';` |
| `tests/repo-search-chat-loop.test.ts` | `12: import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';` |
| `tests/repo-search-loop.core.test.ts` | `25: import { createManagedTempDir } from './helpers/temp-dirs.js';` |
| `tests/repo-search-terminal-synthesis-retry.test.ts` | `8: import { createManagedTempDir } from './helpers/temp-dirs.js';` |
| `tests/tabby-model-client.test.ts` | `8: import { FakeTabbyModelState } from './helpers/tabby-fake.js';` |
| `tests/tool-action-approval.test.ts` | `12: import { createManagedTempDir } from './helpers/temp-dirs.js';` |

Line numbers are pre-Step-2 positions and Step 2 does not add or remove lines, so they still hold. If an anchor line does not read exactly as shown, stop and reconcile.

- [ ] **Step 5: Drop the now-dead `MOCK_OFFLINE_BASE_URL` import**

In `tests/mock-repo-search-loop.test.ts`, line 23 currently reads:

```ts
import { MOCK_OFFLINE_BASE_URL, mockOfflineSiftConfig, mockSiftConfig } from './helpers/mock-config.js';
```

Replace it with:

```ts
import { mockOfflineSiftConfig, mockSiftConfig } from './helpers/mock-config.js';
```

and change line 35 (`baseUrl: MOCK_OFFLINE_BASE_URL,` inside `MOCK_LOOP_DEFAULTS`) to `baseUrl: DEAD_BASE_URL,`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit 0. A `Cannot find name 'DEAD_BASE_URL'` here means Step 3 or 4 missed a file — add the import there.

- [ ] **Step 7: Run the hygiene gate to verify it now passes**

Run: `npx tsx --test tests/test-hygiene-gate.test.ts`

Expected: all 5 tests pass, `fail 0`.

- [ ] **Step 8: Run every touched suite**

Run:

```bash
npx tsx --test tests/approval-verdict-request.test.ts tests/host-sync.test.ts tests/llama-cpp.test.ts tests/llm-auto-approval.test.ts tests/managed-tabby.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-agent-execute.test.ts tests/repo-search-chat-execute.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/tabby-model-client.test.ts tests/tool-action-approval.test.ts
```

Expected: `fail 0`. These are behaviour-preserving substitutions of an identical string; any failure is a missed import or a mangled file, not a real behaviour change.

- [ ] **Step 9: Lint**

Run: `npx eslint .`

Expected: exit 0, no output.

- [ ] **Step 10: Commit**

```bash
git add tests/helpers/mock-config.ts tests/*.test.ts
git commit -m "refactor(tests): route every dead-port reference through DEAD_BASE_URL"
```

---

## Task 4: Share the mock-loop defaults fixture

**Files:**
- Create: `tests/helpers/mock-loop-defaults.ts`
- Modify: `tests/mock-repo-search-loop.test.ts:29-38`, `tests/repo-search-loop.core.test.ts:27-37`, `tests/repo-search-terminal-synthesis-retry.test.ts:10-19`

- [ ] **Step 1: Create the shared factory**

Create `tests/helpers/mock-loop-defaults.ts`:

```ts
import { DEAD_BASE_URL } from './dead-endpoints.js';
import { createEmptyPresetSystemContext } from './empty-preset-system-context.js';
import { mockOfflineSiftConfig } from './mock-config.js';
import { createManagedTempDir } from './temp-dirs.js';

/**
 * The required RunTaskLoopOptions fields for a mock-mode loop, which never reaches a
 * real provider or repo: a fresh empty temp repo root, a placeholder model, and a
 * config whose BaseUrl is a closed port so an unstubbed tokenize call fails fast.
 * Per-test options override individual fields.
 */
export function createMockLoopDefaults(tempDirPrefix: string) {
  return {
    repoRoot: createManagedTempDir(tempDirPrefix),
    model: 'mock-model',
    baseUrl: DEAD_BASE_URL,
    systemContext: createEmptyPresetSystemContext(),
    config: mockOfflineSiftConfig(),
  };
}
```

The return type is inferred end-to-end; do not annotate it.

- [ ] **Step 2: Use it in `tests/mock-repo-search-loop.test.ts`**

Replace lines 29-38 (the comment block, `MOCK_LOOP_REPO_ROOT`, and `MOCK_LOOP_DEFAULTS`) with:

```ts
const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-mock-loop-');
```

Then fix the imports:

- Delete line 26 (`import { createEmptyPresetSystemContext } ...`) — its only call site was the deleted `MOCK_LOOP_DEFAULTS`.
- Change line 23 to `import { mockSiftConfig } from './helpers/mock-config.js';` — `mockOfflineSiftConfig`'s only call site was the deleted `MOCK_LOOP_DEFAULTS`.
- **Keep** the `createManagedTempDir` import (line 27): still used at line 115.
- **Keep** the `DEAD_BASE_URL` import added in Task 3: still used at line 2095.
- Add:

```ts
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
```

- [ ] **Step 3: Use it in `tests/repo-search-loop.core.test.ts`**

Replace lines 27-37 (the comment block, `MOCK_LOOP_REPO_ROOT`, and `MOCK_LOOP_DEFAULTS`) with:

```ts
const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-mock-loop-');
```

Add `import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';` after line 25.

Every existing import in this file stays: `createManagedTempDir` is still used at line 72, `createEmptyPresetSystemContext` at lines 98/125/182/431/1024/1144/1251/1332/1406, `mockOfflineSiftConfig` at line 183, and `DEAD_BASE_URL` at line 630.

Leave the hand-rolled `mockConfig` at lines 41-69 alone — it is out of scope (see File Structure).

- [ ] **Step 4: Use it in `tests/repo-search-terminal-synthesis-retry.test.ts`**

Replace lines 10-19 (the comment block and `MOCK_LOOP_DEFAULTS`) with:

```ts
const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-syn-loop-');
```

Then delete lines 6, 7 and 8 outright plus the `DEAD_BASE_URL` import added in Task 3 — `createEmptyPresetSystemContext`, `mockOfflineSiftConfig`, `createManagedTempDir` and `DEAD_BASE_URL` each had exactly one call site in this file, all inside the deleted `MOCK_LOOP_DEFAULTS`. In their place add:

```ts
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
```

The file's import block then holds exactly: `node:test`, `node:assert/strict`, `runTaskLoop` from `../src/repo-search/engine.js`, the `JsonSerializable` type, and `createMockLoopDefaults`.

- [ ] **Step 5: Lint to find every import left dangling**

Run: `npx eslint tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-terminal-synthesis-retry.test.ts`

Expected: exit 0 if Steps 2-4 removed exactly the imports listed there. Any remaining `is defined but never used` error names an import one of those steps missed — delete it and re-run until exit 0. This is the Task 1 gate paying for itself: without it, `noUnusedLocals` being off means dangling imports would land silently.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit 0.

- [ ] **Step 7: Run the three suites**

Run: `npx tsx --test tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-terminal-synthesis-retry.test.ts`

Expected: `fail 0`.

- [ ] **Step 8: Full suite**

Run: `npm test`

Expected: `fail 0`. Compare against a pre-change baseline if any failure looks unrelated.

- [ ] **Step 9: Commit**

```bash
git add tests/helpers/mock-loop-defaults.ts tests/mock-repo-search-loop.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-terminal-synthesis-retry.test.ts
git commit -m "refactor(tests): share one mock-loop defaults factory across the loop suites"
```

---

## Verification summary

After Task 4, all of the following must hold:

| Check | Command | Expected |
|---|---|---|
| No unused-vars escape hatch | `grep -c varsIgnorePattern eslint.config.mjs` | `0` |
| Gate catches `_`-prefixed dead vars | `npx tsx --test tests/eslint-gate.test.ts` | `fail 0` |
| One dead-port definition | `grep -rn "'http://127.0.0.1:1'" tests/` | only `tests/helpers/dead-endpoints.ts:8` |
| Gate catches re-drift | `npx tsx --test tests/test-hygiene-gate.test.ts` | `fail 0` |
| Lint clean | `npx eslint .` | exit 0 |
| Types clean | `npx tsc --noEmit` | exit 0 |
| Suite green | `npm test` | `fail 0` |
