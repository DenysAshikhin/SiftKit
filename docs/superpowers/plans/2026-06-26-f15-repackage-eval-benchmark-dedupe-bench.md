# F15 — Repackage eval/benchmark code, dedupe bench harness, route bench through `/summary` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove bench-only code from the shipping `src/`→`dist/` graph, co-locate eval runtime with the server it belongs to, collapse the duplicated bench repo-root logic into one helper, and route the two in-process `summarizeRequest` bench callers through `POST /summary`.

**Architecture:** SiftKit ships `dist/` compiled from `src/**` only (`package.json:51-58` `files: ["dist", ...]`, `tsconfig.json:include ["src/**/*.ts"]`). `src/benchmark-spec-settings.ts` is bench-only (its sole importer is `tests/benchmark-spec-settings.test.ts`) yet ships as dead weight — it moves to `bench/`. `src/eval.ts` is genuine server runtime (only importer `src/status-server/engine-service.ts`) — it moves to `src/status-server/` to express the server boundary and *stays* shipped. The bench harness duplicates repo-root resolution three ways (one of them, `bench/benchmark/args.ts:12-14`, is a latent bug resolving to the repo's **parent**); all three collapse onto the existing location-independent `findNearestSiftKitRepoRoot` (`src/lib/paths.ts:16`) via a thin `bench/common/paths.ts` wrapper. Finally, `bench/benchmark/runner.ts` and `bench/repro/run-benchmark-fixture-debug.ts` stop calling `summarizeRequest` in-process and call `StatusServerApiClient.requestSummary()` instead; because the production `/summary` normalizer currently drops `promptPrefix` and `llamaCppOverrides`, the `/summary` contract is extended first so real benchmark knobs survive the hop.

**Tech Stack:** TypeScript (strict, zero-cast/zero-`any`, no namespace imports, no `!`), Node.js `node:test`, the existing status-server HTTP routes (`StatusServerApiClient`, `SummaryEndpoint`, `parseSummaryRequest`), `tsx` for bench entrypoints (run from source — no `dist` emit).

**Validation discipline:** `tsc -p tsconfig.json --noEmit` covers `src` only. Bench and test edits are covered by `npm run typecheck` (which chains `typecheck:bench` + `typecheck:test` + lint, per `package.json:16`). Each task is structured to leave `npm run typecheck` green at its commit. The full suite (`npm test`, `package.json:27`) runs in the final task. The bench `summarizeRequest`→`/summary` routing is verified by the existing `tests/runtime-benchmark.test.ts` suite (which already runs under `withStubServer`, and the stub already implements `POST /summary` at `tests/_runtime-helpers.ts:617`).

**Key facts verified before planning (re-verify against current code):**
- `src/benchmark-spec-settings.ts` importers: only `tests/benchmark-spec-settings.test.ts:24`. The `scripts/run-benchmark-spec-*.js` wrappers only *share the filename* — they `spawnSync` `scripts/benchmark-siftkit-spec-settings.ps1` and do **not** import the TS module.
- `src/eval.ts` importers: only `src/status-server/engine-service.ts:6` (runtime) and `tests/eval.test.ts:6` (test). `src/eval-types.ts` is a shared client+server contract (`status-server-api-client.ts:33`, `engine-service.ts:7`, `eval.ts:10`) and does **not** move.
- Repo-root duplication: `bench/benchmark/args.ts:12-14` uses **three** `..` → resolves to `…/GitHub` (parent of repo, **WRONG**); `bench/benchmark-matrix/types.ts:142` uses two `..` → correct; `src/eval.ts:23-25` uses two `..` from `dist/eval.js` → also wrong, but only reached when `request.FixtureRoot` is omitted. `src/lib/paths.ts:16 findNearestSiftKitRepoRoot` walks up to the `package.json` whose `name === 'siftkit'` and is location-independent.
- `engineService.summarize(request: SummaryRequest)` (`engine-service.ts:27-29`) already forwards the **entire** `SummaryRequest` to `summarizeRequest`, so `promptPrefix`/`llamaCppOverrides` need only be parsed by the route and passed by `SummaryEndpoint`.
- `parseSummaryRequest` (`route-request-normalizers.ts:105-125`) does **not** parse `promptPrefix` or `llamaCppOverrides`. `SummaryEndpoint.handle` (`routes/core.ts:948-961`) does not pass them.
- `StatusServerApiClient.requestSummary(request: SummaryRequest)` (`status-server-api-client.ts:48-57`) POSTs to `getStatusBackendUrl()/summary`; under `withStubServer` that resolves to the stub, which runs `summarizeRequest` server-side (`tests/_runtime-helpers.ts:617-642`).

**Non-goals (explicit):**
- Do **not** create a new npm workspace package. The only real shipping-graph defect is bench-only code compiled into `dist`; relocation fixes it without build/publish overhead.
- Do **not** move `src/eval-types.ts` (shared contract).
- Do **not** force-merge `bench/benchmark/interrupt.ts` with `bench/benchmark-matrix/interrupt.ts`, the two `args.ts` parsers, the two `types.ts` schema sets, or the two `runner.ts` files. They are *role-parallel*, not duplicated: the matrix interrupt carries a state-mutating `onInterrupt` closure (`benchmark-matrix/runner.ts:110-127`) and merging would require passing functions dynamically (banned by repo rules) or inventing a false abstraction. Only the genuinely-duplicated, function-free repo-root resolution is consolidated.
- Do **not** remove `// @ts-nocheck` from `bench/repro/run-benchmark-fixture-debug.ts` — that is pre-existing debug-script hygiene, out of F15 scope.
- Do **not** touch `bench/benchmark-matrix/types.ts:144-146` `powerShellExe` dead ternary (unrelated smell).

---

## File Structure

**Moved (git mv):**
- `src/benchmark-spec-settings.ts` → `bench/spec-settings.ts` (bench-only; leaves `dist`).
- `src/eval.ts` → `src/status-server/eval.ts` (server runtime; stays in `dist`).

**Created:**
- `bench/common/paths.ts` — single bench repo-root helper delegating to `findNearestSiftKitRepoRoot`.

**Modified (production):**
- `src/status-server/eval.ts` — relative-import depth + repo-root helper (after move).
- `src/status-server/engine-service.ts:6` — eval import path.
- `bench/spec-settings.ts` — `telemetry-metrics` import path (after move).
- `bench/benchmark/args.ts` — drop local `getRepoRoot`.
- `bench/benchmark/runner.ts` — `getRepoRoot` import source; `summarizeRequest`→`requestSummary`.
- `bench/benchmark-matrix/types.ts:142` — `repoRoot` via shared helper.
- `bench/benchmark-matrix/benchmark-runner.ts` — inject `manifest.configUrl`-derived server env into the spawned child.
- `bench/repro/repro-fixture60-malformed-json.ts` — `repoRoot` via shared helper.
- `bench/repro/run-benchmark-fixture-debug.ts` — `repoRoot` via shared helper; `summarizeRequest`→`requestSummary`.
- `src/status-server/route-request-normalizers.ts` — `SummaryRouteRequest` + `parseSummaryRequest` gain `promptPrefix`/`llamaCppOverrides` (empty-string-preserving).
- `src/status-server/routes/core.ts:948-961` — `SummaryEndpoint` forwards the two new fields.

**Modified (tests/infra):**
- `tests/benchmark-spec-settings.test.ts:24` — import path.
- `tests/eval.test.ts:6` — import path.
- `tests/route-request-normalizers.test.ts` — `parseSummaryRequest` forwarding + empty-prefix tests.
- `tests/summary-status-server.test.ts` — compiled-source guard for `SummaryEndpoint` forwarding.
- `tests/_runtime-helpers.ts` — stub `/summary` forwards new fields + records route calls.
- `tests/runtime-benchmark.test.ts` — assert the runner now drives `POST /summary`; provider-error message shape.
- `tests/runtime-benchmark.matrix.test.ts` — adjust only if it encoded ambient-env targeting.
- `ARCHITECTURE-REVIEW.md` — mark F15 resolved.

---

## Task 1: Move `benchmark-spec-settings.ts` out of the shipping graph

Bench-only code leaves `src/` (and therefore `dist/`). Single atomic, green-at-commit change: the move and its only importer (the test) go together.

**Files:**
- Move: `src/benchmark-spec-settings.ts` → `bench/spec-settings.ts`
- Modify: `bench/spec-settings.ts:2-7` (telemetry import)
- Modify: `tests/benchmark-spec-settings.test.ts:24` (import path)

- [ ] **Step 1: Move the file**

```bash
git mv src/benchmark-spec-settings.ts bench/spec-settings.ts
```

- [ ] **Step 2: Fix the `telemetry-metrics` import path**

In `bench/spec-settings.ts` the dashboard import on line 1 (`from '../dashboard/src/types'`) is unchanged (the relative path to `dashboard/` is identical from both `src/` and `bench/`). Only the `src/lib` import changes. Edit lines 2-7:

```ts
import {
  getAcceptanceRate,
  getGenerationTokensPerSecond,
  getPromptCacheHitRate,
  getPromptTokensPerSecond,
} from './lib/telemetry-metrics.js';
```
→
```ts
import {
  getAcceptanceRate,
  getGenerationTokensPerSecond,
  getPromptCacheHitRate,
  getPromptTokensPerSecond,
} from '../src/lib/telemetry-metrics.js';
```

- [ ] **Step 3: Update the test import**

In `tests/benchmark-spec-settings.test.ts` change line 24:
```ts
} from '../src/benchmark-spec-settings';
```
→
```ts
} from '../bench/spec-settings';
```
(The `'../dashboard/src/types'` import on line 9 is unchanged.)

- [ ] **Step 4: Verify nothing else references the old `src/` module**

Run: `git grep -n "benchmark-spec-settings" -- src tests bench scripts | grep -v "scripts/run-benchmark-spec\|scripts/benchmark-siftkit-spec-settings\|tests/benchmark-spec-settings.test.ts"`
Expected: no matches (the surviving matches are the same-named PS/JS wrappers and the test filename itself).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `bench/spec-settings.ts` is now covered by `typecheck:bench` (glob `bench/**/*.ts`) instead of `tsconfig.json`.

- [ ] **Step 6: Run the affected test**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "spec"` (or run `tests/benchmark-spec-settings.test.ts` via the project runner).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src bench/spec-settings.ts tests/benchmark-spec-settings.test.ts
git commit -m "refactor(F15): move benchmark-spec-settings out of shipping src graph into bench/"
```

---

## Task 2: Move `eval.ts` into the server boundary

`eval.ts` is server runtime (only `engine-service.ts` imports it). Co-locate it under `src/status-server/` and replace its fragile `__dirname`-depth repo-root with the location-independent helper, so the move cannot break `getRepoRoot()`.

**Files:**
- Move: `src/eval.ts` → `src/status-server/eval.ts`
- Modify: `src/status-server/eval.ts` (import depths + repo root)
- Modify: `src/status-server/engine-service.ts:6` (import path)
- Modify: `tests/eval.test.ts:6` (import path)

- [ ] **Step 1: Move the file**

```bash
git mv src/eval.ts src/status-server/eval.ts
```

- [ ] **Step 2: Re-root the relative imports one level up**

In `src/status-server/eval.ts` rewrite the import block (lines 3-10):
```ts
import { z } from './lib/zod.js';
import { JsonObjectSchema } from './lib/json-types.js';
import { parseJsonValueText } from './lib/json.js';
import { getConfiguredModel, initializeRuntime, loadConfig } from './config/index.js';
import { summarizeRequest } from './summary/core.js';
import { upsertRuntimeJsonArtifact } from './state/runtime-artifacts.js';
import { persistEvalResult } from './state/runtime-results.js';
import type { EvalCaseResult, EvalRequest, EvaluationResult } from './eval-types.js';
```
→
```ts
import { z } from '../lib/zod.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { parseJsonValueText } from '../lib/json.js';
import { getConfiguredModel, initializeRuntime, loadConfig } from '../config/index.js';
import { summarizeRequest } from '../summary/core.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { persistEvalResult } from '../state/runtime-results.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';
import type { EvalCaseResult, EvalRequest, EvaluationResult } from '../eval-types.js';
```
(The `node:fs`/`node:path` imports on lines 1-2 are unchanged.)

- [ ] **Step 3: Replace the `getRepoRoot` helper with the location-independent resolver**

In `src/status-server/eval.ts` delete the helper (old lines 23-25):
```ts
function getRepoRoot(): string {
  return resolve(__dirname, '..', '..');
}
```
Then change its only caller (old line 77, inside `runEvaluation`):
```ts
  const fixtureRoot = request.FixtureRoot || join(getRepoRoot(), 'eval', 'fixtures');
```
→
```ts
  const repoRoot = findNearestSiftKitRepoRoot(__dirname);
  if (repoRoot === null) {
    throw new Error('Unable to locate the SiftKit repo root for eval fixtures.');
  }
  const fixtureRoot = request.FixtureRoot || join(repoRoot, 'eval', 'fixtures');
```
If `resolve` is now unused in the file, remove it from the `node:path` import on line 2 (`import { resolve, join, basename } from 'node:path';` → `import { join, basename } from 'node:path';`). Verify with `git grep -n "resolve(" src/status-server/eval.ts`.

- [ ] **Step 4: Update the engine-service import**

In `src/status-server/engine-service.ts` change line 6:
```ts
import { runEvaluation } from '../eval.js';
```
→
```ts
import { runEvaluation } from './eval.js';
```
(Line 7 `import type { ... } from '../eval-types.js';` is unchanged — `eval-types` stays in `src/`.)

- [ ] **Step 5: Update the eval test import**

In `tests/eval.test.ts` change line 6:
```ts
import { runEvaluation } from '../src/eval.js';
```
→
```ts
import { runEvaluation } from '../src/status-server/eval.js';
```

- [ ] **Step 6: Verify no dangling references to the old path**

Run: `git grep -n "from '\.\./eval\.js'\|src/eval\.ts\|src/eval\.js" -- src tests scripts bench`
Expected: no matches. (The new server-internal import is `from './eval.js'` *inside* `src/status-server/`; this gate intentionally targets only the old public paths so it does not flag that intended import.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run eval tests**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "runEvaluation"`
Expected: PASS (4 eval tests).

- [ ] **Step 9: Commit**

```bash
git add src/status-server/eval.ts src/eval.ts src/status-server/engine-service.ts tests/eval.test.ts
git commit -m "refactor(F15): move eval runtime into status-server/ and use location-independent repo root"
```

---

## Task 3: Consolidate bench repo-root resolution (fixes the `args.ts` parent-dir bug)

One shared, function-free helper replaces three hand-rolled `__dirname`-depth computations — including the latent `bench/benchmark/args.ts` bug that resolves to the repo's parent.

**Files:**
- Create: `bench/common/paths.ts`
- Test: `tests/bench-common-paths.test.ts`
- Modify: `bench/benchmark/args.ts:12-14` (delete local helper), `bench/benchmark/runner.ts:8-15` (import source)
- Modify: `bench/benchmark-matrix/types.ts:142` (use shared helper)
- Modify: `bench/repro/repro-fixture60-malformed-json.ts:232`, `bench/repro/run-benchmark-fixture-debug.ts:184` (use shared helper — these compute `path.resolve(__dirname, '..', '..')`, which is *correct* from `bench/repro/` but is the last hand-rolled repo-root math; consolidating them keeps the Step 9 gate honest)

- [ ] **Step 1: Write the failing test**

Create `tests/bench-common-paths.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getRepoRoot } from '../bench/common/paths.js';

test('getRepoRoot resolves to the SiftKit repo root (containing the siftkit package.json)', () => {
  const root = getRepoRoot();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'siftkit');
});

