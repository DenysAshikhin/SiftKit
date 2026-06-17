# F6 + F14 — Unit-test Pyramid Recovery & Runtime-Harness Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `dist`/`src` test split-brain, type the `@ts-nocheck` runtime harness, build fast unit tests on the route/runner seams, thin the giant E2E suites, and isolate the env-var mock seam from the production path.

**Architecture:** Six phased stages, each ending green (`npm run typecheck` + `npm test`). The `tsconfig.test.json` typecheck allowlist grows per phase and is swapped to `tests/**/*.ts` in the final phase. A permanent regression-gate test forbids reintroducing `../dist` imports or `@ts-nocheck` in `tests/`.

**Tech Stack:** TypeScript 5.9, `tsx` (runs tests, no typechecking), `node:test`, `node:assert/strict`, `better-sqlite3`, `c8` (coverage), PowerShell on Windows.

**Source spec:** `docs/superpowers/specs/2026-06-16-f6-f14-test-pyramid-typing-design.md`

---

## Conventions for every task

- **TDD strictly:** write the failing test, run it RED, implement minimally, run it GREEN, commit.
- **Run a single test file:** `npx tsx --test tests/<file>.test.ts`
- **Run the typecheck gate:** `npm run typecheck:test`
- **Run the full suite:** `npm test`
- **No `any`/`unknown`** in test or production code unless narrowing immediately; prefer explicit types.
- **Commit message trailer** (all commits):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- Windows shell is PowerShell. For commit messages use a single-quoted here-string (`@'` … `'@`, closing token at column 0).

---

## File Structure

**New test-helper modules (Phase 1)** — `tests/helpers/` (split out of `tests/_runtime-helpers.ts`):
- `tests/helpers/status-server-harness.ts` — spawn/lifecycle/teardown of the status server for tests (typed).
- `tests/helpers/config-fixtures.ts` — config builders & oversized-input fixtures (typed).
- `tests/helpers/runtime-assertions.ts` — shared assertions (typed).
- `tests/_runtime-helpers.ts` — becomes a thin typed re-export barrel of the above (keeps the ~30 importers working), `@ts-nocheck` removed.
- `tests/helpers/runtime-benchmark-repro.ts` — typed replacement for `runtime-benchmark-repro.js`.

**New production module (Phase 5):**
- `src/summary/providers/mock-provider.ts` — the `mock` backend implementation; sole owner of `SIFTKIT_TEST_*` env reads.
- Modify: `src/summary/provider-invoke.ts` (delegate mock path), `src/summary/mock.ts` (move env-reading `getMockSummary` out of the shared module).

**New test files (Phase 0 & 3):**
- `tests/test-hygiene-gate.test.ts` — regression gate (no `../dist` imports, no `@ts-nocheck`).
- `tests/routes-chat-helpers.test.ts` — pure chat-route helpers.
- `tests/repo-search-request-normalizers.test.ts` — `normalizeRepoSearchMockCommandResults`.
- `tests/routes-core-lease.test.ts` — extracted lease-endpoint handlers.
- `tests/preset-runner.test.ts` — extracted `StatusPresetRunner` units.
- `tests/summary-request-runner-units.test.ts` — extracted `SummaryRequestRunner` units.

**Config/script changes:**
- `tsconfig.test.json` — allowlist grows per phase, then `tests/**/*.ts`.
- `package.json` — `test:coverage` repointed to `src/**`.
- `ARCHITECTURE-REVIEW.md` — F6/F14 marked resolved; `findMockResult` reclassified.

---

# Phase 0 — Gate & coverage foundation

### Task 0.1: Add the hygiene regression gate (initially skipped)

**Files:**
- Create: `tests/test-hygiene-gate.test.ts`

- [ ] **Step 1: Write the test (two skipped subtests + one active enumerator)**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TESTS_DIR = path.resolve(import.meta.dirname);

function listTestSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(TESTS_DIR);
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return listTestSources().filter((file) => pattern.test(fs.readFileSync(file, 'utf8')));
}

test('hygiene: there is at least one test source to scan', () => {
  assert.ok(listTestSources().length > 0);
});

