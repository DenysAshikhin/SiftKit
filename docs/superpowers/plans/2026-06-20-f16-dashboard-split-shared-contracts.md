# F16 — Dashboard Split + Shared Server Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-mirrored dashboard/server payload types with a single zod-derived contract package validated at the fetch boundary, then split the `DashboardApp` controller monolith and `styles.css` into cohesive feature modules.

**Architecture:** A new top-level npm-workspace package `@siftkit/contracts` holds zod schemas as the single source of truth for every dashboard wire payload (runs, metrics, idle-summary, chat, benchmark, system, config). Types are `z.infer` of those schemas. **Each schema mirrors the actual route producer's emitted DTO** — not an internal analytics/domain type — and is locked to that producer by a runtime conformance test. The dashboard imports the schemas and validates every response with `schema.parse()`, eliminating the IO-boundary cast. Phase B then extracts `DashboardApp`'s ~40 handlers and 6 refresh-effects into per-feature controller hooks, each typed to return its tab's existing props, with explicit refresh coordination.

**Tech Stack:** TypeScript (ESM, NodeNext), zod 4, React 19, Vite 7, Node test runner (`node --test`) compiled via `build:test`, c8 coverage, eslint (cast / `any` / `unknown` / namespace-import / broad-`JsonValue`-union bans enforced — see `eslint.config.mjs`).

---

## Conventions for every task

- **eslint hard bans** (`eslint.config.mjs`): no `as`/`<T>` casts, no explicit `any`, **no explicit `unknown` keyword**, no `import * as`, no `JsonValue` inside a union type. `dashboard/src/api.ts` is **not** on the sanctioned-`unknown` list, so the fetch boundary must use `schema.parse(await response.json())` with **no type annotation** on the awaited value — `response.json()` is implicitly `any` (allowed: the ban is on the explicit `any`/`unknown` *token*, not inferred types), and `parse` returns `z.infer<S>`.
- **TDD:** schema/logic tasks write a failing test first. Type-replacement tasks use `npm run typecheck` red→green as the cycle; the step states the exact expected error.
- **All automated tests live in root `tests/`** as `*.test.ts`. The runner (`scripts/test-targets.ts`) scans only that directory; root `tsconfig.test.json` typechecks `src/**` + `tests/**`. Contract tests are `tests/contracts-*.test.ts`; dashboard tests are `tests/dashboard-*.test.ts`. Never create a `packages/contracts/tests` or `dashboard/tests` suite — they are not discovered, typechecked, or covered.
- **Commit after every task** using the repo's conventional style; end every commit message body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Shell is Windows PowerShell.** Chain checked steps with `; if ($?) { … }` (PowerShell 5.1 has no `&&`). For line counts use `(Get-Content <path> | Measure-Object -Line).Lines`, never `wc -l`. The Bash tool is available for POSIX-only needs.
- **All cross-package imports use the bare specifier `@siftkit/contracts`.**

---

# PHASE 0 — Scaffold, wire the workspace, and integrate the test/lint pipeline

### Task 0.1: Create the contracts package skeleton

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`

- [ ] **Step 1: Write `packages/contracts/package.json`**

```json
{
  "name": "@siftkit/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -p ./tsconfig.json" },
  "dependencies": { "zod": "^4.4.3" },
  "devDependencies": { "typescript": "^5.9.2" }
}
```

- [ ] **Step 2: Write `packages/contracts/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "declaration": true, "declarationMap": true, "sourceMap": true, "composite": true,
    "outDir": "./dist", "rootDir": "./src", "strict": true,
    "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true, "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `packages/contracts/src/index.ts`** → `export {};`

- [ ] **Step 4: Build it.** Run: `npm --prefix .\packages\contracts install ; if ($?) { npm --prefix .\packages\contracts run build }`
Expected: exit 0; `packages/contracts/dist/index.js` + `index.d.ts` exist.

- [ ] **Step 5: Commit** `build(contracts): scaffold @siftkit/contracts package`

---

### Task 0.2: Consolidate root + dashboard into one npm workspace

**Files:**
- Modify: `package.json`, `dashboard/package.json`, `dashboard/vite.config.ts`
- Modify: `tsconfig.json`, `tsconfig.test.json`, `tsconfig.bench.json`, `dashboard/tsconfig.json`, `dashboard/tsconfig.test.json`
- Delete: `dashboard/package-lock.json`

- [ ] **Step 1: Root `package.json`** — add the workspace + dependency, and build contracts first in `build`/`test`/`build:test`. Change ONLY these entries:

```jsonc
{
  "workspaces": ["packages/contracts", "dashboard"],
  "scripts": {
    "build": "npm --prefix .\\packages\\contracts run build && tsc -p .\\tsconfig.json && tsc -p .\\tsconfig.scripts.json && npm --prefix .\\dashboard run build && node .\\scripts\\sync-dist-runtime.js",
    "build:test": "npm --prefix .\\packages\\contracts run build && node .\\scripts\\build-test.js",
    "typecheck": "tsc -b .\\packages\\contracts\\tsconfig.json && tsc -p .\\tsconfig.json --noEmit && tsc -p .\\tsconfig.scripts.json --noEmit && tsc -p .\\dashboard\\tsconfig.json --noEmit && npm run typecheck:bench && npm run typecheck:test && npm run typecheck:dashboard-test && npm run typecheck:analysis && npm run lint"
  },
  "dependencies": { "@siftkit/contracts": "*" }
}
```

(Keep every other existing field/script unchanged. `test` already runs `typecheck:test && build:test && …`, so building contracts inside `build:test` covers the runtime-resolution need before compiled tests run.)

- [ ] **Step 2:** Add `"@siftkit/contracts": "*"` to `dashboard/package.json` dependencies.

- [ ] **Step 3:** `git rm dashboard/package-lock.json`

- [ ] **Step 4: Dev-time path alias** — in `tsconfig.json`, `tsconfig.test.json`, `tsconfig.bench.json`, `dashboard/tsconfig.json`, `dashboard/tsconfig.test.json`, add under `compilerOptions` (add `"baseUrl": "."` if absent). Root configs:

```jsonc
"paths": { "@siftkit/contracts": ["./packages/contracts/src/index.ts"] }
```

For the two `dashboard/` configs, merge into their existing `paths` block (do not drop the react aliases) with value `["../packages/contracts/src/index.ts"]`.

- [ ] **Step 5: Vite alias** in `dashboard/vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
// inside defineConfig, add/extend resolve.alias with this one entry:
'@siftkit/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
```

- [ ] **Step 6: Reinstall.** Run: `npm install`
Expected: one root lockfile; `node_modules/@siftkit/contracts` symlink exists; exit 0.

- [ ] **Step 7: Smoke-test resolution.** Temporarily add `export const CONTRACTS_OK = true;` to `packages/contracts/src/index.ts`, then in `dashboard/src/api.ts` add `import { CONTRACTS_OK } from '@siftkit/contracts'; void CONTRACTS_OK;`.
Run: `npm run typecheck`
Expected: PASS (proves server, dashboard, and test configs all resolve the bare specifier). Revert both throwaway edits.

- [ ] **Step 8: Commit** `build: consolidate root+dashboard into npm workspace resolving @siftkit/contracts`

---

### Task 0.3: Prove the contract-test + dashboard-test pipeline before writing real tests

This guards against the P1 integration gap: a test that is not discovered, typechecked, and covered is worthless.

**Files:**
- Create: `tests/contracts-pipeline-smoke.test.ts`
- Modify: `packages/contracts/src/index.ts` (temporary export), then revert

- [ ] **Step 1:** Add a temporary `export const PIPELINE_OK = 1;` to `packages/contracts/src/index.ts`.

- [ ] **Step 2:** Write `tests/contracts-pipeline-smoke.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_OK } from '@siftkit/contracts';

test('contract package is importable from a root test', () => {
  assert.equal(PIPELINE_OK, 1);
});
```

- [ ] **Step 3: Run the real suite path.** Run: `npm test -- contracts-pipeline-smoke`
Expected: the test is discovered, the compiled test resolves `@siftkit/contracts` from `packages/contracts/dist`, and it PASSES. If it fails to resolve, contracts was not built before `build:test` — fix Task 0.2 Step 1.

- [ ] **Step 4: Confirm coverage sees the package.** Decide coverage policy: schemas are declarative; per-line coverage adds little. Leave `test:coverage`'s `--include=src/**` as-is (contract *logic* is exercised via `tests/`), and note here that contract schemas are validated by conformance tests, not line coverage. No change required.

- [ ] **Step 5:** Delete `tests/contracts-pipeline-smoke.test.ts`; revert the temporary export.

- [ ] **Step 6: Commit** (config/pipeline only, if anything changed) — otherwise skip. If nothing remains changed, no commit.

---

# PHASE A — Contracts

Order: primitives → runs → metrics → idle-summary → chat → benchmark → system → config → fetch-boundary → delete mirrors. Every domain task: **(1) schema + parse/reject test, (2) runtime conformance test binding the schema to the real route producer, (3) repoint the producer's wire type.** The conformance test is the safety net for any field I mis-specified below — if a producer emits a shape the schema rejects, that test fails loudly and the executor reconciles (fix the schema to the real producer; never loosen blindly — confirm the producer is correct first).

---

### Task A.0: JSON primitives (lint-safe, no `JsonValue` union name)

**Files:** Create `packages/contracts/src/primitives.ts`, `tests/contracts-primitives.test.ts`; modify `packages/contracts/src/index.ts`.

