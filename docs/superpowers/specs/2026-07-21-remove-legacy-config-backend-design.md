# Remove legacy top-level `config.Backend` dual-axis

Date: 2026-07-21
Status: approved design, pending implementation plan

## Problem

Two independent `Backend` axes coexist:

| | Top-level `config.Backend` | Per-preset `Backend` |
|---|---|---|
| Schema | `z.string()` (`packages/contracts/src/config.ts:146`) | `z.enum(['llama','exl3'])` (`packages/contracts/src/config.ts:84`) |
| Production value | **always `'llama.cpp'`** (default + dead `ollama→llama.cpp` remap) | real engine selector |
| Test value | `'mock'` / `'noop'` | `'llama'` / `'exl3'` |
| Purpose | provider-identity constant **+ two smuggled test seams** | actual inference engine |

`config.Backend` is legacy. In production it is a constant, redundant with `preset.Backend==='llama'`. Its only live role is to smuggle **two unrelated test seams** through one production config field:

1. **Managed-llama lifecycle disable** — tests set `='noop'` so a real status server won't spawn llama.
2. **Summary mock-provider route** — tests set `='mock'` to reach the mock summary provider.

Conflating these two into one always-constant production field is the smell. This cleanup un-conflates them onto explicit, already-existing first-class mechanisms and deletes the field.

## The third axis: summary provider identity (do NOT collapse)

There is a **third** `backend` concept, distinct from both axes above: the lowercase `backend: string` threaded through the summary pipeline. Its value domain is `'llama.cpp'` (the real, fully-capable provider) and `'mock'` (test double). It is **not** the engine axis, and it is load-bearing across 16 comparison sites:

- `src/summary/chunking.ts:194` — `shouldRetryWithSmallerChunks` returns false for non-`'llama.cpp'`
- `src/summary/core-runner.ts:185,190,198,206,273,283,379,386,429,560` — chunk threshold, planner prompt budget, planner activation threshold, top-level-llama-pass flag, reasoning override
- `src/summary/planner/mode.ts:1329` — planner handoff
- `src/summary/provider-invoke.ts:135` — `allowUnsupportedInput`
- `src/summary/request-runner.ts:289` — llama.cpp slot allocation

Both `src/command-output/analyzer.ts:174` and `src/status-server/eval.ts:89` pass their resolved `backend` straight into `summarizeRequest`, so they feed the same pipeline.

**Therefore this cleanup must preserve `'llama.cpp'` as the summary provider default.** Re-defaulting it to `getActiveInferenceBackend(config)` (`'llama'`/`'exl3'`) would silently flip every site above to the degraded branch — regressing chunking, planner handoff, slot allocation, prompt budgeting, and unsupported-input handling. Normalizing the summary provider axis onto the engine axis is a genuinely separate project (it requires deciding exl3 semantics per site) and is explicitly **out of scope**.

What this cleanup does instead: decouple the summary provider default from the deleted config field by making it an explicit named constant, and validate its two-value domain with a runtime schema.

## Non-goal / confirmed non-bug

`config.Backend` being always `'llama.cpp'` does **not** hide an exl3 behavioral divergence in the two checks that are being removed:

- Host-settings sync (`applyHostLlamaRuntimeSettings`) self-gates on `ExternalServerEnabled` (`src/config/host-sync.ts:30-31`), not on backend. It syncs generic terms (NumCtx, Reasoning, Model). Backend-agnostic.
- Oversized-input rejection only ever fired for `mock`, since production was always `'llama.cpp'`.

The remaining 16 `'llama.cpp'` comparisons stay exactly as they are.

## Design

### 1. Delete top-level `config.Backend`

- `packages/contracts/src/config.ts:146` — remove `Backend: z.string()` from the top-level config schema.
- `src/config/defaults.ts:77` — remove `Backend: 'llama.cpp'`.
- `src/config/normalization.ts:438-439` — remove the dead `ollama → llama.cpp` remap (ollama is gone).
- `src/status-server/config-store.ts:54,140,174` — remove the sqlite `backend` column: schema field, write, and read.
- `src/state/runtime-db.ts` — remove `backend TEXT NOT NULL` from the `app_config` DDL, bump `CURRENT_SCHEMA_VERSION` 31 → 32, and add a v32 migration that drops the column, mirroring the existing `ALTER TABLE app_config DROP COLUMN` pattern at line 721.

  A migration is **required**, not optional: runtime DBs are only auto-recreated when the file is corrupt (`/not a database|SQLITE_NOTADB/` at `src/state/runtime-db.ts:1194`). An existing DB keeps its `backend TEXT NOT NULL` column, so once the writer stops supplying a value the INSERT would fail the NOT NULL constraint.