// Enabled in Phase 6 (flip skip -> active).
test('hygiene: no test imports from ../dist', { skip: true }, () => {
  assert.deepEqual(filesMatching(/from ['"]\.\.\/dist/), []);
});

test('hygiene: no test file uses @ts-nocheck', { skip: true }, () => {
  assert.deepEqual(filesMatching(/@ts-nocheck/), []);
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/test-hygiene-gate.test.ts`
Expected: PASS (1 active test passes, 2 skipped).

- [ ] **Step 3: Commit**

```
git add tests/test-hygiene-gate.test.ts
git commit -m "test(hygiene): add dist-import / ts-nocheck regression gate (skipped)"
```

### Task 0.2: Repoint coverage to `src/**`

**Files:**
- Modify: `package.json:26-27`

- [ ] **Step 1: Edit the coverage scripts**

Replace the `test:coverage` line value with:

```
npm run build:test && npx c8 --include=\"src/**/*.ts\" --exclude=\"node_modules/**\" --exclude=\"tests/**\" --reporter=text --reporter=text-summary npx tsx --test
```

(Leave `test:coverage:llm` as-is — it already targets `src/`.)

- [ ] **Step 2: Run coverage to confirm it instruments src**

Run: `npm run test:coverage`
Expected: text-summary report lists `src/...` files (not `dist/...`). Some failures are acceptable here only if pre-existing; the goal is that the include glob resolves to `src`.

- [ ] **Step 3: Commit**

```
git add package.json
git commit -m "test(coverage): instrument src/** instead of dist/**"
```

---

# Phase 1 — Type the shared harness (F14 core)

> Goal: remove every `@ts-nocheck` from `tests/_runtime-helpers.ts` and `tests/helpers/`, split the 1685-line monolith into focused typed modules, and add them to the typecheck allowlist. The ~30 importers of `_runtime-helpers.ts` keep working because it becomes a typed re-export barrel.

### Task 1.1: Inventory the harness public surface

**Files:**
- Read: `tests/_runtime-helpers.ts`, `tests/helpers/runtime-config.ts`, `tests/helpers/runtime-http.ts`

- [ ] **Step 1: List every symbol importers consume**

Run: `npx tsx -e "import * as h from './tests/_runtime-helpers.ts'; console.log(Object.keys(h).sort().join('\n'))"`
Expected: a printed list of exported names. Save it — every name must remain exported from the barrel after the split.

- [ ] **Step 2: Group the symbols by responsibility**

Write the grouping into a scratch comment block (server-spawn/lifecycle → `status-server-harness.ts`; config builders/fixtures → `config-fixtures.ts`; assertions → `runtime-assertions.ts`; HTTP already in `runtime-http.ts`; config readers already in `runtime-config.ts`). No commit yet (no code change).

### Task 1.2: Extract the typed `config-fixtures` module

**Files:**
- Create: `tests/helpers/config-fixtures.ts`
- Modify: `tests/_runtime-helpers.ts` (remove the moved functions; re-export from the new module)

- [ ] **Step 1: Write a failing test for one moved fixture**

Create `tests/helpers/config-fixtures.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOversizedTransitionsInput } from './config-fixtures.ts';

test('buildOversizedTransitionsInput returns a string above the chunk threshold', () => {
  const input = buildOversizedTransitionsInput();
  assert.equal(typeof input, 'string');
  assert.ok(input.length > 10_000);
});
```

- [ ] **Step 2: Run it RED**

Run: `npx tsx --test tests/helpers/config-fixtures.test.ts`
Expected: FAIL — `Cannot find module './config-fixtures.ts'`.

- [ ] **Step 3: Create `config-fixtures.ts` with typed signatures**

Move the config-builder/fixture functions (e.g. `getDefaultConfig`, `clone`, `mergeConfig`, `buildOversizedTransitionsInput`, `buildOversizedRunnerStateHistoryInput`, `buildStructuredStubDecision`) from `_runtime-helpers.ts`/`runtime-config.ts` ownership into this file with explicit parameter and return types. Import the real config types from `../../src/config/...` and the summary types from `../../src/summary/types.ts`. Example signature shape:

```typescript
import type { SiftConfig } from '../../src/config/types.ts';

export function buildOversizedTransitionsInput(): string {
  // moved body, unchanged logic, now typed
}
```

- [ ] **Step 4: Re-export from the barrel**

In `tests/_runtime-helpers.ts`, replace the moved definitions with:

```typescript
export {
  buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput,
  buildStructuredStubDecision,
  // ...all moved names
} from './helpers/config-fixtures.ts';
```

- [ ] **Step 5: Run the new test + a sample importer GREEN**

Run: `npx tsx --test tests/helpers/config-fixtures.test.ts`
Expected: PASS.
Run: `npx tsx --test tests/runtime-loadconfig.test.ts`
Expected: PASS (barrel still resolves).

- [ ] **Step 6: Commit**

```
git add tests/helpers/config-fixtures.ts tests/helpers/config-fixtures.test.ts tests/_runtime-helpers.ts
git commit -m "test(harness): extract typed config-fixtures module"
```

### Task 1.3: Extract the typed `status-server-harness` module

**Files:**
- Create: `tests/helpers/status-server-harness.ts`
- Modify: `tests/_runtime-helpers.ts`

- [ ] **Step 1: Write a failing smoke test**

Create `tests/helpers/status-server-harness.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusServerHarness } from './status-server-harness.ts';

test('StatusServerHarness exposes typed start/stop', () => {
  const harness = new StatusServerHarness();
  assert.equal(typeof harness.start, 'function');
  assert.equal(typeof harness.stop, 'function');
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/helpers/status-server-harness.test.ts`
Expected: FAIL — module/class not found.

- [ ] **Step 3: Implement the typed harness class**

Move the server spawn/lifecycle/teardown logic from `_runtime-helpers.ts` into a `StatusServerHarness` class with typed members. Convert the existing free functions (spawn, wait-for-ready, teardown, temp-dir setup) into methods. Use `import { spawn, ChildProcess } from 'node:child_process'` with explicit `ChildProcess` typing; type the readiness-poll return and the server-handle struct.

```typescript
import { spawn, type ChildProcess } from 'node:child_process';

export interface StatusServerHandle {
  process: ChildProcess;
  baseUrl: string;
  runtimeRoot: string;
}

export class StatusServerHarness {
  private handle: StatusServerHandle | null = null;
  async start(options: { /* typed options moved from the free function */ }): Promise<StatusServerHandle> { /* moved body */ }
  async stop(): Promise<void> { /* moved teardown */ }
}
```

Re-export the class (and any thin wrapper functions importers still call) from the barrel.

- [ ] **Step 4: Run GREEN + a real consumer**

Run: `npx tsx --test tests/helpers/status-server-harness.test.ts`
Expected: PASS.
Run: `npx tsx --test tests/runtime-status-server.lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add tests/helpers/status-server-harness.ts tests/helpers/status-server-harness.test.ts tests/_runtime-helpers.ts
git commit -m "test(harness): extract typed StatusServerHarness class"
```

### Task 1.4: Extract typed `runtime-assertions` and finish the barrel

**Files:**
- Create: `tests/helpers/runtime-assertions.ts`
- Modify: `tests/_runtime-helpers.ts` (remove `@ts-nocheck`; becomes pure typed barrel)

- [ ] **Step 1: Move remaining shared assertions** into `runtime-assertions.ts` with explicit types; re-export from the barrel.

- [ ] **Step 2: Remove `@ts-nocheck` from `tests/_runtime-helpers.ts`**

Delete line 1 (`// @ts-nocheck …`). The file should now contain only typed re-exports and any small typed glue.

- [ ] **Step 3: Typecheck the barrel in isolation**

Run: `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict tests/_runtime-helpers.ts tests/helpers/config-fixtures.ts tests/helpers/status-server-harness.ts tests/helpers/runtime-assertions.ts`
Expected: no errors. Fix any type errors revealed.

- [ ] **Step 4: Run a broad sample of importers**

Run: `npx tsx --test tests/runtime-status-server.test.ts tests/runtime-cli.test.ts tests/runtime-summarize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add tests/helpers/runtime-assertions.ts tests/_runtime-helpers.ts
git commit -m "test(harness): type runtime-assertions; _runtime-helpers becomes typed barrel"
```

### Task 1.5: Convert `runtime-benchmark-repro.js` to typed TS

**Files:**
- Create: `tests/helpers/runtime-benchmark-repro.ts`
- Delete: `tests/helpers/runtime-benchmark-repro.js`
- Modify: importers of the `.js` helper (the `tests/runtime-benchmark.repro-*.test.ts` files)

- [ ] **Step 1: Find importers**

Run: `npx tsx -e "process.stdout.write('')"` then search: use the Grep tool for `runtime-benchmark-repro` across `tests/`. Note each importing file.

- [ ] **Step 2: Port the file to typed TS**

Recreate the logic in `runtime-benchmark-repro.ts` with explicit types (remove `@ts-nocheck`). Update importers' specifiers from `runtime-benchmark-repro.js` → `runtime-benchmark-repro.ts`.

- [ ] **Step 3: Run the repro suites**

Run: `npx tsx --test tests/runtime-benchmark.repro-valid.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete the `.js`**

```
git rm tests/helpers/runtime-benchmark-repro.js
```

- [ ] **Step 5: Commit**

```
git add tests/helpers/runtime-benchmark-repro.ts tests/runtime-benchmark.repro-valid.test.ts tests/runtime-benchmark.repro-range.test.ts tests/runtime-benchmark.repro-malformed.test.ts
git commit -m "test(harness): port runtime-benchmark-repro to typed TS"
```

### Task 1.6: Add the typed helpers to the typecheck allowlist

**Files:**
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Add helper globs to `include`**

Add these entries to the `include` array:

```json
"tests/_runtime-helpers.ts",
"tests/helpers/**/*.ts",
"tests/test-hygiene-gate.test.ts",
"tests/helpers/config-fixtures.test.ts",
"tests/helpers/status-server-harness.test.ts"
```

- [ ] **Step 2: Run the typecheck gate**

Run: `npm run typecheck:test`
Expected: PASS (0 errors). Fix any surfaced errors in the helpers.

- [ ] **Step 3: Commit**

```
git add tsconfig.test.json
git commit -m "test(typecheck): include typed harness helpers in tsconfig.test.json"
```

---

# Phase 2 — Import migration (`../dist` → `../src`) (F6)

> Goal: every in-process test import resolves to `../src`. Subprocess-E2E tests still drive the built binary; only their in-process imports move. After this phase coverage reflects real source.

### Task 2.1: Enumerate `../dist` importers

**Files:** none (discovery)

- [ ] **Step 1: List files and their dist specifiers**

Use the Grep tool: pattern `from ['"]\.\.\/dist`, path `tests/`, output mode `content`, `-n true`. Record the 44 files and each imported specifier.

- [ ] **Step 2: Spot the path mapping rule**

For each `../dist/<p>.js` import, the source equivalent is `../src/<p>.ts`. Confirm a sample path exists: for `../dist/config/index.js` confirm `src/config/index.ts` exists (it does).

### Task 2.2: Migrate imports file-by-file (repeat per file)

> Do this in small batches (5–8 files per commit) so a regression bisects cleanly. The steps below are one batch; repeat until zero `../dist` imports remain.

**Files:** the batch of test files under migration.

- [ ] **Step 1: Rewrite specifiers in the batch**

For each file, change every `from '../dist/<path>.js'` → `from '../src/<path>.ts'`. Do not change subprocess invocations that execute `bin/siftkit.js` or `dist/...` paths as *runtime targets* (those are intentional — the binary runs built code); only change ES import specifiers.

- [ ] **Step 2: Run the migrated batch**

Run: `npx tsx --test tests/<file-a>.test.ts tests/<file-b>.test.ts ...`
Expected: PASS. If a symbol isn't exported from `src` (only from a dist barrel), fix the import to the correct `src` module.

- [ ] **Step 3: Commit the batch**

```
git add tests/<files>
git commit -m "test(imports): migrate <area> tests from ../dist to ../src"
```

- [ ] **Step 4: Repeat** Steps 1–3 until the Grep for `from '../dist` over `tests/` returns nothing.

### Task 2.3: Verify the whole suite under src imports

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS (typecheck:test + build:test + run-tests all green).

- [ ] **Step 2: Confirm zero dist imports**

Use the Grep tool: pattern `from ['"]\.\.\/dist`, path `tests/`. Expected: no matches.

- [ ] **Step 3: Commit (if any residual fixups)**

```
git add -A
git commit -m "test(imports): finish ../dist -> ../src migration"
```

---

# Phase 3 — Unit pyramid on the route/runner seams (F6)

> Goal: fast, typed unit tests on the 2026-06-12 seams. Start with already-exported pure helpers (no extraction), then extract well-bounded pure functions from the monoliths and test them. Every new test imports `../src` and is added to the allowlist.

### Task 3.1: Unit-test the exported chat-route pure helpers

**Files:**
- Create: `tests/routes-chat-helpers.test.ts`
- Test subject: `src/status-server/routes/chat.ts` (exports at lines 124, 226, 230, 234, 290)

- [ ] **Step 1: Write failing tests for the pure helpers**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withEffectiveWebTools,
  resolveEffectiveRepoFileListing,
  resolveEffectiveAgentsMd,
  resolveRepoSearchAutoAppendOverrides,
} from '../src/status-server/routes/chat.ts';

test('withEffectiveWebTools returns input unchanged when disabled', () => {
  assert.deepEqual(withEffectiveWebTools(['x'] as never, false), ['x']);
});

test('withEffectiveWebTools adds web tools without duplicates when enabled', () => {
  const result = withEffectiveWebTools(['web_search'] as never, true) as string[];
  assert.deepEqual([...result].sort(), ['web_fetch', 'web_search']);
});

test('withEffectiveWebTools returns undefined input unchanged', () => {
  assert.equal(withEffectiveWebTools(undefined, true), undefined);
});

test('resolveEffectiveRepoFileListing is true unless config or preset disables it', () => {
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: true }, null), true);
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: false }, null), false);
  assert.equal(resolveEffectiveRepoFileListing({ IncludeRepoFileListing: true }, { includeRepoFileListing: false }), false);
});