- [ ] **Step 1:** Write `tests/contracts-primitives.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonDataSchema, JsonObjectSchema } from '@siftkit/contracts';

test('JsonDataSchema accepts nested json', () => {
  const value = { a: 1, b: [true, null, 'x'], c: { d: 2 } };
  assert.deepEqual(JsonDataSchema.parse(value), value);
});

test('JsonObjectSchema rejects a non-object', () => {
  assert.throws(() => JsonObjectSchema.parse([1, 2, 3]));
});
```

- [ ] **Step 2: Run — Expected FAIL** (`JsonDataSchema` not exported). Run: `npm test -- contracts-primitives`

- [ ] **Step 3:** Write `packages/contracts/src/primitives.ts`. Use `z.json()` (zod 4) to avoid hand-writing a `JsonValue`-named union (which the lint gate forbids):

```ts
import { z } from 'zod';

export const JsonDataSchema = z.json();
export type JsonData = z.infer<typeof JsonDataSchema>;

export const JsonObjectSchema = z.record(z.string(), JsonDataSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
```

> The exported type is `JsonData`, never `JsonValue`, so the `TSUnionType > TSTypeReference[typeName.name="JsonValue"]` lint selector cannot match. Use `JsonObjectSchema`/`JsonDataSchema` for arbitrary-JSON fields (`rawPaths`, event `payload`, benchmark `managedPreset`).

- [ ] **Step 4:** Add `export * from './primitives.ts';` to the barrel.

- [ ] **Step 5: Run — Expected PASS.** Then `npm run lint` — Expected PASS (no banned tokens).

- [ ] **Step 6: Commit** `feat(contracts): add json primitive schemas`

---

### Task A.1: Runs schema + conformance + server adoption

**Files:** Create `packages/contracts/src/runs.ts`, `tests/contracts-runs.test.ts`; modify barrel + `src/status-server/dashboard-runs/types.ts:31-54`.

- [ ] **Step 1:** Write `tests/contracts-runs.test.ts` (parse/reject + conformance against `normalizeRunRecord`):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunRecordSchema, RunsResponseSchema } from '@siftkit/contracts';
import { normalizeRunRecord } from '../src/status-server/dashboard-runs/run-records.js';

test('RunsResponseSchema rejects a missing total', () => {
  assert.throws(() => RunsResponseSchema.parse({ runs: [] }));
});

test('normalizeRunRecord output satisfies RunRecordSchema (conformance)', () => {
  const record = normalizeRunRecord({ id: 'r1', kind: 'summary', status: 'completed', title: 't', rawPaths: {} });
  assert.doesNotThrow(() => RunRecordSchema.parse(record));
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-runs`

- [ ] **Step 3:** Write `packages/contracts/src/runs.ts`:

```ts
import { z } from 'zod';
import { JsonDataSchema, JsonObjectSchema } from './primitives.ts';

export const RunGroupFilterSchema = z.enum(['', 'summary', 'repo_search', 'planner', 'chat', 'other']);
export type RunGroupFilter = z.infer<typeof RunGroupFilterSchema>;

export const RunLogDeleteTypeSchema = z.enum(['all', 'summary', 'repo_search', 'planner', 'chat', 'other']);
export type RunLogDeleteType = z.infer<typeof RunLogDeleteTypeSchema>;

export const RunLogDeleteCriteriaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('count'), type: RunLogDeleteTypeSchema, count: z.number() }),
  z.object({ mode: z.literal('before_date'), type: RunLogDeleteTypeSchema, beforeDate: z.string() }),
]);
export type RunLogDeleteCriteria = z.infer<typeof RunLogDeleteCriteriaSchema>;

export const RunLogDeletePreviewResponseSchema = z.object({ ok: z.boolean(), matchCount: z.number() });
export type RunLogDeletePreviewResponse = z.infer<typeof RunLogDeletePreviewResponseSchema>;

export const RunLogDeleteResponseSchema = z.object({
  ok: z.boolean(), deletedCount: z.number(), deletedRunIds: z.array(z.string()),
});
export type RunLogDeleteResponse = z.infer<typeof RunLogDeleteResponseSchema>;