- `src/status-server/routes/core.ts:244` — remove `'Backend'` from the `topLevelRequired` list in `isStrictConfigPayload`. Without this, a complete config payload stops qualifying as strict and is silently treated as a partial update, merging with stale stored state.

### 2. Lifecycle gate collapses to one axis

`src/config/getters.ts:38-40`:

```ts
export function managesManagedLlamaLifecycle(config: SiftConfig): boolean {
  return getActiveInferenceBackend(config) === 'llama';
}
```

The `config.Backend === 'llama.cpp'` conjunct (always true in prod) is removed. The legacy-flag comment is deleted.

### 3. Lifecycle test-seam → existing `disableManagedLlamaStartup` flag

The ~5 tests that used `config.Backend='noop'` to keep a real status server from spawning llama switch to the purpose-built, already-existing flag:

- Production CLI arg `--disable-managed-llama-startup` (`src/status-server/index.ts:402`).
- `startStatusServer({ disableManagedLlamaStartup: true })` — already used by `tests/dashboard-status-server.run-logs.test.ts:183`.

Rejected alternatives:
- `ExternalServerEnabled:true` — **throws** on an unreachable URL (`src/status-server/managed-llama.ts:1170`), wrong for these quiet no-op tests.
- Active exl3 preset — introduces PresetRuntimeCoordinator side effects.

Affected tests (each passes `disableManagedLlamaStartup` through its real-server harness; verify no process spawns):
- `tests/runtime-status-server.lifecycle.test.ts` (4 sites)
- `tests/runtime-status-server.test.ts` (5 sites)
- `tests/execution-ownership.test.ts:19`

### 4. Summary provider axis → named constant + validated two-value domain

The summary pipeline's `backend` keeps its meaning and its values. Only its *source* changes: the default stops coming from the deleted config field and becomes an explicit constant.

- New runtime schema in `src/summary/types.ts`:

  ```ts
  export const SummaryProviderIdSchema = z.enum(['llama.cpp', 'mock']);
  export type SummaryProviderId = z.infer<typeof SummaryProviderIdSchema>;
  export const DEFAULT_SUMMARY_PROVIDER: SummaryProviderId = 'llama.cpp';
  ```

- `SummaryRequest.backend` and `EvalRequest.Backend` are typed `SummaryProviderId` (was `string`), inferred from the schema — no hand-written unions, no casts.
- Default when no override: `DEFAULT_SUMMARY_PROVIDER`, **not** the active engine.
- HTTP boundaries that accept a caller-supplied backend (`src/status-server/routes/core.ts:693`, the `--backend` CLI arg via `src/cli/run-eval.ts`) parse through `SummaryProviderIdSchema` and reject invalid values instead of passing arbitrary strings through.
- The 16 `backend === 'llama.cpp'` comparison sites are **unchanged**.

Behavioral rewrites (only the two checks that were genuinely mock-vs-real):

- `src/summary/request-runner.ts:198` — delete the `if (backend === 'llama.cpp')` guard; call `applyHostLlamaSettings` unconditionally (it self-gates on `ExternalServerEnabled`).
- `src/summary/request-runner.ts:77-79` (`isOversizedNonLlamaInput`, `!== 'llama.cpp'`) — becomes `backend === 'mock'` only; rename to `isOversizedMockInput`.
- `src/summary/provider-invoke.ts:96` (`=== 'mock'`) — unchanged.

### 5. Label and probe sites

Split by whether the value feeds the summary pipeline:

**Feeds `summarizeRequest` — must default to `DEFAULT_SUMMARY_PROVIDER`:**
- `src/status-server/eval.ts:72` — `request.Backend || DEFAULT_SUMMARY_PROVIDER` (flows to `summarizeRequest` at line 89).
- `src/command-output/analyzer.ts:114` — `request.backend || DEFAULT_SUMMARY_PROVIDER` (flows to `summarizeRequest` at line 174).

**Pure display DTOs — source from the active engine:**
- `src/install.ts:102`, `src/cli/run-test.ts:70` — DTO `Backend` label from `getActiveInferenceBackend(config)`.

**Provider probes — gate on the engine axis:**
- `src/cli/run-test.ts:38,46` and `src/install.ts:87` — replace `config.Backend === 'llama.cpp'` with `getActiveInferenceBackend(config) === 'llama'` (probe only when the active engine is managed-llama).

**Compile-forced deletion:**
- `src/repo-search/planner-protocol.ts:386` — sets the top-level `Backend` on a synthesized `SiftConfig`; delete the line.

**Explicitly unchanged:** the hardcoded run-log labels `backend: 'llama.cpp'` in `src/status-server/routes/core.ts:133,178` and `src/status-server/dashboard-runs/artifact-upserts.ts:326`. These do not read `config.Backend`, compile fine after removal, and threading the active engine into them requires unrelated `config` plumbing. Out of scope.