test('resolveEffectiveAgentsMd is true unless config or preset disables it', () => {
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: true }, null), true);
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: false }, null), false);
  assert.equal(resolveEffectiveAgentsMd({ IncludeAgentsMd: true }, { includeAgentsMd: false }), false);
});

test('resolveRepoSearchAutoAppendOverrides prefers explicit boolean overrides', () => {
  const config = { IncludeAgentsMd: true, IncludeRepoFileListing: true };
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(config, null, { includeAgentsMd: false, includeRepoFileListing: false }),
    { includeAgentsMd: false, includeRepoFileListing: false },
  );
});

test('resolveRepoSearchAutoAppendOverrides falls back to effective defaults when override absent', () => {
  const config = { IncludeAgentsMd: true, IncludeRepoFileListing: true };
  assert.deepEqual(
    resolveRepoSearchAutoAppendOverrides(config, null, {}),
    { includeAgentsMd: true, includeRepoFileListing: true },
  );
});
```

- [ ] **Step 2: Run RED then GREEN**

Run: `npx tsx --test tests/routes-chat-helpers.test.ts`
Expected: PASS immediately (these helpers already exist and are correct). If a test fails, the helper has a real bug — fix it per systematic-debugging before continuing.

- [ ] **Step 3: Add to allowlist**

Add `"tests/routes-chat-helpers.test.ts"` to `tsconfig.test.json` `include`. Run `npm run typecheck:test`. Expected: PASS.

- [ ] **Step 4: Commit**

```
git add tests/routes-chat-helpers.test.ts tsconfig.test.json
git commit -m "test(routes): unit-test chat-route pure helpers"
```

### Task 3.2: Unit-test `normalizeRepoSearchMockCommandResults`

**Files:**
- Create: `tests/repo-search-request-normalizers.test.ts`
- Test subject: `src/status-server/repo-search-request-normalizers.ts:12`

- [ ] **Step 1: Write the tests (full branch coverage)**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoSearchMockCommandResults } from '../src/status-server/repo-search-request-normalizers.ts';

test('returns undefined for non-object inputs', () => {
  assert.equal(normalizeRepoSearchMockCommandResults(null), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults('x'), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults([1, 2]), undefined);
});

test('returns undefined when no valid entries', () => {
  assert.equal(normalizeRepoSearchMockCommandResults({ cmd: 5 }), undefined);
});

test('normalizes a valid mock entry, coercing field types', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
});

test('drops non-finite numbers and non-string fields to undefined', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 'nope', stdout: 9, stderr: null, delayMs: 'x' },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: undefined, stdout: undefined, stderr: undefined, delayMs: undefined },
  });
});
```