export const RunRecordSchema = z.object({
  id: z.string(), kind: z.string(), status: z.string(),
  startedAtUtc: z.string().nullable(), finishedAtUtc: z.string().nullable(),
  title: z.string(), model: z.string().nullable(), backend: z.string().nullable(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), thinkingTokens: z.number().nullable(),
  toolTokens: z.number().nullable(), promptCacheTokens: z.number().nullable(), promptEvalTokens: z.number().nullable(),
  promptEvalDurationMs: z.number().nullable(), generationDurationMs: z.number().nullable(),
  speculativeAcceptedTokens: z.number().nullable(), speculativeGeneratedTokens: z.number().nullable(),
  durationMs: z.number().nullable(), providerDurationMs: z.number().nullable(), wallDurationMs: z.number().nullable(),
  rawPaths: JsonObjectSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunEventSchema = z.object({ kind: z.string(), at: z.string().nullable(), payload: JsonDataSchema });
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunDetailResponseSchema = z.object({ run: RunRecordSchema, events: z.array(RunEventSchema) });
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const RunsResponseSchema = z.object({ runs: z.array(RunRecordSchema), total: z.number() });
export type RunsResponse = z.infer<typeof RunsResponseSchema>;
```

- [ ] **Step 4:** Barrel `export * from './runs.ts';`. Run `npm test -- contracts-runs` — Expected PASS. If the conformance test throws, reconcile the schema to `normalizeRunRecord`'s real output.

- [ ] **Step 5: Adopt server-side.** In `src/status-server/dashboard-runs/types.ts`, delete the local `RunRecord` type (lines 31–54) and add after the imports: `export type { RunRecord } from '@siftkit/contracts';`. Leave the DB-row schema/types untouched. Run `tsc -p .\tsconfig.json --noEmit` — Expected PASS.

- [ ] **Step 6: Commit** `feat(contracts): add runs schema; adopt server RunRecord`

---

### Task A.2: Metrics schema + conformance + server adoption

**Files:** Create `packages/contracts/src/metrics.ts`, `tests/contracts-metrics.test.ts`; modify barrel + server metrics producer.

- [ ] **Step 1:** Write `tests/contracts-metrics.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsResponseSchema, ToolStatsByTaskSchema } from '@siftkit/contracts';

test('ToolStatsByTaskSchema requires all four task keys', () => {
  assert.throws(() => ToolStatsByTaskSchema.parse({ summary: {}, plan: {}, 'repo-search': {} }));
});

test('MetricsResponseSchema accepts a shaped empty payload', () => {
  const payload = {
    days: [], taskDays: [],
    toolStats: { summary: {}, plan: {}, 'repo-search': {}, chat: {} },
    webSearchUsage: { currentMonth: '2026-06', currentMonthCount: 0, allTimeCount: 0 },
  };
  assert.deepEqual(MetricsResponseSchema.parse(payload), payload);
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-metrics`

- [ ] **Step 3:** Write `packages/contracts/src/metrics.ts`:

```ts
import { z } from 'zod';

export const TaskMetricKindSchema = z.enum(['summary', 'plan', 'repo-search', 'chat']);
export type TaskMetricKind = z.infer<typeof TaskMetricKindSchema>;

export const MetricDaySchema = z.object({
  date: z.string(), runs: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  thinkingTokens: z.number(), toolTokens: z.number(), promptCacheTokens: z.number(), promptEvalTokens: z.number(),
  cacheHitRate: z.number().nullable(), speculativeAcceptedTokens: z.number(), speculativeGeneratedTokens: z.number(),
  acceptanceRate: z.number().nullable(), successCount: z.number(), failureCount: z.number(), avgDurationMs: z.number(),
});
export type MetricDay = z.infer<typeof MetricDaySchema>;

export const TaskMetricDaySchema = z.object({
  date: z.string(), taskKind: TaskMetricKindSchema, runs: z.number(), inputTokens: z.number(),
  outputTokens: z.number(), thinkingTokens: z.number(), toolTokens: z.number(),
  promptCacheTokens: z.number(), promptEvalTokens: z.number(), avgDurationMs: z.number(),
});
export type TaskMetricDay = z.infer<typeof TaskMetricDaySchema>;

export const ToolTypeStatsSchema = z.object({
  calls: z.number(), outputCharsTotal: z.number(), outputTokensTotal: z.number(),
  outputTokensEstimatedCount: z.number(), lineReadCalls: z.number(), lineReadLinesTotal: z.number(),
  lineReadTokensTotal: z.number(), finishRejections: z.number(), semanticRepeatRejects: z.number(),
  stagnationWarnings: z.number(), forcedFinishFromStagnation: z.number(), promptInsertedTokens: z.number(),
  rawToolResultTokens: z.number(), newEvidenceCalls: z.number(), noNewEvidenceCalls: z.number(),
  lineReadRecommendedLines: z.number().optional(), lineReadAllowanceTokens: z.number().optional(),
});
export type ToolTypeStats = z.infer<typeof ToolTypeStatsSchema>;

export const ToolStatsByTaskSchema = z.object({
  summary: z.record(z.string(), ToolTypeStatsSchema),
  plan: z.record(z.string(), ToolTypeStatsSchema),
  'repo-search': z.record(z.string(), ToolTypeStatsSchema),
  chat: z.record(z.string(), ToolTypeStatsSchema),
});
export type ToolStatsByTask = z.infer<typeof ToolStatsByTaskSchema>;

// Per-task aggregate totals (src/status-server/dashboard-runs/metrics.ts MetricTotals). Reused by idle-summary.
export const MetricTotalsSchema = z.object({
  inputCharactersTotal: z.number(), outputCharactersTotal: z.number(), inputTokensTotal: z.number(),
  outputTokensTotal: z.number(), thinkingTokensTotal: z.number(), toolTokensTotal: z.number(),
  promptCacheTokensTotal: z.number(), promptEvalTokensTotal: z.number(),
  speculativeAcceptedTokensTotal: z.number(), speculativeGeneratedTokensTotal: z.number(),
  requestDurationMsTotal: z.number(), wallDurationMsTotal: z.number(), stdinWaitMsTotal: z.number(),
  serverPreflightMsTotal: z.number(), lockWaitMsTotal: z.number(), statusRunningMsTotal: z.number(),
  terminalStatusMsTotal: z.number(), completedRequestCount: z.number(),
});
export type MetricTotals = z.infer<typeof MetricTotalsSchema>;

export const WebSearchUsageSchema = z.object({
  currentMonth: z.string(), currentMonthCount: z.number(), allTimeCount: z.number(),
});
export type WebSearchUsage = z.infer<typeof WebSearchUsageSchema>;

export const MetricsResponseSchema = z.object({
  days: z.array(MetricDaySchema), taskDays: z.array(TaskMetricDaySchema),
  toolStats: ToolStatsByTaskSchema, webSearchUsage: WebSearchUsageSchema,
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
```

> Verify `MetricTotalsSchema` against the real `MetricTotals` in `src/status-server/dashboard-runs/metrics.ts` (the field list above is taken from `getDefaultTaskTotals` in `idle-summary.ts`). The idle conformance test (Task A.3) will fail if it drifts.

- [ ] **Step 4: Adopt server-side.** Grep `MetricsResponse|ToolStatsByTask|TaskMetricDay|MetricDay` in `src`. Replace duplicate `export type` declarations with re-exports from `@siftkit/contracts`; annotate the timeseries route builder's return type with `MetricsResponse`. Run `npm test -- contracts-metrics ; if ($?) { tsc -p .\tsconfig.json --noEmit }` — Expected PASS.

- [ ] **Step 5:** Barrel `export * from './metrics.ts';`.

- [ ] **Step 6: Commit** `feat(contracts): add metrics schema; adopt server-side`

---

### Task A.3: Idle-summary schema (route DTO, NOT the internal analytics type)

The route emits `{ latest: IdleSummarySnapshotRow | null, snapshots: IdleSummarySnapshotRow[] }` ([routes/dashboard.ts:300](../../src/status-server/routes/dashboard.ts)) where `IdleSummarySnapshotRow = IdleSummarySnapshot & { summaryText }` is produced by `normalizeIdleSummarySnapshotRow` ([dashboard-runs.ts:254](../../src/status-server/dashboard-runs.ts)). The contract mirrors **that row**, with every emitted field. The internal `IdleSummarySnapshot` type in `idle-summary.ts` is **not** modified.

**Files:** Create `packages/contracts/src/idle-summary.ts`, `tests/contracts-idle-summary.test.ts`; modify barrel.

- [ ] **Step 1:** Write `tests/contracts-idle-summary.test.ts` (conformance against the real producer):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleSummaryResponseSchema } from '@siftkit/contracts';
import { normalizeIdleSummarySnapshotRow } from '../src/status-server/dashboard-runs.js';

test('IdleSummaryResponseSchema accepts an empty payload', () => {
  const payload = { latest: null, snapshots: [] };
  assert.deepEqual(IdleSummaryResponseSchema.parse(payload), payload);
});

test('normalizeIdleSummarySnapshotRow output conforms', () => {
  // Build a minimal DB row matching IdleSummarySnapshotDbRow; see dashboard-runs.ts for the exact columns.
  const row = makeMinimalIdleSummaryDbRow(); // executor: construct from the DbRow schema in dashboard-runs.ts
  const normalized = normalizeIdleSummarySnapshotRow(row);
  assert.doesNotThrow(() => IdleSummaryResponseSchema.parse({ latest: normalized, snapshots: normalized ? [normalized] : [] }));
});
```

> Executor: read `normalizeIdleSummarySnapshotRow` and its `IdleSummarySnapshotDbRow` input in `src/status-server/dashboard-runs.ts` and build `makeMinimalIdleSummaryDbRow()` from the real column names. This binds the schema to the producer.

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-idle-summary`

- [ ] **Step 3:** Write `packages/contracts/src/idle-summary.ts` mirroring `IdleSummarySnapshotRow` exactly:

```ts
import { z } from 'zod';
import { TaskMetricKindSchema, MetricTotalsSchema, ToolTypeStatsSchema } from './metrics.ts';

const SnapshotTaskTotalsSchema = z.record(TaskMetricKindSchema, MetricTotalsSchema);
const SnapshotToolStatsSchema = z.record(TaskMetricKindSchema, z.record(z.string(), ToolTypeStatsSchema));

export const IdleSummarySnapshotRowSchema = z.object({
  emittedAtUtc: z.string(),
  inputTokensTotal: z.number(), outputTokensTotal: z.number(), inputOutputRatio: z.number(),
  thinkingTokensTotal: z.number(), toolTokensTotal: z.number(), promptCacheTokensTotal: z.number(),
  promptEvalTokensTotal: z.number(), speculativeAcceptedTokensTotal: z.number(), speculativeGeneratedTokensTotal: z.number(),
  inputCharactersTotal: z.number(), outputCharactersTotal: z.number(), requestDurationMsTotal: z.number(),
  wallDurationMsTotal: z.number(), stdinWaitMsTotal: z.number(), serverPreflightMsTotal: z.number(),
  lockWaitMsTotal: z.number(), statusRunningMsTotal: z.number(), terminalStatusMsTotal: z.number(),
  completedRequestCount: z.number(), savedTokens: z.number(), savedPercent: z.number(),
  compressionRatio: z.number(), avgOutputTokensPerRequest: z.number(), avgRequestMs: z.number(),
  avgTokensPerSecond: z.number(),
  inputCharactersPerContextToken: z.number().nullable(), chunkThresholdCharacters: z.number().nullable(),
  taskTotals: SnapshotTaskTotalsSchema, toolStats: SnapshotToolStatsSchema,
  summaryText: z.string(),
});
export type IdleSummarySnapshotRow = z.infer<typeof IdleSummarySnapshotRowSchema>;

export const IdleSummaryResponseSchema = z.object({
  latest: IdleSummarySnapshotRowSchema.nullable(),
  snapshots: z.array(IdleSummarySnapshotRowSchema),
});
export type IdleSummaryResponse = z.infer<typeof IdleSummaryResponseSchema>;
```

> `savedPercent`/`avgOutputTokensPerRequest`/`avgRequestMs`/`avgTokensPerSecond` can be `NaN` in the producer. `z.number()` accepts `NaN`; but `NaN` serializes to JSON `null`. If the conformance test reveals the wire value is `null`, change those four to `z.number().nullable()` and confirm what `normalizeIdleSummarySnapshotRow` actually stores/returns (it reads persisted DB rows, so the stored value governs). Reconcile via the test — do not guess.

- [ ] **Step 4:** Barrel `export * from './idle-summary.ts';`. Run `npm test -- contracts-idle-summary` — Expected PASS after reconciliation.

- [ ] **Step 5: Adopt at the route only.** Annotate the idle-summary route handler's response with `IdleSummaryResponse` (do not touch `idle-summary.ts`'s internal `IdleSummarySnapshot`). Run `tsc -p .\tsconfig.json --noEmit` — Expected PASS.

- [ ] **Step 6: Commit** `feat(contracts): add idle-summary route DTO schema bound to the producer`

---

### Task A.4: Chat schema (normalized wire shape) + server route adoption

Models the normalized wire payload (every field present), not the looser on-disk `ChatSession` in `src/state/chat-sessions.ts`. The disk type stays; the chat route normalizes disk → wire.

**Files:** Create `packages/contracts/src/chat.ts`, `tests/contracts-chat.test.ts`; modify barrel + `src/status-server/chat.ts:91-103` + chat route builders.

- [ ] **Step 1:** Write `tests/contracts-chat.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionResponseSchema, ChatMessageSchema } from '@siftkit/contracts';

const message = {
  id: 'm1', role: 'user', content: 'hi',
  inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0,
  createdAtUtc: '2026-01-01T00:00:00Z', sourceRunId: null,
};

test('ChatMessageSchema accepts a minimal user message', () => {
  assert.deepEqual(ChatMessageSchema.parse(message), message);
});

test('ChatSessionResponseSchema requires contextUsage', () => {
  const session = {
    id: 's1', title: 't', model: null, contextWindowTokens: 4096,
    condensedSummary: '', createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message],
  };
  assert.throws(() => ChatSessionResponseSchema.parse({ session }));
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-chat`

- [ ] **Step 3:** Write `packages/contracts/src/chat.ts` (field-for-field from the wire shape):

```ts
import { z } from 'zod';

export const ChatMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']),
  kind: z.enum(['user_text', 'assistant_answer', 'assistant_thinking', 'assistant_tool_call']).optional(),
  content: z.string(), inputTokensEstimate: z.number(), outputTokensEstimate: z.number(), thinkingTokens: z.number(),
  inputTokensEstimated: z.boolean().optional(), outputTokensEstimated: z.boolean().optional(), thinkingTokensEstimated: z.boolean().optional(),
  promptCacheTokens: z.number().nullable().optional(), promptEvalTokens: z.number().nullable().optional(),
  promptTokensPerSecond: z.number().nullable().optional(), generationTokensPerSecond: z.number().nullable().optional(),
  requestDurationMs: z.number().nullable().optional(), promptEvalDurationMs: z.number().nullable().optional(),
  generationDurationMs: z.number().nullable().optional(), requestStartedAtUtc: z.string().nullable().optional(),
  thinkingStartedAtUtc: z.string().nullable().optional(), thinkingEndedAtUtc: z.string().nullable().optional(),
  answerStartedAtUtc: z.string().nullable().optional(), answerEndedAtUtc: z.string().nullable().optional(),
  speculativeAcceptedTokens: z.number().nullable().optional(), speculativeGeneratedTokens: z.number().nullable().optional(),
  associatedToolTokens: z.number().optional(), thinkingContent: z.string().optional(),
  toolCallCommand: z.string().nullable().optional(), toolCallTurn: z.number().nullable().optional(),
  toolCallMaxTurns: z.number().nullable().optional(), toolCallExitCode: z.number().nullable().optional(),
  toolCallPromptTokenCount: z.number().nullable().optional(), toolCallOutputSnippet: z.string().nullable().optional(),
  toolCallOutput: z.string().nullable().optional(), toolCallStatus: z.enum(['running', 'done']).optional(),
  groundingStatus: z.enum(['ungrounded', 'snippet_only', 'fetched']).nullable().optional(),
  createdAtUtc: z.string(), sourceRunId: z.string().nullable(), compressedIntoSummary: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatPromptContextSchema = z.object({
  id: z.string(), role: z.literal('system'), kind: z.literal('system_context'),
  label: z.string(), content: z.string(), createdAtUtc: z.string(), deletable: z.literal(false),
});
export type ChatPromptContext = z.infer<typeof ChatPromptContextSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(), title: z.string(), model: z.string().nullable(), contextWindowTokens: z.number(),
  thinkingEnabled: z.boolean().optional(), webSearchEnabled: z.boolean().optional(), presetId: z.string().optional(),
  mode: z.enum(['chat', 'plan', 'repo-search']).optional(), planRepoRoot: z.string().optional(),
  condensedSummary: z.string(), createdAtUtc: z.string(), updatedAtUtc: z.string(),
  messages: z.array(ChatMessageSchema), promptContext: ChatPromptContextSchema.optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ContextUsageSchema = z.object({
  contextWindowTokens: z.number(), usedTokens: z.number(), chatUsedTokens: z.number(), thinkingUsedTokens: z.number(),
  toolUsedTokens: z.number(), totalUsedTokens: z.number(), remainingTokens: z.number(), warnThresholdTokens: z.number(),
  shouldCondense: z.boolean(), estimatedTokenFallbackTokens: z.number().optional(), providerOverheadTokens: z.number(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const ChatSessionResponseSchema = z.object({ session: ChatSessionSchema, contextUsage: ContextUsageSchema });
export type ChatSessionResponse = z.infer<typeof ChatSessionResponseSchema>;
export const ChatSessionsResponseSchema = z.object({ sessions: z.array(ChatSessionSchema) });
export type ChatSessionsResponse = z.infer<typeof ChatSessionsResponseSchema>;

const AutoAppendItemSchema = z.object({
  key: z.enum(['agentsMd', 'repoFileListing']), label: z.string(), enabledDefault: z.boolean(),
  available: z.boolean(), tokenCount: z.number(), tokenSource: z.enum(['llama.cpp', 'estimate']),
});
export const RepoSearchAutoAppendPreviewSchema = z.object({ agentsMd: AutoAppendItemSchema, repoFileListing: AutoAppendItemSchema });
export type RepoSearchAutoAppendPreview = z.infer<typeof RepoSearchAutoAppendPreviewSchema>;
```

- [ ] **Step 4:** Barrel `export * from './chat.ts';`. Run `npm test -- contracts-chat` — Expected PASS.

- [ ] **Step 5: Adopt server-side.** In `src/status-server/chat.ts` replace `export type ContextUsage = { … }` (91–103) with `export type { ContextUsage } from '@siftkit/contracts';`. Annotate the chat route's session/sessions response builders with `ChatSessionResponse`/`ChatSessionsResponse`. If the disk→wire normalizer fails to satisfy required fields, fix the normalizer to always populate them. Run `tsc -p .\tsconfig.json --noEmit` — Expected PASS.

- [ ] **Step 6: Commit** `feat(contracts): add chat wire schema; adopt server-side`

---

### Task A.5: Benchmark schema + server adoption

**Files:** Create `packages/contracts/src/benchmark.ts`, `tests/contracts-benchmark.test.ts`; modify barrel + benchmark server types.

- [ ] **Step 1:** Write `tests/contracts-benchmark.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardBenchmarkSessionDetailSchema, DashboardBenchmarkStartRequestSchema } from '@siftkit/contracts';

test('start request requires repetitions', () => {
  assert.throws(() => DashboardBenchmarkStartRequestSchema.parse({ questionPresetIds: [], managedPresetIds: [], specOverrides: [] }));
});

test('session detail accepts empty cases/attempts', () => {
  const detail = {
    session: {
      id: 's', status: 'completed', questionPresetCount: 0, caseCount: 0, repetitions: 1,
      currentCaseIndex: null, currentPromptIndex: null, currentRepeatIndex: null,
      restoreStatus: 'completed', restoreError: null, originalConfigJson: '{}',
      startedAtUtc: 'a', completedAtUtc: null, updatedAtUtc: 'b',
    }, cases: [], attempts: [],
  };
  assert.deepEqual(DashboardBenchmarkSessionDetailSchema.parse(detail), detail);
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-benchmark`

- [ ] **Step 3:** Write `packages/contracts/src/benchmark.ts`:

```ts
import { z } from 'zod';
import { JsonObjectSchema } from './primitives.ts';

export const DashboardBenchmarkTaskKindSchema = z.enum(['repo-search', 'summary']);
export type DashboardBenchmarkTaskKind = z.infer<typeof DashboardBenchmarkTaskKindSchema>;
export const DashboardBenchmarkSortKeySchema = z.enum([
  'completionSpeed', 'generationTokensPerSecond', 'acceptanceRate', 'outputQualityScore',
  'toolUseQualityScore', 'failureCount', 'sampleCount',
]);
export type DashboardBenchmarkSortKey = z.infer<typeof DashboardBenchmarkSortKeySchema>;
export const DashboardBenchmarkLogStreamKindSchema = z.enum(['orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_llama']);
export type DashboardBenchmarkLogStreamKind = z.infer<typeof DashboardBenchmarkLogStreamKindSchema>;

export const DashboardBenchmarkQuestionPresetSchema = z.object({
  id: z.string(), title: z.string(), taskKind: DashboardBenchmarkTaskKindSchema, prompt: z.string(),
  enabled: z.boolean(), seededKey: z.string().nullable().optional(), createdAtUtc: z.string(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkQuestionPreset = z.infer<typeof DashboardBenchmarkQuestionPresetSchema>;

export const DashboardBenchmarkSessionSchema = z.object({
  id: z.string(), status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  questionPresetCount: z.number(), caseCount: z.number(), repetitions: z.number(),
  currentCaseIndex: z.number().nullable(), currentPromptIndex: z.number().nullable(), currentRepeatIndex: z.number().nullable(),
  restoreStatus: z.enum(['pending', 'completed', 'failed']), restoreError: z.string().nullable(),
  originalConfigJson: z.string(), startedAtUtc: z.string(), completedAtUtc: z.string().nullable(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkSession = z.infer<typeof DashboardBenchmarkSessionSchema>;

export const DashboardBenchmarkCaseSchema = z.object({
  id: z.string(), sessionId: z.string(), caseIndex: z.number(), label: z.string(),
  managedPresetId: z.string(), managedPresetLabel: z.string(), managedPreset: JsonObjectSchema,
  specOverride: JsonObjectSchema, createdAtUtc: z.string(),
});
export type DashboardBenchmarkCase = z.infer<typeof DashboardBenchmarkCaseSchema>;

export const DashboardBenchmarkAttemptSchema = z.object({
  id: z.string(), sessionId: z.string(), caseId: z.string(), questionPresetId: z.string(),
  taskKind: DashboardBenchmarkTaskKindSchema, promptTitle: z.string(), prompt: z.string(), caseLabel: z.string(),
  managedPresetId: z.string(), managedPresetLabel: z.string(), caseIndex: z.number(), promptIndex: z.number(), repeatIndex: z.number(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  outputText: z.string().nullable(), error: z.string().nullable(), runId: z.string().nullable(), managedRunId: z.string().nullable(),
  durationMs: z.number().nullable(), promptTokensPerSecond: z.number().nullable(), generationTokensPerSecond: z.number().nullable(),
  acceptanceRate: z.number().nullable(), outputTokens: z.number().nullable(), thinkingTokens: z.number().nullable(),
  speculativeAcceptedTokens: z.number().nullable(), speculativeGeneratedTokens: z.number().nullable(),
  outputQualityScore: z.number().nullable(), toolUseQualityScore: z.number().nullable(),
  reviewNotes: z.string().nullable(), reviewedBy: z.string().nullable(), reviewedAtUtc: z.string().nullable(),
  startedAtUtc: z.string().nullable(), completedAtUtc: z.string().nullable(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkAttempt = z.infer<typeof DashboardBenchmarkAttemptSchema>;

export const DashboardBenchmarkSessionDetailSchema = z.object({
  session: DashboardBenchmarkSessionSchema, cases: z.array(DashboardBenchmarkCaseSchema), attempts: z.array(DashboardBenchmarkAttemptSchema),
});
export type DashboardBenchmarkSessionDetail = z.infer<typeof DashboardBenchmarkSessionDetailSchema>;
export const DashboardBenchmarkQuestionPresetsResponseSchema = z.object({ presets: z.array(DashboardBenchmarkQuestionPresetSchema) });
export type DashboardBenchmarkQuestionPresetsResponse = z.infer<typeof DashboardBenchmarkQuestionPresetsResponseSchema>;
export const DashboardBenchmarkSessionsResponseSchema = z.object({ sessions: z.array(DashboardBenchmarkSessionSchema) });
export type DashboardBenchmarkSessionsResponse = z.infer<typeof DashboardBenchmarkSessionsResponseSchema>;
export const DashboardBenchmarkStartRequestSchema = z.object({
  questionPresetIds: z.array(z.string()), managedPresetIds: z.array(z.string()), repetitions: z.number(), specOverrides: z.array(JsonObjectSchema),
});
export type DashboardBenchmarkStartRequest = z.infer<typeof DashboardBenchmarkStartRequestSchema>;
export const DashboardBenchmarkGradeRequestSchema = z.object({
  outputQualityScore: z.number().nullable(), toolUseQualityScore: z.number().nullable(), reviewNotes: z.string().nullable(), reviewedBy: z.string(),
});
export type DashboardBenchmarkGradeRequest = z.infer<typeof DashboardBenchmarkGradeRequestSchema>;
```

- [ ] **Step 4:** Barrel `export * from './benchmark.ts';`. Run `npm test -- contracts-benchmark` — Expected PASS.

- [ ] **Step 5: Adopt server-side.** Grep `DashboardBenchmark` types in `src`; re-export from `@siftkit/contracts`; annotate the runner's detail/list builders. Run `tsc -p .\tsconfig.json --noEmit` — Expected PASS.

- [ ] **Step 6: Commit** `feat(contracts): add benchmark schema; adopt server-side`

---

### Task A.6: System/health/quota schema

**Files:** Create `packages/contracts/src/system.ts`, `tests/contracts-system.test.ts`; modify barrel.

- [ ] **Step 1:** Write `tests/contracts-system.test.ts` (include a conformance check on the quota producer):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardHealthSchema, WebSearchQuotaResponseSchema } from '@siftkit/contracts';

test('health requires runtimeRoot', () => {
  assert.throws(() => DashboardHealthSchema.parse({ ok: true }));
});

test('quota response matches the provider/used/limit/remaining shape', () => {
  const r = { quotas: [{ provider: 'brave', used: 1, limit: 100, remaining: 99 }] };
  assert.deepEqual(WebSearchQuotaResponseSchema.parse(r), r);
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- contracts-system`

- [ ] **Step 3:** Write `packages/contracts/src/system.ts`. **`ProviderQuota` matches the real producer** `src/web-search/types.ts:36` (`provider/used/limit/remaining`, last three nullable):

```ts
import { z } from 'zod';

export const DashboardHealthSchema = z.object({
  ok: z.boolean(), disableManagedLlamaStartup: z.boolean(), statusPath: z.string(), configPath: z.string(),
  metricsPath: z.string(), idleSummarySnapshotsPath: z.string(), runtimeRoot: z.string(),
});
export type DashboardHealth = z.infer<typeof DashboardHealthSchema>;

export const ManagedFilePickerTargetSchema = z.enum(['managed-llama-executable', 'managed-llama-model']);
export type ManagedFilePickerTarget = z.infer<typeof ManagedFilePickerTargetSchema>;
export const ManagedFilePickerResponseSchema = z.object({ ok: z.boolean(), cancelled: z.boolean(), path: z.string().nullable() });
export type ManagedFilePickerResponse = z.infer<typeof ManagedFilePickerResponseSchema>;

export const ManagedLlamaStartupFailureSchema = z.object({ kind: z.literal('gpu_memory_oom'), requiredMiB: z.number(), availableMiB: z.number() });
export type ManagedLlamaStartupFailure = z.infer<typeof ManagedLlamaStartupFailureSchema>;

export const LlamaCppConnectionTestResponseSchema = z.object({
  ok: z.boolean(), statusCode: z.number(), baseUrl: z.string().optional(), error: z.string().optional(),
});
export type LlamaCppConnectionTestResponse = z.infer<typeof LlamaCppConnectionTestResponseSchema>;

// Matches src/web-search/types.ts ProviderQuota exactly.
export const ProviderQuotaSchema = z.object({
  provider: z.string(), used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(),
});
export type ProviderQuota = z.infer<typeof ProviderQuotaSchema>;
export const WebSearchQuotaResponseSchema = z.object({ quotas: z.array(ProviderQuotaSchema) });
export type WebSearchQuotaResponse = z.infer<typeof WebSearchQuotaResponseSchema>;
```

> `provider` is `WebSearchProviderId` (a string-literal union) in the producer; the contract uses `z.string()` to avoid coupling to the provider-id enum. The conformance angle here is the test above plus the dashboard's runtime `parse`. If a stricter enum is wanted later, import the provider-id list — out of scope now.

- [ ] **Step 4:** Barrel `export * from './system.ts';`. Run `npm test -- contracts-system` — Expected PASS.

- [ ] **Step 5: Commit** `feat(contracts): add system/health/quota schema`

---

### Task A.7: Config schema (`SiftConfig`) + restart response — close the last unchecked boundary

The global rule requires schema validation at every IO boundary. Config is the largest payload but is not exempt from validation — only its *types* were "already shared." We add a `SiftConfigSchema` and validate config + restart responses.

**Files:** Create `packages/contracts/src/config.ts`, `tests/contracts-config.test.ts`; modify barrel.

- [ ] **Step 1: Read `src/config/types.ts` in full** to enumerate `SiftConfig` and its nested members (`Runtime`, `Presets`, `Server.LlamaCpp` + `Presets`, `WebSearch`, managed-llama preset, operation-mode allowed tools, etc.). The schema mirrors that structure.

- [ ] **Step 2: Write `tests/contracts-config.test.ts`** — round-trip a **real** serialized config (conformance), so the schema is bound to the actual config shape, not my reconstruction:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SiftConfigSchema, RestartBackendResponseSchema } from '@siftkit/contracts';
import { getDefaultConfig } from '../src/config/defaults.js'; // executor: use the real default-config factory in src/config

test('SiftConfigSchema accepts the default config (conformance)', () => {
  assert.doesNotThrow(() => SiftConfigSchema.parse(getDefaultConfig()));
});

test('RestartBackendResponseSchema accepts ok with no config', () => {
  assert.doesNotThrow(() => RestartBackendResponseSchema.parse({ ok: true, restarted: false }));
});
```

> Executor: locate the canonical default/sample config factory in `src/config` (e.g. `getDefaultConfig`/`createDefaultConfig`). If none exists, load a committed config fixture. The point is to validate the schema against a real value.

- [ ] **Step 3: Run — Expected FAIL.** Run: `npm test -- contracts-config`

- [ ] **Step 4: Write `packages/contracts/src/config.ts`.** Build `SiftConfigSchema` mirroring `src/config/types.ts`. Structure (fill each nested object from the real type — the conformance test enforces correctness):

```ts
import { z } from 'zod';
// Compose nested schemas: ManagedLlamaPresetSchema, LlamaCppConfigSchema (with Presets + ActivePresetId),
// PresetSchema, WebSearchConfigSchema, RuntimeConfigSchema, etc., each mirroring src/config/types.ts.
// Then:
export const SiftConfigSchema = z.object({
  // Runtime: RuntimeConfigSchema,
  // Presets: z.array(PresetSchema),
  // Server: z.object({ LlamaCpp: LlamaCppConfigSchema, /* ...other server fields... */ }),
  // WebSearch: WebSearchConfigSchema,
  // ...every top-level SiftConfig key...
});
export type SiftConfig = z.infer<typeof SiftConfigSchema>;

export const RestartBackendResponseSchema = z.object({
  ok: z.boolean(), restarted: z.boolean(), error: z.string().optional(),
  config: SiftConfigSchema.optional(),
  startupFailure: z.object({ kind: z.literal('gpu_memory_oom'), requiredMiB: z.number(), availableMiB: z.number() }).nullable().optional(),
});
export type RestartBackendResponse = z.infer<typeof RestartBackendResponseSchema>;
```

> This is the one task that requires careful transcription of an existing large type. Work nested-object by nested-object; run the conformance test after each addition until the default config parses clean. The server keeps using its `SiftConfig` from `src/config/types.ts` (no forced rewrite of server config typing); add a second conformance test asserting `SiftConfigSchema` and the server type agree by parsing a server-produced config if cheaply available.

- [ ] **Step 5:** Barrel `export * from './config.ts';`. Run `npm test -- contracts-config` — Expected PASS once the default config round-trips.

- [ ] **Step 6: Commit** `feat(contracts): add SiftConfig + restart-response schema`

---

### Task A.8: Convert `fetchJson` to schema-validating and adopt schemas across `api.ts`

**Files:** Modify `dashboard/src/api.ts`, `dashboard/src/lib/chat-stream-parser.ts`; create `tests/dashboard-api.test.ts`.

- [ ] **Step 1: Write `tests/dashboard-api.test.ts`** (pure boundary function; `Response` is a Node/DOM global):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseJsonResponse } from '../dashboard/src/api.js';

test('parseJsonResponse validates against the schema', async () => {
  const out = await parseJsonResponse(new Response(JSON.stringify({ ok: true })), z.object({ ok: z.boolean() }));
  assert.deepEqual(out, { ok: true });
});
test('parseJsonResponse throws on schema mismatch', async () => {
  await assert.rejects(() => parseJsonResponse(new Response(JSON.stringify({ ok: 'no' })), z.object({ ok: z.boolean() })));
});
test('parseJsonResponse throws on non-ok status', async () => {
  await assert.rejects(() => parseJsonResponse(new Response('boom', { status: 500 }), z.object({ ok: z.boolean() })));
});
```

- [ ] **Step 2:** Add `tests/dashboard-api.test.ts` to `dashboard/tsconfig.test.json`'s `include` array (so it typechecks under bundler/DOM resolution like the existing dashboard tests). Confirm root `tsconfig.test.json` can also typecheck it (it imports only `zod` + `api.js`, no React) — if `api.ts`'s transitive imports pull React, instead add it to the root `tsconfig.test.json` `exclude` list and rely on dashboard typechecking, mirroring `dashboard-app-refresh.test.ts`. Decide based on the typecheck result in Step 5.

- [ ] **Step 3: Run — Expected FAIL** (`parseJsonResponse` not exported). Run: `npm test -- dashboard-api`

- [ ] **Step 4: Rewrite the boundary in `dashboard/src/api.ts`.** Replace `fetchJson` (lines 30–37):

```ts
import { z } from 'zod';

export async function parseJsonResponse<S extends z.ZodTypeAny>(response: Response, schema: S): Promise<z.infer<S>> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return schema.parse(await response.json());
}

async function fetchJson<S extends z.ZodTypeAny>(input: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  return parseJsonResponse(await fetch(input, init), schema);
}
```

> No `: unknown` / `: any` annotation anywhere — `schema.parse(await response.json())` keeps the awaited `any` implicit (lint-clean) and returns `z.infer<S>`.

- [ ] **Step 5: Thread schemas through every call site** and import inferred types from `@siftkit/contracts`. Pattern per endpoint (apply to all, including the inline-wrapper ones — `createBenchmarkQuestionPreset` → `z.object({ preset: DashboardBenchmarkQuestionPresetSchema })`, deletes → `z.object({ ok: z.boolean(), deleted: z.boolean(), id: z.string() })`, grade → `z.object({ attempt: DashboardBenchmarkAttemptSchema })`):

```ts
import {
  RunsResponseSchema, RunDetailResponseSchema, RunLogDeletePreviewResponseSchema, RunLogDeleteResponseSchema,
  MetricsResponseSchema, WebSearchQuotaResponseSchema, IdleSummaryResponseSchema, DashboardHealthSchema,
  DashboardBenchmarkQuestionPresetsResponseSchema, DashboardBenchmarkQuestionPresetSchema,
  DashboardBenchmarkSessionsResponseSchema, DashboardBenchmarkSessionDetailSchema, DashboardBenchmarkAttemptSchema,
  ManagedFilePickerResponseSchema, LlamaCppConnectionTestResponseSchema, ChatSessionResponseSchema,
  ChatSessionsResponseSchema, RepoSearchAutoAppendPreviewSchema, SiftConfigSchema, RestartBackendResponseSchema,
  type RunsResponse, type RunLogDeleteCriteria, type DashboardBenchmarkStartRequest, type DashboardBenchmarkGradeRequest,
  type ManagedFilePickerTarget,
} from '@siftkit/contracts';

export function getRuns(/* unchanged params */): Promise<RunsResponse> {
  // unchanged query building
  return fetchJson(`/dashboard/runs${suffix ? `?${suffix}` : ''}`, RunsResponseSchema);
}
export function getMetrics() { return fetchJson('/dashboard/metrics/timeseries', MetricsResponseSchema); }
// ...every other endpoint similarly...
```

- [ ] **Step 6: Config + restart now validated too.** `getDashboardConfig`/`updateDashboardConfig` use `SiftConfigSchema`; `restartBackend` parses its bespoke body with `RestartBackendResponseSchema` (replace its manual `JSON.parse` typing with a `RestartBackendResponseSchema.parse` on the parsed object, preserving the empty-`{}`-on-non-JSON branch). No unchecked reader remains.

- [ ] **Step 7: Validate the streamed final payload.** In `dashboard/src/lib/chat-stream-parser.ts`, where the `done` event payload is built, run it through `ChatSessionResponseSchema.parse(...)`. Annotate `consumeChatStream`'s return as `ChatSessionResponse`.

- [ ] **Step 8: Run dashboard typecheck + tests — Expected PASS.** Run: `tsc -p .\dashboard\tsconfig.json --noEmit ; if ($?) { npm run typecheck:dashboard-test ; if ($?) { npm test -- dashboard-api } }`

- [ ] **Step 9: Commit** `feat(dashboard): validate every fetch response against @siftkit/contracts`

---

### Task A.9: Delete the dashboard mirrors; repoint consumers

**Files:** Modify `dashboard/src/types.ts`; modify `tests/dashboard-presets.test.ts`, `tests/dashboard-metrics-view.test.ts`, `tests/dashboard-managed-presets.test.ts`, `tests/preset-editor.test.ts`; modify any component/hook importing a deleted type.

- [ ] **Step 1: Strip every payload type from `dashboard/src/types.ts`** now living in `@siftkit/contracts` (runs, metrics, idle, chat, benchmark, system, quota, health, file-picker, llama-test, **config**, **restart**). Keep only the config-type re-exports that remain genuinely dashboard-local (`DashboardPreset*`, `WebSearch*`, `DashboardLlamaCppConfig`, `DashboardManagedLlamaPreset`, `DashboardOperationModeAllowedTools`, `DashboardManagedLlamaSpeculativeType`) **if** they are not yet in the contract; `DashboardConfig`/`SiftConfig` and `RestartBackendResponse` now come from `@siftkit/contracts`. Replace the file body with a single barrel plus any still-local aliases:

```ts
export * from '@siftkit/contracts';
// ...only genuinely dashboard-local UI aliases that have no contract equivalent...
```

- [ ] **Step 2: Repoint the four test imports** to `@siftkit/contracts` for payload types (keep config/preset types resolving as they do today). Example `tests/dashboard-presets.test.ts`:

```ts
import type { ChatSession } from '@siftkit/contracts';
import type { DashboardConfig, DashboardPreset } from '../dashboard/src/types.js';
```

- [ ] **Step 3: Full typecheck** — each unresolved symbol is a consumer of a deleted mirror; repoint to `@siftkit/contracts` (or rely on the barrel). Run: `npm run typecheck`
Expected: PASS. Fix only by repointing imports — never re-add a mirror.

- [ ] **Step 4: Run the suite.** Run: `npm test`
Expected: PASS — the four named suites + all dashboard/contract tests now consume shared contracts and must stay green.

- [ ] **Step 5: Commit** `refactor(dashboard): delete payload mirrors; consume @siftkit/contracts`

---

# PHASE B — Split the monolith

`DashboardApp` (App.tsx 99–1278) holds all state, ~40 handlers, 6 refresh-effects, then renders the already-extracted tabs. We extract per-feature controller hooks. **Refresh coordination is explicit:** App owns the `refreshToken` counter and a `requestDashboardDataRefresh()` that (a) clears the runs controller's cache refs and (b) increments `refreshToken`; controllers that re-fetch (runs, metrics, benchmark, chat-sessions) take `refreshToken` as input and re-run their effect when it changes; mutation handlers (run delete, benchmark start/cancel, chat message delete, settings save) call `requestDashboardDataRefresh`.

**Each controller's return type is its tab's existing props type** (exported in Step 1 of each task). App becomes `const x = useXController(deps); … <XTab {...x} />`. Tab-internal derivations (`groupedRuns`, `recentIdlePoints`, `latestIdleSnapshot`, `sortedToolMetricRows`, `taskRunsGraphSeries`, `repoSearchChatSteps`, etc.) move into the owning controller.

**Dependency order:** B.1 `useToasts` → B.2 refresh coordinator + `useRunsController` → B.3 metrics → B.4 benchmark → B.5 settings → B.6 chat → B.7 thin shell → B.8 CSS.

**Test strategy:** pure helpers (reducers, builders) get unit tests in `tests/`; controller wiring gets one SSR E2E test per phase boundary following `tests/dashboard-app-refresh.test.ts` (render `<App>` via `renderToStaticMarkup` against dashboard's React, assert observable markup/behavior). New SSR tests register exactly like `dashboard-app-refresh.test.ts`: included in `dashboard/tsconfig.test.json`, excluded from root `tsconfig.test.json`. Mirror its `window` double and `createRequire` setup verbatim to stay lint-clean (do not introduce new `as`/`unknown` casts; copy the existing file's sanctioned pattern).

### Task B.0: Confirm harness + inventory (no commit)

- [ ] **Step 1:** Read `dashboard/src/App.tsx` fully; group every `useState`/`useEffect`/handler under `toasts | runs | metrics | benchmark | settings | chat | tab-routing | refresh`. Record which handlers call `requestDashboardDataRefresh` and which effects depend on `dashboardRefreshToken`.
- [ ] **Step 2:** Read the five tab prop types (`RunsTabProps`, `MetricsTabProps`, `BenchmarkTabProps` [exported], `SettingsTabProps`, `ChatTabProps`). These are the controller return contracts.

### Task B.1: Extract `useToasts` — preserve trim, blank-reject, 5-cap, 9s auto-dismiss

**Files:** Create `dashboard/src/hooks/useToasts.ts`, `tests/dashboard-toasts.test.ts`; modify `dashboard/src/App.tsx`.

- [ ] **Step 1: Write `tests/dashboard-toasts.test.ts`** asserting all four behaviors of the pure reducer:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { addToast, removeToast, type ToastState } from '../dashboard/src/hooks/useToasts.js';

const empty: ToastState = { toasts: [], nextSeq: 0 };

test('blank or whitespace text is rejected', () => {
  assert.equal(addToast(empty, 'info', '   ').toasts.length, 0);
});
test('text is trimmed', () => {
  assert.equal(addToast(empty, 'info', '  hi  ').toasts[0]?.text, 'hi');
});
test('caps at five, dropping oldest', () => {
  let s = empty;
  for (let i = 0; i < 7; i += 1) s = addToast(s, 'info', `m${i}`);
  assert.equal(s.toasts.length, 5);
  assert.equal(s.toasts[0]?.text, 'm2');
});
test('removeToast drops by id', () => {
  const s = addToast(empty, 'error', 'x');
  assert.deepEqual(removeToast(s, s.toasts[0]!.id).toasts, []);
});
```

> Note: the test uses `s.toasts[0]!.id` — the non-null `!` is banned by the gate. Instead write `const first = s.toasts[0]; assert.ok(first); removeToast(s, first.id)`. Apply that form in the actual test.

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- dashboard-toasts`

- [ ] **Step 3: Write `dashboard/src/hooks/useToasts.ts`** — pure reducer preserving every behavior; the 9s timer lives in the hook:

```ts
import { useState } from 'react';

export type ToastLevel = 'info' | 'warning' | 'error';
export type ToastMessage = { id: string; level: ToastLevel; text: string };
export type ToastState = { toasts: ToastMessage[]; nextSeq: number };

const MAX_TOASTS = 5;
export const TOAST_DISMISS_MS = 9000;

export function addToast(state: ToastState, level: ToastLevel, text: string): ToastState {
  const normalized = String(text || '').trim();
  if (!normalized) return state;
  const id = `${state.nextSeq}`;
  const toasts = [...state.toasts, { id, level, text: normalized }].slice(-MAX_TOASTS);
  return { toasts, nextSeq: state.nextSeq + 1 };
}
export function removeToast(state: ToastState, id: string): ToastState {
  return { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
}

export function useToasts() {
  const [state, setState] = useState<ToastState>({ toasts: [], nextSeq: 0 });
  function enqueueToast(level: ToastLevel, text: string): void {
    setState((prev) => {
      const next = addToast(prev, level, text);
      if (next === prev) return prev;
      const added = next.toasts[next.toasts.length - 1];
      if (added) window.setTimeout(() => setState((s) => removeToast(s, added.id)), TOAST_DISMISS_MS);
      return next;
    });
  }
  function dismissToast(id: string): void { setState((prev) => removeToast(prev, id)); }
  return { toasts: state.toasts, enqueueToast, dismissToast };
}
```

> The id is now a monotonic `nextSeq` string (deterministic, testable) instead of `Date.now()+random`. The toast key/handlers in the JSX continue to use `toast.id` unchanged.

- [ ] **Step 4: Run — Expected PASS.**

- [ ] **Step 5: Rewire `App.tsx`.** Delete the inline `ToastMessage`/`ToastLevel` types (87–92), the `toasts` state (166), `dismissToast` (207), `enqueueToast` (211). Add `const { toasts, enqueueToast, dismissToast } = useToasts();`. All `enqueueToast(level, text)` call sites are unchanged.

- [ ] **Step 6: Typecheck + tests — Expected PASS.** Run: `tsc -p .\dashboard\tsconfig.json --noEmit ; if ($?) { npm run typecheck:dashboard-test }`

- [ ] **Step 7: Commit** `refactor(dashboard): extract useToasts preserving cap/trim/dismiss`

### Task B.2: Refresh coordinator + `useRunsController`

**Files:** Create `dashboard/src/hooks/useDashboardRefresh.ts`, `dashboard/src/hooks/useRunsController.ts`, `tests/dashboard-runs-controller.test.ts`; modify `dashboard/src/App.tsx`, `dashboard/src/tabs/RunsTab.tsx` (export props).

- [ ] **Step 1: Export the props type.** In `RunsTab.tsx` change `type RunsTabProps` → `export type RunsTabProps`.

- [ ] **Step 2: Write the refresh coordinator `dashboard/src/hooks/useDashboardRefresh.ts`:**

```ts
import { useRef, useState } from 'react';

export function useDashboardRefresh() {
  const [refreshToken, setRefreshToken] = useState(0);
  const runsCacheResetRef = useRef<{ signature: string; loaded: boolean }>({ signature: '', loaded: false });
  function requestDashboardDataRefresh(): void {
    runsCacheResetRef.current = { signature: '', loaded: false };
    setRefreshToken((previous) => previous + 1);
  }
  return { refreshToken, runsCacheResetRef, requestDashboardDataRefresh };
}
```

> This replaces App's inline `dashboardRefreshToken`, `runsSignatureRef`, `runsLoadedRef`, and `requestDashboardDataRefresh` (App.tsx 114–116, 223–227). The runs controller reads `runsCacheResetRef` for its dedupe gate.

- [ ] **Step 3: Write the failing test `tests/dashboard-runs-controller.test.ts`** for the pure criteria builder:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunLogDeleteCriteria } from '../dashboard/src/hooks/useRunsController.js';

test('count mode', () => {
  assert.deepEqual(buildRunLogDeleteCriteria({ mode: 'count', type: 'summary', count: 10, beforeDate: '' }),
    { mode: 'count', type: 'summary', count: 10 });
});
test('before_date mode', () => {
  assert.deepEqual(buildRunLogDeleteCriteria({ mode: 'before_date', type: 'all', count: 0, beforeDate: '2026-01-01' }),
    { mode: 'before_date', type: 'all', beforeDate: '2026-01-01' });
});
```

- [ ] **Step 4: Run — Expected FAIL.** Run: `npm test -- dashboard-runs-controller`

- [ ] **Step 5: Write `dashboard/src/hooks/useRunsController.ts`.** Export `buildRunLogDeleteCriteria` (returns `RunLogDeleteCriteria` from `@siftkit/contracts`) and:

```ts
export function useRunsController(deps: {
  enqueueToast: (level: 'info' | 'warning' | 'error', text: string) => void;
  refreshToken: number;
  runsCacheResetRef: { current: { signature: string; loaded: boolean } };
  requestDashboardDataRefresh: () => void;
}): RunsTabProps { /* move runs state/effect/derivations/handlers verbatim; return exactly RunsTabProps */ }
```

Move into it: all runs `useState` (105–125), the `refreshRuns` effect (≈384–424) keyed on `deps.refreshToken` using `deps.runsCacheResetRef` for dedupe, `groupedRuns`/`isRepoSearchRunSelected`/`repoSearchChatSteps` derivations (183–193, 276–279), and `openRunDeleteModal`/`closeRunDeleteModal`/`handleConfirmRunDelete` (229–274, calling `deps.requestDashboardDataRefresh` + `deps.enqueueToast`). The returned object's keys are exactly `RunsTabProps`.

- [ ] **Step 6: Run — Expected PASS.**

- [ ] **Step 7: Rewire `App.tsx`:** `const refresh = useDashboardRefresh();` then `const runs = useRunsController({ enqueueToast, refreshToken: refresh.refreshToken, runsCacheResetRef: refresh.runsCacheResetRef, requestDashboardDataRefresh: refresh.requestDashboardDataRefresh });` and `<RunsTab {...runs} />`.

- [ ] **Step 8: Typecheck + tests — Expected PASS.**

- [ ] **Step 9: Commit** `refactor(dashboard): extract refresh coordinator + useRunsController`

### Task B.3: `useMetricsController`

**Files:** Create `dashboard/src/hooks/useMetricsController.ts`; modify `App.tsx`, `MetricsTab.tsx` (export props).

- [ ] **Step 1:** `export type MetricsTabProps`.
- [ ] **Step 2:** Write `useMetricsController(deps: { enqueueToast; refreshToken: number }): MetricsTabProps`. Move metrics/idle/quota state (127–133), the `refreshMetrics` effect (≈482–532) keyed on `deps.refreshToken`, and the derivations `latestIdleSnapshot`/`recentIdlePoints`/`sortedToolMetricRows`/`taskRunsGraphSeries` (194–205). Shaping stays delegated to `dashboard/src/metrics-view.ts` (already tested) — do not duplicate.
- [ ] **Step 3:** No new pure-logic test (shaping covered by `tests/dashboard-metrics-view.test.ts`). Rewire `App.tsx` → `const metrics = useMetricsController({ enqueueToast, refreshToken: refresh.refreshToken }); <MetricsTab {...metrics} />`.
- [ ] **Step 4: Typecheck + metrics suite — Expected PASS.** Run: `tsc -p .\dashboard\tsconfig.json --noEmit ; if ($?) { npm test -- dashboard-metrics-view }`
- [ ] **Step 5: Commit** `refactor(dashboard): extract useMetricsController`

### Task B.4: `useBenchmarkController`

**Files:** Create `dashboard/src/hooks/useBenchmarkController.ts`, `tests/dashboard-benchmark-controller.test.ts`; modify `App.tsx` (BenchmarkTabProps already exported).

- [ ] **Step 1:** Write `tests/dashboard-benchmark-controller.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBenchmarkStartRequest } from '../dashboard/src/hooks/useBenchmarkController.js';

test('builds a start request from selection', () => {
  assert.deepEqual(
    buildBenchmarkStartRequest({ questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] }),
    { questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] });
});
```

- [ ] **Step 2: Run — Expected FAIL.** Run: `npm test -- dashboard-benchmark-controller`
- [ ] **Step 3:** Write `useBenchmarkController(deps: { enqueueToast; refreshToken: number; requestDashboardDataRefresh: () => void }): BenchmarkTabProps`, exporting `buildBenchmarkStartRequest` (returns `DashboardBenchmarkStartRequest`). Move benchmark state (135–149), `refreshBenchmarkData` effect (≈539–596) keyed on `deps.refreshToken`, toggles (862–872), `onStartBenchmark`/`onCancelBenchmark`/`onUpdateBenchmarkAttemptGrade` (874–929, calling `deps.requestDashboardDataRefresh`), and the `openBenchmarkSessionEvents` SSE subscription. Toggles operate on the existing `string[]` selection state.
- [ ] **Step 4: Run — Expected PASS.** Rewire `App.tsx` → `const benchmark = useBenchmarkController({ enqueueToast, refreshToken: refresh.refreshToken, requestDashboardDataRefresh: refresh.requestDashboardDataRefresh }); <BenchmarkTab {...benchmark} />`.
- [ ] **Step 5: Typecheck + tests — Expected PASS.**
- [ ] **Step 6: Commit** `refactor(dashboard): extract useBenchmarkController`

### Task B.5: `useSettingsController`

**Files:** Create `dashboard/src/hooks/useSettingsController.ts`, `tests/dashboard-settings-controller.test.ts`; modify `App.tsx`, `SettingsTab.tsx` (export props).

- [ ] **Step 1:** `export type SettingsTabProps`.
- [ ] **Step 2:** Write `tests/dashboard-settings-controller.test.ts` for the pure `createUniquePresetId` (match the real preset-id field used in App's current implementation — read it first):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniquePresetId } from '../dashboard/src/hooks/useSettingsController.js';

test('disambiguates a colliding slug', () => {
  const existing = [{ id: 'my-preset' }];
  const id = createUniquePresetId(existing, 'My Preset');
  assert.notEqual(id, 'my-preset');
  assert.match(id, /my-preset/);
});
```

- [ ] **Step 3: Run — Expected FAIL.** Run: `npm test -- dashboard-settings-controller`
- [ ] **Step 4:** Write `useSettingsController(deps: { enqueueToast; requestDashboardDataRefresh: () => void }): SettingsTabProps`, exporting `createUniquePresetId`. Move the entire settings slice (config draft state 152–165, `refreshConfig` 635, the draft updaters 665–693, preset/managed add-delete 705–753, save/reload/restart 781–828 + 955, path picker 828, llama test 931, discard 947, and the dirty-guard continuation flow 987–1041 including the `DirtyContinuation` type and `onRequestTabChange`). The dirty-guard `onRequestTabChange` is returned for App's tab routing to call.
- [ ] **Step 5: Run — Expected PASS.** Rewire `App.tsx` → `const settings = useSettingsController({ enqueueToast, requestDashboardDataRefresh: refresh.requestDashboardDataRefresh }); <SettingsTab {...settings} />`.
- [ ] **Step 6: Typecheck + tests — Expected PASS.**
- [ ] **Step 7: Commit** `refactor(dashboard): extract useSettingsController`

### Task B.6: `useChatController`

**Files:** Create `dashboard/src/hooks/useChatController.ts`; modify `App.tsx`, `ChatTab.tsx` (export props).

- [ ] **Step 1:** `export type ChatTabProps`.
- [ ] **Step 2:** Write `useChatController(deps: { refreshToken: number; onChatError: (message: string) => void }): ChatTabProps`. The error dep is a `(message: string) => void` — App currently does `onError: (error) => setChatError(getErrorMessage(error))`; move `getErrorMessage` mapping inside the controller and have App pass `setChatError` (or the controller can own `chatError` state and return it as part of `ChatTabProps`). Do not introduce an `unknown`-typed error param (gate-banned). Compose the existing chat hooks (`useLiveMessages`, `useContextUsage`, `useChatSessions`, `usePlanInputs`, `useRepoSearchAutoAppend`, `useChatComposer`) that currently live inline in App (168–327+), plus `refreshAfterChatMessageMutation` (753), `onDeleteChatMessage` (765), `onDeleteChatTurn` (773), and the chat-derived values. `useChatSessions` already takes `refreshToken` — thread `deps.refreshToken` in. Return exactly `ChatTabProps`.
- [ ] **Step 3:** No new pure test (logic lives in the already-covered chat hooks/lib). Rewire `App.tsx` → `const chat = useChatController({ refreshToken: refresh.refreshToken, /* error handler */ }); <ChatTab {...chat} />`.
- [ ] **Step 4: Typecheck + full test suite — Expected PASS.** Run: `tsc -p .\dashboard\tsconfig.json --noEmit ; if ($?) { npm test }`
- [ ] **Step 5: Commit** `refactor(dashboard): extract useChatController`

### Task B.7: Reduce `App.tsx` to a thin shell + SSR E2E guard

**Files:** Modify `dashboard/src/App.tsx`; create `tests/dashboard-app-controllers.test.ts`.

- [ ] **Step 1:** `DashboardApp` should now contain only: `useDashboardRefresh` + the six controller hooks, tab-routing state (`tab`, `menuOpen`, `isTabKey`), routing delegating to `settings.onRequestTabChange`, and the JSX tree spreading each controller into its tab. Remove every dead local. 

- [ ] **Step 2: Write an SSR E2E test `tests/dashboard-app-controllers.test.ts`** mirroring `dashboard-app-refresh.test.ts` exactly (same `createRequire`/`window`-double setup — copy it verbatim to stay lint-clean), asserting the refactored app still renders the five tabs and the refresh control:

```ts
// Header of file: copy lines 1-32 of tests/dashboard-app-refresh.test.ts verbatim (imports, React require, withDashboardWindow).
test('refactored dashboard renders tabs and refresh control', () => {
  const markup = withDashboardWindow(() => renderToStaticMarkup(React.createElement(App)));
  assert.match(markup, /aria-label="Refresh dashboard data"/u);
});
```

- [ ] **Step 3:** Register it like the existing SSR test: add to `dashboard/tsconfig.test.json` `include`; add to root `tsconfig.test.json` `exclude`.

- [ ] **Step 4: Verify line count dropped.** Run: `(Get-Content dashboard/src/App.tsx | Measure-Object -Line).Lines`
Expected: well under the original 1424 (target < 300).

- [ ] **Step 5: Full gate.** Run: `npm run typecheck ; if ($?) { npm test }`
Expected: both PASS.

- [ ] **Step 6: Commit** `refactor(dashboard): reduce App to thin shell + SSR controller guard`

### Task B.8: Split `styles.css`

**Files:** Modify `dashboard/src/styles.css`; create `dashboard/src/styles/runs.css|metrics.css|benchmark.css|chat.css`; modify each tab to import its CSS.

- [ ] **Step 1:** Partition `styles.css` by feature using per-tab class prefixes. Move runs/metrics/benchmark/chat rule blocks to the new files; settings/layout rules into existing `styles/settings.css`/`styles/layout.css`; keep only global/reset/token rules in `styles.css`.
- [ ] **Step 2:** Import each new file from its tab component (e.g. `import '../styles/runs.css';` atop `RunsTab.tsx`). Keep the global `styles.css` import in `main.tsx`.
- [ ] **Step 3: Build + eyeball.** Run: `npm --prefix .\dashboard run build` ; then `npm run start:dashboard` and visually confirm each tab is unchanged.
- [ ] **Step 4: Verify shrink.** Run: `(Get-Content dashboard/src/styles.css | Measure-Object -Line).Lines`
Expected: well under 1763.
- [ ] **Step 5: Commit** `refactor(dashboard): split styles.css into per-feature stylesheets`

---

# Final verification

### Task Z: Full green + finish

- [ ] **Step 1:** Run: `npm run typecheck ; if ($?) { npm test }` — both PASS (eslint inside typecheck confirms no banned casts/`any`/`unknown`/namespace imports/`JsonValue` unions were introduced).
- [ ] **Step 2:** Confirm coverage still runs: `npm run test:coverage` — completes; note contract schemas are validated by conformance tests, not line coverage.
- [ ] **Step 3: Deliverable check vs finding:**
  - `App.tsx` < 300 lines (was 1424). ✓
  - `styles.css` global-only (was 1763). ✓
  - No payload mirror remains in `dashboard/src/types.ts`. ✓
  - Every dashboard fetch (incl. config + restart + streamed chat final payload) validates against an `@siftkit/contracts` schema. ✓
  - Server producers source wire types from `@siftkit/contracts`; conformance tests bind each schema to its producer. ✓
- [ ] **Step 4:** Invoke superpowers:finishing-a-development-branch.

---

## Self-review notes (author)

- **Reviewer P0/P1/P2 all addressed:** eslint-legal boundary (no explicit `unknown`/`any`; Task A.8); config + restart now schema-validated (Task A.7 + A.8 Step 6 — pushed back against leaving config unchecked, in favor of a real schema, since the global rule outranks the finding's type-sharing note); `ProviderQuota` corrected to `provider/used/limit/remaining` (A.6); idle-summary modeled on `IdleSummarySnapshotRow`/`normalizeIdleSummarySnapshotRow`, internal type untouched (A.3); all tests in root `tests/` wired into typecheck/`npm test`/coverage with a pipeline-smoke gate first (0.3) and SSR E2E controller coverage (B.7); `useToasts` preserves trim/blank-reject/5-cap/9s-dismiss with tests (B.1); Phase B controllers carry real interfaces (return exported `XTabProps`) with explicit refresh ownership + dependency order (B.2 coordinator); PowerShell-safe `; if ($?)` chaining and `Measure-Object -Line` throughout.
- **Conformance net:** each domain has a runtime test binding the schema to its real producer, so any field I transcribed wrong fails loudly at that task rather than silently shipping.
- **Spec coverage:** Phase A replaces the mirrors; Phase B splits `App.tsx`/`styles.css`. Both halves of F16 present.