Output DTO schemas `Backend: z.string()` (`src/eval-types.ts:31`, `src/summary/types.ts:53`) stay string labels.

## Behavior preservation

Every production path resolved `config.Backend` to `'llama.cpp'`. Each rewrite keeps production identical:
- Lifecycle gate: prod active engine is `'llama'` → still true; exl3 → still false (unchanged).
- Summary: the provider default stays the literal `'llama.cpp'`, so all 16 comparison sites take the same branch as today. Prod never hit the mock route and never rejected oversized input → still true after the mock-only rewrite; host-settings still self-gate on `ExternalServerEnabled`.
- Display labels in `install`/`run-test` change from `'llama.cpp'` to `'llama'`/`'exl3'` — strictly more accurate, and no logic branches on them.

## Testing (TDD)

Each numbered change lands test-first where behavior changes; behavior-preserving refactors land behind characterization tests that are green before and after (labelled as such, not as red-green).

Required new tests:
- **Default summary provider** — assert that a summary run with no `backend` override resolves to `'llama.cpp'`, so the 16 comparison sites keep their branch. This is the regression guard for the highest-risk change; it must be written against the default path, not a path where a test explicitly passes `'llama.cpp'`.
- **Strict config payload** — assert a complete config payload still qualifies as strict (full replace, not partial merge) after `'Backend'` leaves `topLevelRequired`.
- **v31 → v32 persistence** — assert a seeded v31 DB migrates, drops the `backend` column, and reads back a valid config; and that a fresh DB is created at v32 without the column.
- **No top-level Backend** — assert the field is absent from the default config and stripped by normalization.

Updated tests:
- `tests/managed-llama-lifecycle-gate.test.ts` — assert the gate ignores any top-level `Backend` value (genuinely red before the gate change), then that it keys on the active engine.
- `tests/managed-llama-exl3-shared-port.test.ts`, `tests/managed-llama-process-exit-sync-guard.test.ts`, `tests/helpers/runtime-benchmark-repro.ts` — drop `config.Backend='llama.cpp'` setup (implied by an active llama preset).
- `tests/managed-llama-config-backend-guard.test.ts` — verified to touch only per-preset `Backend`; no change expected, confirm it still compiles.
- `tests/runtime-db-schema-v31.test.ts` — the `CURRENT_SCHEMA_VERSION === 31` assertion at line 31 must move to 32 (rename the file/tests to v32).
- All 16 test fixtures that set a top-level `Backend:` must drop it (see inventory).

Full suite must pass with production behavior unchanged.

## Consumer inventory (removal checklist)

Behavioral: `getters.ts:39`, `provider-invoke.ts:96`, `request-runner.ts:77/198`, `run-test.ts:38/46`, `install.ts:87`.
Summary-provider default (must stay `'llama.cpp'`): `eval.ts:72`, `analyzer.ts:114`, `request-runner.ts:195`.
Display label (active engine): `install.ts:102`, `run-test.ts:70`.
Compile-forced deletion: `planner-protocol.ts:386`.
Strict-payload gate: `core.ts:244` (`'Backend'` in `topLevelRequired`).
Persistence: `config-store.ts:54/140/174/224/257`; `runtime-db.ts:24` (version), `:120` (DDL), migration tail (~`:1142`).
Schema/default/normalize: `contracts/config.ts:146`, `defaults.ts:77`, `normalization.ts:438-439`.
Unchanged by design: `core.ts:133/178`, `artifact-upserts.ts:326` (hardcoded run-log labels), and the 16 `backend === 'llama.cpp'` summary comparison sites.

Test fixtures setting a top-level `Backend:` (all must drop it): `cli-http-boundary.test.ts:73,129`; `dashboard-managed-presets.test.ts:104`; `dashboard-presets.test.ts:34`; `helpers/runtime-config.ts:83`; `host-sync.test.ts:24`; `runtime-provider-llama.test.ts:32`; `runtime-results-db.test.ts:39,57`; `runtime-status-server.lifecycle.test.ts:179`; `runtime-summarize.test.ts:462,809`; `summary-cli.test.ts:33`; `_test-helpers.ts:111,294,350`. Fixtures using `Backend: 'mock'` that feed a summary run must instead pass `backend: 'mock'` on the request.

Test seams migrated: `runtime-status-server.lifecycle.test.ts`, `runtime-status-server.test.ts`, `execution-ownership.test.ts` (→ `disableManagedLlamaStartup`), `summary-status-server.test.ts:772` (`='mock'` → request override), plus `config.test.ts:275`.