- [ ] **Step 2: Run GREEN**

Run: `npx tsx --test tests/repo-search-request-normalizers.test.ts`
Expected: PASS.

- [ ] **Step 3: Add to allowlist + commit**

Add `"tests/repo-search-request-normalizers.test.ts"` to `tsconfig.test.json`. Run `npm run typecheck:test` (PASS).

```
git add tests/repo-search-request-normalizers.test.ts tsconfig.test.json
git commit -m "test(routes): unit-test repo-search mock-command normalizer"
```

### Task 3.3: Extract & unit-test the lease endpoint handlers from `routes/core.ts`

> `routes/core.ts` exposes only `handleCoreRoute` (line 1783). The lease acquire/release/heartbeat logic is inline. Extract it into a pure, injectable module so it can be unit-tested without booting HTTP.

**Files:**
- Create: `src/status-server/core/lease-handlers.ts`
- Modify: `src/status-server/routes/core.ts` (call the extracted functions)
- Create: `tests/routes-core-lease.test.ts`

- [ ] **Step 1: Read the inline lease logic**

Read the acquire/release/heartbeat branches in `src/status-server/routes/core.ts` (search for `acquire`, `release`, `heartbeat`, and the `tryAcquireExecutionLease`/`ExecutionLease` references near line 1055). Identify the inputs (request body, current lease state) and outputs (HTTP status + JSON payload).