test('getRepoRoot does not resolve to the repo parent directory', () => {
  const root = getRepoRoot();
  assert.equal(fs.existsSync(path.join(root, 'bench')), true);
  assert.equal(fs.existsSync(path.join(root, 'src')), true);
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "getRepoRoot"`
Expected: FAIL — `bench/common/paths.js` does not exist (module-not-found).

- [ ] **Step 3: Create the shared helper**

Create `bench/common/paths.ts`:
```ts
import { findNearestSiftKitRepoRoot } from '../../src/lib/paths.js';

export function getRepoRoot(): string {
  const root = findNearestSiftKitRepoRoot(__dirname);
  if (root === null) {
    throw new Error('Unable to locate the SiftKit repo root from the benchmark harness.');
  }
  return root;
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "getRepoRoot"`
Expected: PASS.

- [ ] **Step 5: Delete the buggy local helper in `benchmark/args.ts`**

In `bench/benchmark/args.ts` delete lines 12-14:
```ts
export function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}
```
(`path` and `fs` remain in use elsewhere in the file — do not remove their imports.)

- [ ] **Step 6: Point `benchmark/runner.ts` at the shared helper**

In `bench/benchmark/runner.ts` remove `getRepoRoot,` from the `./args.js` import block (it is line 11 inside the block at lines 8-15), then add a dedicated import. After edit the two import groups read:
```ts
import {
  getDefaultOutputPath,
  getPromptLabel,
  getValidatedRequestTimeoutSeconds,
  parseArguments,
  resolvePromptPrefix,
} from './args.js';
```
and add, immediately below the `./args.js` import:
```ts
import { getRepoRoot } from '../common/paths.js';
```
(The call site at line 34 — `path.join(getRepoRoot(), 'eval', 'fixtures')` — is unchanged.)

- [ ] **Step 7: Point `benchmark-matrix/types.ts` at the shared helper**

In `bench/benchmark-matrix/types.ts` add an import near the top (after line 3):
```ts
import { getRepoRoot } from '../common/paths.js';
```
and replace line 142:
```ts
export const repoRoot = path.resolve(__dirname, '..', '..');
```
→
```ts
export const repoRoot = getRepoRoot();
```
(`path` remains used on line 143 — keep the `node:path` import. The 5 consumers of `repoRoot` across the matrix package are unchanged; they still read the exported value.)

- [ ] **Step 8: Migrate the two repro scripts onto the shared helper**

In `bench/repro/repro-fixture60-malformed-json.ts` add (with the other imports near the top):
```ts
import { getRepoRoot } from '../common/paths.js';
```
and replace line 232:
```ts
  const repoRoot = path.resolve(__dirname, '..', '..');
```
→
```ts
  const repoRoot = getRepoRoot();
```
In `bench/repro/run-benchmark-fixture-debug.ts` (this file is `@ts-nocheck`; the import still resolves at runtime under `tsx`) add:
```ts
import { getRepoRoot } from '../common/paths.js';
```
and replace line 184:
```ts
  const repoRoot = path.resolve(__dirname, '..', '..');
```
→
```ts
  const repoRoot = getRepoRoot();
```
(Both files use `path.*` elsewhere — keep their `node:path` imports.)

- [ ] **Step 9: Verify no hand-rolled bench repo-root math remains**

Run: `git grep -n "resolve(__dirname, '\.\.', '\.\.'" -- bench`
Expected: no matches.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add bench/common/paths.ts tests/bench-common-paths.test.ts bench/benchmark/args.ts bench/benchmark/runner.ts bench/benchmark-matrix/types.ts bench/repro/repro-fixture60-malformed-json.ts bench/repro/run-benchmark-fixture-debug.ts
git commit -m "refactor(F15): consolidate bench repo-root onto findNearestSiftKitRepoRoot, fixing args.ts parent-dir bug"
```

---

## Task 4: Extend the `/summary` contract to carry `promptPrefix` and `llamaCppOverrides`

Routing bench through `/summary` (Tasks 5-6) must not silently drop the benchmark knobs `promptPrefix` and `llamaCppOverrides.MaxTokens`. The engine already forwards them; this task adds them to the route normalizer, the endpoint, and the test stub.

**Files:**
- Modify: `src/status-server/route-request-normalizers.ts` (type + parser)
- Modify: `src/status-server/routes/core.ts:948-961` (endpoint forwards fields)
- Modify: `tests/_runtime-helpers.ts:623-634` (stub `/summary` forwards fields)
- Test: `tests/route-request-normalizers.test.ts`

- [ ] **Step 1: Write the failing normalizer test**

In `tests/route-request-normalizers.test.ts` add (ensure `parseSummaryRequest` is in the import from `'../src/status-server/route-request-normalizers.js'`; add it if absent):
```ts
test('parseSummaryRequest carries promptPrefix and llamaCppOverrides.MaxTokens', () => {
  const parsed = parseSummaryRequest({
    question: 'q',
    inputText: 'some input text',
    promptPrefix: 'benchmark prefix',
    llamaCppOverrides: { MaxTokens: 256 },
  });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.promptPrefix, 'benchmark prefix');
  assert.deepEqual(parsed?.llamaCppOverrides, { MaxTokens: 256 });
});

test('parseSummaryRequest omits llamaCppOverrides when MaxTokens is absent', () => {
  const parsed = parseSummaryRequest({ question: 'q', inputText: 'some input text' });
  assert.equal(parsed?.promptPrefix, undefined);
  assert.equal(parsed?.llamaCppOverrides, undefined);
});

test('parseSummaryRequest preserves an explicit empty promptPrefix as an override', () => {
  // SummaryRequest semantics (request-runner.ts:290): undefined => use the
  // configured prefix; a string (including "") => explicit override. The HTTP
  // contract must mirror that, so "" must NOT collapse to undefined.
  const parsed = parseSummaryRequest({ question: 'q', inputText: 'some input text', promptPrefix: '' });
  assert.equal(parsed?.promptPrefix, '');
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "parseSummaryRequest carries"`
Expected: FAIL — `parsed.promptPrefix` is `undefined` and `parsed.llamaCppOverrides` is `undefined`.

- [ ] **Step 3: Extend the `SummaryRouteRequest` type**

In `src/status-server/route-request-normalizers.ts` add a type import near the top (after line 7):
```ts
import type { RuntimeLlamaCppConfig } from '../config/index.js';
```
Then add two fields to `SummaryRouteRequest` (after line 27 `timing: SummaryTimingInput | undefined;`):
```ts
  promptPrefix: string | undefined;
  llamaCppOverrides: Pick<RuntimeLlamaCppConfig, 'MaxTokens'> | undefined;
```

- [ ] **Step 4: Parse the two fields in `parseSummaryRequest`**

In `src/status-server/route-request-normalizers.ts`, inside `parseSummaryRequest`, add two `const`s just before the `return {` (after the `if (!question || !inputText.trim()) { return null; }` guard):
```ts
  const promptPrefixValue = reader.value('promptPrefix');
  const promptPrefix = typeof promptPrefixValue === 'string' ? promptPrefixValue : undefined;
```
(Do **not** use `reader.optionalString('promptPrefix')` — it trims and converts `""` to `undefined`, which would change `SummaryRequest` semantics: `request-runner.ts:290` treats `undefined` as "use the configured prefix" and any string, including `""`, as an explicit override. The contract must preserve `""`.)
Then add to the returned object (after the `timing:` line):
```ts
    promptPrefix,
    llamaCppOverrides: parseLlamaCppOverrides(reader),
```
Then add this helper immediately above `parseSummaryRequest` (above line 105):
```ts
function parseLlamaCppOverrides(reader: JsonRecordReader): Pick<RuntimeLlamaCppConfig, 'MaxTokens'> | undefined {
  const overrides = reader.object('llamaCppOverrides');
  if (overrides === null) {
    return undefined;
  }
  const maxTokens = new JsonRecordReader(overrides).number('MaxTokens');
  return maxTokens === null ? undefined : { MaxTokens: maxTokens };
}
```

- [ ] **Step 5: Run the normalizer test to verify it PASSES**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "parseSummaryRequest"`
Expected: PASS (both new tests + any pre-existing `parseSummaryRequest` tests).

- [ ] **Step 6: Forward the fields from `SummaryEndpoint`**

In `src/status-server/routes/core.ts`, in `SummaryEndpoint.handle`, extend the `ctx.engineService.summarize({...})` call (lines 948-961) by adding two fields after `timing: summaryRequest.timing,` (line 958):
```ts
        promptPrefix: summaryRequest.promptPrefix,
        llamaCppOverrides: summaryRequest.llamaCppOverrides,
```

- [ ] **Step 6b: Guard the production `SummaryEndpoint` forwarding**

The Step 1 normalizer test and the stub-based benchmark test (Task 5) do **not** exercise the production `SummaryEndpoint` — a mutation deleting the Step 6 lines would still pass them. A full behavioral assertion is impractical here: the `mock` backend ignores both fields (`buildMockDecision` returns canned output, `src/summary/mock.ts:16`), and `startStatusServer` hardcodes `new StatusEngineService()` (`src/status-server/index.ts:215`, no injection seam). Guard the route with a compiled-source assertion, mirroring the existing pattern at `tests/summary-status-server.test.ts:45-49`. Add to `tests/summary-status-server.test.ts`:
```ts
test('summary endpoint forwards promptPrefix and llamaCppOverrides to the summary engine', () => {
  const routeText = fs.readFileSync(path.join(process.cwd(), 'dist', 'status-server', 'routes', 'core.js'), 'utf8');
  assert.match(routeText, /promptPrefix:\s*summaryRequest\.promptPrefix/u);
  assert.match(routeText, /llamaCppOverrides:\s*summaryRequest\.llamaCppOverrides/u);
});
```
(White-box but deterministic and idiomatic for this file; combined with the Step 1 normalizer test and the already-tested full-request `engineService.summarize` forwarding, it closes the chain parse → endpoint → engine.)

- [ ] **Step 7: Forward the fields in the test stub `/summary` handler**

In `tests/_runtime-helpers.ts`, in the `POST /summary` handler, extend the `summarizeRequest({...})` call (lines 623-634) by adding two fields after `model: ...` (line 629). The `promptPrefix` branch preserves an explicit `""` to mirror the production contract:
```ts
          promptPrefix: typeof parsed.promptPrefix === 'string' ? parsed.promptPrefix : undefined,
          llamaCppOverrides: parsed.llamaCppOverrides && typeof parsed.llamaCppOverrides === 'object' && !Array.isArray(parsed.llamaCppOverrides) && Number.isFinite(Number(parsed.llamaCppOverrides.MaxTokens))
            ? { MaxTokens: Number(parsed.llamaCppOverrides.MaxTokens) }
            : undefined,
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Run summary route + normalizer tests (build first so the Step 6b source-assertion sees the new `core.js`)**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "parseSummaryRequest|summary endpoint"`
Expected: PASS, including `summary endpoint forwards promptPrefix and llamaCppOverrides to the summary engine`.

- [ ] **Step 10: Commit**

```bash
git add src/status-server/route-request-normalizers.ts src/status-server/routes/core.ts tests/route-request-normalizers.test.ts tests/summary-status-server.test.ts tests/_runtime-helpers.ts
git commit -m "feat(F15): forward promptPrefix and llamaCppOverrides through POST /summary"
```

---

## Task 5: Route the benchmark runner through `POST /summary`

`bench/benchmark/runner.ts` stops calling `summarizeRequest` in-process and calls the server via `StatusServerApiClient.requestSummary()`. TDD: first assert the runner drives the stub's `/summary` route (fails today, since the call is in-process), then make it pass.

**Files:**
- Modify: `tests/_runtime-helpers.ts` (record `/summary` route calls on the stub)
- Modify: `tests/runtime-benchmark.test.ts` (assert the runner hit `/summary`)
- Modify: `bench/benchmark/runner.ts:6,33-85` (swap in-process call for the API client)
- Modify: `bench/benchmark-matrix/benchmark-runner.ts` (import `deriveServiceUrl` after line 3; replace `env: process.env,` at line 45)

**Why the matrix child needs explicit server env:** `runBenchmarkSuite` is the matrix's spawned child (`benchmark-runner.ts:34` runs `bench/benchmark/index.ts` via `tsx`). Once it calls `StatusServerApiClient.requestSummary()`, summarize executes **on whichever status server `getStatusBackendUrl()` resolves to** (and its managed llama decides the model). Today the child is spawned with ambient `process.env` (`benchmark-runner.ts:45`) and never sees `manifest.configUrl` — it relied on ambient env happening to point at the same `:4765` server. That is a pre-existing latent coupling; delegating summarize to the server makes it model-correctness-critical (the per-target model lives on `manifest.configUrl`'s server). Inject the manifest server into the child env so the manifest is authoritative.

- [ ] **Step 1: Add a `/summary` call recorder to the stub**

In `tests/_runtime-helpers.ts`:
- Add a field to `interface StubServerState` (near `tokenizeRequests: JsonObject[];`, line 199):
```ts
  summaryRouteRequests: JsonObject[];
```
- Initialize it in the `const state: StubServerState = { ... }` literal (near line 513-520, alongside `tokenizeRequests: [],`):
```ts
    summaryRouteRequests: [],
```
- In the `POST /summary` handler, immediately after `const parsed = bodyText ? JSON.parse(bodyText) : {};` (line 619), push the request:
```ts
      state.summaryRouteRequests.push(parsed);
```

- [ ] **Step 2: Write the failing assertion in the existing happy-path benchmark test**

In `tests/runtime-benchmark.test.ts`, the first test ('benchmark runner writes prompt, output, ...') runs under `withStubServer(async () => { ... })`. Change its signature to capture the server and add an assertion after `assert.equal(artifact.Results.length, 2);` (line 65). The block becomes:
```ts
    await withStubServer(async (server) => {
```
and after line 65 add:
```ts
      assert.equal(server.state.summaryRouteRequests.length, 2);
      assert.equal(server.state.summaryRouteRequests[0].question, 'summarize this');
```

- [ ] **Step 3: Run it to verify it FAILS**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "benchmark runner writes prompt"`
Expected: FAIL — `summaryRouteRequests.length` is `0` because the runner currently calls `summarizeRequest` in-process and never hits `/summary`.

- [ ] **Step 4: Swap the in-process call for the API client**

In `bench/benchmark/runner.ts`:
- Replace the import on line 6:
```ts
import { summarizeRequest } from '../../src/summary/core.js';
```
→
```ts
import { StatusServerApiClient } from '../../src/cli/status-server-api-client.js';
```
- Instantiate the client once, immediately after `const interruptSignal = createInterruptSignal();` (line 45):
```ts
  const apiClient = new StatusServerApiClient();
```
- Replace the call inside `runWithFixtureDeadline(...)` (lines 68-79) — change only the function being called; the request object is identical:
```ts
          summarizeRequest({
```
→
```ts
          apiClient.requestSummary({
```

- [ ] **Step 4b: Wire the matrix child process to the manifest's server**

In `bench/benchmark-matrix/benchmark-runner.ts`:
- Add an import (after line 3):
```ts
import { deriveServiceUrl } from '../../src/config/status-backend.js';
```
- In `invokeBenchmarkProcess`, replace `env: process.env,` (line 45) with an explicit, manifest-authoritative env:
```ts
    env: {
      ...process.env,
      SIFTKIT_CONFIG_SERVICE_URL: manifest.configUrl,
      SIFTKIT_STATUS_BACKEND_URL: deriveServiceUrl(manifest.configUrl, '/status'),
    },
```
(`deriveServiceUrl(configuredUrl, '/status')` rewrites only the path, so `http://127.0.0.1:4765/config` → `http://127.0.0.1:4765/status`. The child's `StatusServerApiClient` and `loadConfig` now both target the manifest server.)

- [ ] **Step 5: Update the provider-error assertion for the HTTP-wrapped message**

Provider failures now travel over HTTP: the stub `/summary` handler returns `500 {"error":"mock provider failure"}`, and `requestJson` surfaces it as `HTTP 500: {"error":"mock provider failure"}` (`http-client.ts:356-357`), so the runner's fatal text becomes `Benchmark fixture 'provider-error-case' failed: HTTP 500: {"error":"mock provider failure"}`. In `tests/runtime-benchmark.test.ts`, the test 'benchmark runner fails fast on provider errors ...' asserts the old in-process prefix (line 203). Change:
```ts
        /Benchmark fixture 'provider-error-case' failed: mock provider failure/u,
```
→
```ts
        /Benchmark fixture 'provider-error-case' failed: HTTP 500: .*mock provider failure/u,
```
(The artifact assertion `assert.match(artifact.FatalError, /mock provider failure/u)` on line 210 is a substring match and stays valid. The timeout test on line 84 is unaffected: the client-side `runWithFixtureDeadline` deadline still rejects first with `FatalBenchmarkError`.)

- [ ] **Step 6: Run the benchmark + matrix test suites to verify PASS**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "benchmark runner"`
Expected: PASS — all `benchmark runner` tests, including the timeout, default-timeout, provider-error, and prompt-prefix cases (the stub `/summary` runs `summarizeRequest` server-side and `runWithFixtureDeadline` still enforces the client-side deadline).
Run: `node ./dist/scripts/run-tests.js --test-name-pattern "matrix"` (covers `tests/runtime-benchmark.matrix.test.ts`, whose stub provides `server.configUrl`, so the Step 4b env makes the child target the stub's `/summary`).
Expected: PASS. If a matrix assertion encoded the old ambient-env behavior, update it to expect the manifest-server target.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bench/benchmark/runner.ts bench/benchmark-matrix/benchmark-runner.ts tests/_runtime-helpers.ts tests/runtime-benchmark.test.ts
git commit -m "feat(F15): route benchmark runner through POST /summary and wire matrix child to manifest server"
```

---

## Task 6: Route the fixture-debug script through `POST /summary`

`bench/repro/run-benchmark-fixture-debug.ts` (an `@ts-nocheck` debug harness) is the second direct `summarizeRequest` caller. Its existing tests (`tests/runtime-benchmark.test.ts:215-319`) run under `withStubServer`, which implements `/summary`.

**Files:**
- Modify: `bench/repro/run-benchmark-fixture-debug.ts:7,210` (swap in-process call for the API client)

- [ ] **Step 1: Swap the import**

In `bench/repro/run-benchmark-fixture-debug.ts` replace line 7:
```ts
import { summarizeRequest } from '../../src/summary.js';
```
→
```ts
import { StatusServerApiClient } from '../../src/cli/status-server-api-client.js';
```

- [ ] **Step 2: Swap the call**

In `bench/repro/run-benchmark-fixture-debug.ts` replace the call at line 210:
```ts
    const result = await summarizeRequest({
```
→
```ts
    const result = await new StatusServerApiClient().requestSummary({
```
(The request body — `question`, `inputText`, `format`, `policyProfile`, `requestTimeoutSeconds` — and all reads of `result.RequestId`/`result.Summary`/`result.Classification`/`result.RawReviewRequired`/`result.ModelCallSucceeded`/`result.ProviderError` are unchanged; `requestSummary` returns the same `SummaryResult`.)

- [ ] **Step 3: Verify no in-process `summarizeRequest` callers remain in bench**

Run: `git grep -n "summarizeRequest" -- bench`
Expected: no matches.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`run-benchmark-fixture-debug.ts` is `@ts-nocheck`, so this guards only the rest of the tree; the script's behavior is covered by tests in Step 5.)

- [ ] **Step 5: Run the fixture-debug tests**

Run: `npm run build:test && node ./dist/scripts/run-tests.js --test-name-pattern "run-benchmark-fixture-debug"`
Expected: PASS — fixture mode, direct file mode, and the failure-artifact case.

- [ ] **Step 6: Commit**

```bash
git add bench/repro/run-benchmark-fixture-debug.ts
git commit -m "feat(F15): route fixture-debug harness through POST /summary"
```

---

## Task 7: Full verification and architecture-review update

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md` (remove F15 + its priority entry; bump `Last pruned`)

- [ ] **Step 1: Full grep gate**

Run: `git grep -n "src/eval\.ts\|src/benchmark-spec-settings\|from '\.\./eval\.js'" -- src tests bench scripts | grep -v "eval-types\|status-server/eval\|bench/spec-settings"`
Expected: no matches.
Run: `git grep -n "summarizeRequest" -- bench`
Expected: no matches.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: PASS (src + scripts + dashboard + bench + test + lint).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Mark F15 resolved in the architecture review**

In `ARCHITECTURE-REVIEW.md`:
- Delete the `### F15` block (lines 12-17) and the blank-line/`---` separator that follows it.
- In the `## Priority order` list, delete item 1 (the F15 line at line 92) and renumber the remaining entry, so the list reads:
```markdown
## Priority order

1. Fix repo-search/chat LLM behavior in this order: append-only/non-assistant harness messages (L4, L5, L7), finish policy and duplicate pressure (L2, L3), parser repair boundaries (L6), real chat condense and prompt accounting (L10), sampling ownership by request class (L1), default prompt and web-grounding scope (L8, L11), tool replay truncation labeling (L9).
```
- Bump `Last pruned:` (line 6) to `2026-06-26`.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE-REVIEW.md
git commit -m "docs(architecture-review): mark F15 resolved after eval/benchmark repackage and bench /summary routing"
```

---

## Self-Review Notes (for the implementer)

- **Shipping-graph invariant after this work:** `dist/` (from `src/**`) contains no bench-only modules. `benchmark-spec-settings.ts` lives under `bench/`; `eval.ts` lives under `src/status-server/` and legitimately ships as server runtime.
- **Single repo-root source of truth:** every bench module and `eval.ts` resolve the repo root through `findNearestSiftKitRepoRoot` (directly, or via `bench/common/paths.ts`). The previous `bench/benchmark/args.ts` three-`..` bug (parent-of-repo) is gone.
- **`/summary` is now lossless for bench:** `promptPrefix` and `llamaCppOverrides.MaxTokens` survive the HTTP hop; the engine already forwarded everything else.
- **Green at every commit:** each task edits the tests/fixtures it touches in the same commit, validated by `npm run typecheck` (not bare `tsc --noEmit`, which skips `tests/` and `bench/`).
- **Bench now requires a running status server** (the queue serializes its model requests) — this closes the F11-flagged coverage gap where bench `summarizeRequest` callers ran with no cross-process coordination.
- **Deliberately NOT merged:** the two `interrupt.ts`, `args.ts`, `types.ts`, and `runner.ts` pairs remain separate — they are role-parallel, not duplicated, and merging them would require passing closures dynamically (repo-banned) or inventing false abstractions.