- [ ] **Step 2: Write the failing unit test for `acquireLease`**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLease } from '../src/status-server/core/lease-handlers.ts';
import type { ExecutionLease } from '../src/status-server/server-types.ts';

test('acquireLease grants a lease when the slot is free', () => {
  const result = acquireLease({ current: null, requestedBy: 'cli-a', now: 1_000, ttlMs: 3_000 });
  assert.equal(result.granted, true);
  assert.equal(result.lease?.holder, 'cli-a');
  assert.equal(result.lease?.expiresAt, 4_000);
});

test('acquireLease denies when an unexpired lease is held by another holder', () => {
  const held: ExecutionLease = { holder: 'cli-b', expiresAt: 5_000 } as ExecutionLease;
  const result = acquireLease({ current: held, requestedBy: 'cli-a', now: 1_000, ttlMs: 3_000 });
  assert.equal(result.granted, false);
});

test('acquireLease grants when the held lease has expired', () => {
  const held: ExecutionLease = { holder: 'cli-b', expiresAt: 500 } as ExecutionLease;
  const result = acquireLease({ current: held, requestedBy: 'cli-a', now: 1_000, ttlMs: 3_000 });
  assert.equal(result.granted, true);
  assert.equal(result.lease?.holder, 'cli-a');
});
```

> Adjust the exact field names (`holder`/`expiresAt`) to match the real `ExecutionLease` type in `src/status-server/server-types.ts` after reading it in Step 1. Add equivalent tests for `releaseLease` (releases only when the holder matches) and `heartbeatLease` (extends expiry only for the current holder).

- [ ] **Step 3: Run RED**

Run: `npx tsx --test tests/routes-core-lease.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `lease-handlers.ts` by extracting the inline logic**

Move the pure decision logic into typed functions:

```typescript
import type { ExecutionLease } from '../server-types.js';

export interface AcquireInput { current: ExecutionLease | null; requestedBy: string; now: number; ttlMs: number; }
export interface AcquireResult { granted: boolean; lease: ExecutionLease | null; }

export function acquireLease(input: AcquireInput): AcquireResult { /* extracted logic */ }
export function releaseLease(/* typed */): /* typed */ { /* extracted */ }
export function heartbeatLease(/* typed */): /* typed */ { /* extracted */ }
```

- [ ] **Step 5: Rewire `routes/core.ts`** to call `acquireLease`/`releaseLease`/`heartbeatLease`, deleting the inlined branches. Keep the HTTP framing (status codes, JSON shape) in the route; only the decision logic moves.

- [ ] **Step 6: Run GREEN + the lease E2E**

Run: `npx tsx --test tests/routes-core-lease.test.ts`
Expected: PASS.
Run: `npx tsx --test tests/runtime-execution-lease.test.ts`
Expected: PASS (behavior unchanged through the route).

- [ ] **Step 7: Add to allowlist + commit**

Add `"tests/routes-core-lease.test.ts"` and `"src/status-server/core/lease-handlers.ts"` is already covered by `src/**`. Run `npm run typecheck:test` (PASS).

```
git add src/status-server/core/lease-handlers.ts src/status-server/routes/core.ts tests/routes-core-lease.test.ts tsconfig.test.json
git commit -m "refactor(routes): extract testable lease handlers; unit-test them"
```

### Task 3.4: Extract & unit-test a `StatusPresetRunner` decision unit

> `StatusPresetRunner` (`src/status-server/preset-runner.ts:99`) is a class. Identify one pure decision method (e.g. preset selection / run-state transition) with no I/O and extract it to a static or free function for direct unit testing.

**Files:**
- Modify: `src/status-server/preset-runner.ts`
- Create: `tests/preset-runner.test.ts`

- [ ] **Step 1: Read the class** and pick the smallest pure decision (a method that maps inputs → output with no network/fs). Note its current signature.

- [ ] **Step 2: Write the failing test** targeting that decision as an exported pure function. Example shape (adapt names to the real method):

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPresetRunPlan } from '../src/status-server/preset-runner.ts';

test('selectPresetRunPlan returns the expected plan for a basic preset', () => {
  const plan = selectPresetRunPlan(/* typed inputs */);
  assert.equal(plan.kind, /* expected */);
});
```

- [ ] **Step 3: Run RED, extract the method to an exported pure function, have the class call it, run GREEN.**

Run: `npx tsx --test tests/preset-runner.test.ts`
Expected: FAIL → (after extraction) PASS.

- [ ] **Step 4: Run an existing preset-runner consumer test** to confirm no regression (find via Grep for `preset-runner` / `StatusPresetRunner` in `tests/`).

- [ ] **Step 5: Add to allowlist + commit**

```
git add src/status-server/preset-runner.ts tests/preset-runner.test.ts tsconfig.test.json
git commit -m "refactor(preset-runner): extract pure decision; unit-test it"
```

### Task 3.5: Extract & unit-test a `SummaryRequestRunner` decision unit

> Same pattern for `SummaryRequestRunner` (`src/summary/request-runner.ts:79`). Pick a pure decision (e.g. chunk/budget planning, retry-ladder state) and extract.

**Files:**
- Modify: `src/summary/request-runner.ts`
- Create: `tests/summary-request-runner-units.test.ts`

- [ ] **Step 1: Read the class**, pick the smallest pure decision, note its signature.

- [ ] **Step 2: Write the failing unit test** against the extracted exported function (concrete inputs/asserts, adapted to the real signature).

- [ ] **Step 3: RED → extract → GREEN.**

Run: `npx tsx --test tests/summary-request-runner-units.test.ts`
Expected: FAIL → PASS.

- [ ] **Step 4: Run the existing `tests/summary-request-runner.test.ts`** to confirm no regression.

Run: `npx tsx --test tests/summary-request-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Add to allowlist + commit**

```
git add src/summary/request-runner.ts tests/summary-request-runner-units.test.ts tsconfig.test.json
git commit -m "refactor(request-runner): extract pure decision; unit-test it"
```

### Task 3.6: Extend dashboard metrics unit coverage

**Files:**
- Modify: `tests/dashboard-runs-partition.test.ts` (already typed/listed) OR create `tests/routes-dashboard-metrics.test.ts`
- Test subject: pure aggregation helpers reachable from `src/status-server/routes/dashboard.ts`

- [ ] **Step 1: Identify the pure metrics aggregation** used by `handleDashboardRoute`. If it is inline, extract it to `src/status-server/dashboard/metrics-aggregation.ts` (same extraction pattern as Task 3.3).

- [ ] **Step 2: Write failing unit tests** for the aggregation (empty input → zeros; multi-run input → summed/averaged values with concrete asserts).

- [ ] **Step 3: RED → extract if needed → GREEN → add to allowlist → commit.**

```
git commit -m "test(routes): unit-test dashboard metrics aggregation"
```

---

# Phase 4 — Thin the giant E2E suites (F14)

> Goal: with unit seams in place, reduce the two giant suites to integration smoke (boot + happy path + a couple of cross-cutting checks). Remove their `@ts-nocheck`, type them, add to allowlist.

### Task 4.1: Map E2E cases to their new unit coverage

**Files:** none (analysis)

- [ ] **Step 1: Inventory cases** in `tests/dashboard-status-server.test.ts` (2384L). For each `test(...)`, note whether its logic is now covered by a Phase-3 unit. Produce a keep/delete list. Keep: server-boot, one happy-path end-to-end per route family, and any genuinely integration-only assertion (sqlite persistence, SSE streaming). Delete: pure-logic cases now unit-covered.

- [ ] **Step 2: Do the same for `tests/repo-search-loop.core.test.ts`** (2155L).

### Task 4.2: Thin `dashboard-status-server.test.ts`

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Delete the redundant cases** from the keep/delete list. Remove now-unused imports.

- [ ] **Step 2: Remove `@ts-nocheck`** (line 1) and fix any type errors.

- [ ] **Step 3: Run the thinned suite**

Run: `npx tsx --test tests/dashboard-status-server.test.ts`
Expected: PASS (remaining smoke tests green).

- [ ] **Step 4: Add to allowlist + commit**

Add `"tests/dashboard-status-server.test.ts"` to `tsconfig.test.json`. Run `npm run typecheck:test` (PASS).

```
git add tests/dashboard-status-server.test.ts tsconfig.test.json
git commit -m "test(e2e): thin dashboard-status-server to integration smoke; type it"
```

### Task 4.3: Thin `repo-search-loop.core.test.ts`

**Files:**
- Modify: `tests/repo-search-loop.core.test.ts`

- [ ] **Step 1–4:** Same procedure as Task 4.2 (delete redundant cases, remove `@ts-nocheck`, run, add to allowlist, commit).

Run: `npx tsx --test tests/repo-search-loop.core.test.ts`
Expected: PASS.

```
git add tests/repo-search-loop.core.test.ts tsconfig.test.json
git commit -m "test(e2e): thin repo-search-loop.core to integration smoke; type it"
```

---

# Phase 5 — Isolate the env-var mock seam (F14)

> Goal: the non-mock production summary path must not reference `SIFTKIT_TEST_*`. Move that behavior into a dedicated mock-backend module reached only via `backend === 'mock'`. Behavior must stay identical (verified by existing summary tests). Reclassify `findMockResult` as live API in the docs.

### Task 5.1: Create the dedicated mock-provider module

**Files:**
- Create: `src/summary/providers/mock-provider.ts`
- Modify: `src/summary/provider-invoke.ts:96-137`, `src/summary/mock.ts`

- [ ] **Step 1: Write a failing test for the mock provider**

Create `tests/summary-mock-provider.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMockProvider } from '../src/summary/providers/mock-provider.ts';

test('runMockProvider honors SIFTKIT_TEST_PROVIDER_BEHAVIOR override', () => {
  const prev = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'echo';
  try {
    const out = runMockProvider({ prompt: 'P', question: 'Q', phase: 'map' });
    assert.equal(typeof out.text, 'string');
  } finally {
    if (prev === undefined) delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    else process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = prev;
  }
});
```

> Adapt `phase` and the return shape to the real `SummaryPhase` type and the existing `getMockSummary` return. The point of the test: the env-var behavior now lives behind `runMockProvider`, not in `provider-invoke.ts`.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/summary-mock-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the logic**

- Move `getMockSummary` and the `SIFTKIT_TEST_PROVIDER_BEHAVIOR`/`SIFTKIT_TEST_TOKEN`/`SIFTKIT_TEST_PROVIDER_SLEEP_MS` reads + `appendTestProviderEvent` call from `provider-invoke.ts` and `mock.ts` into `mock-provider.ts`, exposed as `runMockProvider(options)` returning the same `{ text, metrics }` shape the `backend === 'mock'` branch returns today.
- In `provider-invoke.ts`, replace the inline `if (options.backend === 'mock') { ... }` body with a single delegation: `return runMockProvider(options);` (keep the surrounding timing/span wiring or move it inside the provider — preserve identical externally observable behavior).
- Leave the non-test summary helpers (`toMockDecision`, `buildMockDecision`) in `mock.ts` only if they are used outside the mock backend; otherwise move them too. Verify with Grep before moving.

- [ ] **Step 4: Run GREEN + existing summary tests**

Run: `npx tsx --test tests/summary-mock-provider.test.ts`
Expected: PASS.
Run: `npx tsx --test tests/summary-request-runner.test.ts tests/summary-core-runner.test.ts tests/runtime-summarize.test.ts`
Expected: PASS (behavior unchanged).

- [ ] **Step 5: Confirm the non-mock path is clean**

Use the Grep tool: pattern `SIFTKIT_TEST_PROVIDER_BEHAVIOR|SIFTKIT_TEST_TOKEN|SIFTKIT_TEST_PROVIDER_SLEEP_MS`, path `src/`. Expected: matches only in `src/summary/providers/mock-provider.ts`.

- [ ] **Step 6: Add to allowlist + commit**

Add `"tests/summary-mock-provider.test.ts"` to `tsconfig.test.json`. Run `npm run typecheck:test` (PASS).

```
git add src/summary/providers/mock-provider.ts src/summary/provider-invoke.ts src/summary/mock.ts tests/summary-mock-provider.test.ts tsconfig.test.json
git commit -m "refactor(summary): isolate env-var mock seam into mock-provider; non-mock path no longer references SIFTKIT_TEST_*"
```

### Task 5.2: Reclassify `findMockResult` in the architecture doc

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (F14 section, line ~27)

- [ ] **Step 1: Edit F14** to remove `findMockResult`/`src/repo-search/engine/command-execution.ts` from the "test seams in production modules" claim and add a short note (mirroring the F11/exec-lock reclassification):

> `findMockResult`/`mockCommandResults` is request-driven mocking exposed through the public HTTP API (`routes/chat.ts`, `routes/core.ts`), the CLI (`run-internal.ts`), and the request types — a runtime capability, not a test backdoor. It stays. The env-var mock seam was the real issue and is now isolated in `src/summary/providers/mock-provider.ts`.

- [ ] **Step 2: Commit**

```
git add ARCHITECTURE-REVIEW.md
git commit -m "docs(architecture): reclassify findMockResult as live API (F14)"
```

---

# Phase 6 — Flip the gate (F6 + F14 closure)

### Task 6.1: Switch tsconfig to the whole suite

**Files:**
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Replace the `include` array** with:

```json
"include": ["src/**/*.ts", "tests/**/*.ts"]
```

- [ ] **Step 2: Run the typecheck gate over everything**

Run: `npm run typecheck:test`
Expected: PASS. If any residual `@ts-nocheck` file errors, type it now (no file should still carry `@ts-nocheck`).

- [ ] **Step 3: Confirm zero `@ts-nocheck` remains**

Use the Grep tool: pattern `@ts-nocheck`, path `tests/`. Expected: no matches.

- [ ] **Step 4: Commit**

```
git add tsconfig.test.json
git commit -m "test(typecheck): typecheck the entire tests/ suite"
```

### Task 6.2: Enable the hygiene regression gate

**Files:**
- Modify: `tests/test-hygiene-gate.test.ts`

- [ ] **Step 1: Remove `{ skip: true }`** from both the `no ../dist` and `no @ts-nocheck` tests.

- [ ] **Step 2: Run the gate**

Run: `npx tsx --test tests/test-hygiene-gate.test.ts`
Expected: PASS (both assertions now hold).

- [ ] **Step 3: Commit**

```
git add tests/test-hygiene-gate.test.ts
git commit -m "test(hygiene): enforce no-dist-imports and no-ts-nocheck gate"
```

### Task 6.3: Full verification & doc closure

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (F6, F14, priority list item 2)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS (all projects, including `typecheck:test`).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Coverage sanity**

Run: `npm run test:coverage`
Expected: report covers `src/**`; note the new seam files now have unit coverage.

- [ ] **Step 4: Update `ARCHITECTURE-REVIEW.md`**

- Delete the F6 finding (split-brain resolved: all tests import `../src`; `tsconfig.test.json` covers all 158; coverage from `src/**`).
- Delete the F14 bullets that are now resolved (`@ts-nocheck` harness typed; E2E rebalanced; env-var seam isolated). Keep only any residual F14 items the team consciously deferred (none planned here).
- Update priority list item 2 to `~~Unit-test pyramid recovery…~~ **(done)**` with a one-line summary.

- [ ] **Step 5: Commit**

```
git add ARCHITECTURE-REVIEW.md
git commit -m "docs(architecture): mark F6/F14 resolved; test pyramid recovered and typed"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Phase 0 (gate+coverage), Phase 1 (harness typing), Phase 2 (import migration), Phase 3 (unit seams), Phase 4 (E2E thinning), Phase 5 (prod seam isolation + findMockResult reclassification), Phase 6 (full typecheck flip + closure) — every spec success criterion maps to a task.
- **Signature grounding:** Tasks 3.1, 3.2, 5.1 use real signatures verified in the source. Tasks 3.3–3.6 require reading the target before writing the extraction; the test code shown is a concrete template to adapt to the actual `ExecutionLease`/runner signatures — do not invent field names, read them first.
- **Behavior preservation:** every extraction (3.3–3.6, 5.1) is verified against a pre-existing E2E/integration test that exercises the same path, so refactors can't silently change behavior.
- **Ordering dependency:** Phase 1 must precede Phase 2 (typed barrel must exist before importers are typechecked); Phase 3 should precede Phase 4 (units must exist before deleting E2E cases); Phase 5 is independent but kept after 3/4 to avoid churn. Phase 6 is strictly last.
