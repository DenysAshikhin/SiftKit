# Operation Identity Run Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the original operation type, operation preset identity, and model-preset identity/configuration for every run so historical logs and comparison reports can distinguish exact execution conditions.

**Architecture:** Keep `run_kind` as the existing coarse dashboard grouping/projection, and add canonical run identity fields beside it. Capture the original `taskKind` before `executeRepoSearchRequest` normalizes it, resolve the operation/model presets at execution time, and persist their IDs plus validated JSON snapshots through the existing run-log upsert path. Existing rows are migrated only as far as their stored data allows; unrecoverable identities remain explicitly null or marked legacy.

**Tech Stack:** TypeScript, Zod schemas, SQLite via `better-sqlite3`, Node test runner, existing dashboard run contracts and migration registry.

**Spec:** Approved user request in this conversation; repository context: `docs/handoff-2026-08-31-runtime-time-token-analysis.md`.

## Verified Repository Baseline (2026-09-01)

Anchors confirmed before writing this plan. Implementers must not re-derive these; they must fail loudly if the anchors no longer hold.

- `run_logs` DDL lives in `src/status-server/dashboard-runs/table.ts` `ensureRunLogsTable` (lines 8-77), **not** in the migration registry. Existing-database column additions use a `PRAGMA table_info(run_logs)` introspection block at `table.ts:56-76`.
- `run_kind` has a SQL `CHECK` constraint at `table.ts:15` allowing exactly `summary_request | failed_request | request_abandoned | repo_search | chat | plan | unknown`. SQLite cannot alter a `CHECK` on an existing table, which is why the canonical field is additive.
- `RunRecord` is **not** defined in `dashboard-runs/types.ts`; that file only re-exports it (`types.ts:33`). The definition is `RunRecordSchema` at `packages/contracts/src/runs.ts:25-36`.
- The run-log INSERT/ON CONFLICT statement is `upsertRunLog` at `src/status-server/dashboard-runs/artifact-upserts.ts:65-141`.
- `upsertRepoSearchRun` (`artifact-upserts.ts:269-295`) already takes a collapsed `taskKind: 'plan' | 'repo-search' | 'chat'`.
- `executeRepoSearchRequest` (`src/repo-search/execute.ts:290`) computes `executionTaskKind` at line 293 and collapses `repo-agent` into `repo-search` at lines 295-299. Operation preset resolution is `PresetCatalog.fromPresets(config.Presets).requireById(request.presetId)` at `execute.ts:372`. Run persistence is deferred through `scheduleRepoSearchRunPersistence` (`execute.ts:204-228`, upsert at line 216), completed at 520-546 and failed at 637-661.
- `RepoSearchExecutionRequest` (`src/repo-search/types.ts:155-186`) has `presetId`, `taskKind`, and `model?: string` - **there is no `modelPresetId` or model-preset snapshot field today**. It must be added.
- `ChatSession` already carries `modelPresetId: string` and `modelPreset: ModelRuntimePreset` (`src/state/chat-sessions.ts:41-43`). `preset-runner.ts:200-201` already builds an ephemeral session with both.
- Migration registry maximum version is **54** (`src/state/migrations/registry.ts:645`), and `CURRENT_SCHEMA_VERSION = 54` at `src/state/runtime-db.ts:33`. Version 53 is an unrelated `chat_messages` column rename, so `tests/runtime-db-schema-v53.test.ts` is **not** the test file for this work.
- Migrations execute at database open (`src/state/runtime-db.ts:352-358`), which is **before** any lazy `ensureRunLogsTable` call from `queries.ts`. The v38 precedent (`migrateRunLogsBackendToEngineIds`, `app-config-migrations.ts:267-276`) only touched a pre-existing column, so it never hit this ordering problem.
- Summary artifacts do not reach `run_logs` in-process. They cross an HTTP boundary: `src/summary/request-runner.ts` builds them, then `notifySummaryTerminalStatus` sends them via `src/config/status-backend.ts:364-373` (`body.deferredArtifacts`), received by `src/status-server/routes/status-post.ts:587` `enqueueDeferredArtifacts` (plus a direct call at line 261), drained by `src/status-server/server-ops.ts:98-112` `persistDeferredArtifact`, which calls `upsertRunArtifactPayload` (`artifact-upserts.ts:173-267`).
- Engine request construction sites (all eight must supply identity): `chat-repo-operation-runner.ts:152`, `preset-runner.ts:210`, `preset-runner.ts:239`, `routes/chat-image-caption.ts:120`, `routes/chat.ts:831`, `routes/chat.ts:1117`, `routes/repo-search.ts:100`, and `routes/repo-agent.ts:120-139` (stored request, later spread at `repo-agent-sessions.ts:335`).
- Summary construction sites: `preset-runner.ts:161` and `routes/operations.ts:199`.

## Global Constraints

- Preserve unrelated working-tree changes and do not commit unless explicitly requested.
- Keep TypeScript inferred end-to-end; parse persisted JSON through runtime schemas and do not use `any`, type assertions, or non-null assertions.
- Preserve existing `run_kind` query/delete/dashboard semantics; canonical operation identity is additive.
- Do not widen the `run_kind` SQL `CHECK` constraint and do not add a SQL `CHECK` to the new `operation_type` column. Legacy rows would violate it and SQLite does not validate added-column checks against existing rows; enforce the union in Zod at the parse boundary instead.
- SQLite columns are snake_case (`operation_type`, `operation_preset_id`, `model_preset_id`, `operation_preset_json`, `model_preset_json`); TypeScript row/record/upsert fields are camelCase (`operationType`, `operationPresetId`, `modelPresetId`, `operationPresetJson`, `modelPresetJson`). Every mapping layer must translate explicitly.
- Do not infer historical preset identities that are not present in existing logs.
- New runs must persist identity metadata before the run is exposed as complete or failed.
- Test success, failure, legacy-row, and preset-edit/delete boundaries.

---

### Task 1: Define canonical run identity and database fields

**Files:**
- Modify: `packages/contracts/src/runs.ts`
- Modify: `src/status-server/dashboard-runs/types.ts`
- Modify: `src/status-server/dashboard-runs/table.ts`
- Modify: `src/status-server/dashboard-runs/run-records.ts`
- Modify: `src/status-server/dashboard-runs/queries.ts`
- Modify: `src/status-server/dashboard-runs/artifact-upserts.ts` (`upsertRunLog` INSERT/ON CONFLICT column list)
- Test: `tests/dashboard-runs-partition.test.ts`
- Test: `tests/runtime-db-migration-registry.test.ts`

**Interfaces:**
- Consumes: existing `RunLogDbRowSchema` (`types.ts:35-63`), `RunLogUpsertRow` (`types.ts:67-100`), `RunRecordSchema` (`packages/contracts/src/runs.ts:25-36`), `ensureRunLogsTable`, `upsertRunLog`, and the dashboard SELECT constants (`queries.ts:21-47`, `queries.ts:49-81`).
- Produces: canonical `RunOperationType = 'summary' | 'repo-search' | 'repo-agent' | 'plan' | 'chat'`; nullable `operationPresetId`, `modelPresetId`, `operationPresetJson`, and `modelPresetJson` fields on database/upsert/record types; a legacy-row normalization rule that preserves null identity rather than guessing.

- [ ] **Step 1: Write failing schema and normalization tests**

  Add tests that create an in-memory `run_logs` table, insert a complete row containing `repo-agent`, both preset IDs, and both snapshots, then assert the normalized `RunRecord` returns all four identity values. Add a legacy-row case with only existing columns and assert its canonical identity fields are null. Add a migration assertion that an older database receives the new nullable columns without losing existing rows. Add an explicit assertion that a row whose `run_kind` is `failed_request`, `request_abandoned`, or `unknown` normalizes to `operationType === null`.

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run: `npm test -- dashboard-runs-partition runtime-db-migration-registry`

  Expected: FAIL because the new columns, schema fields, and normalized record fields do not yet exist.

- [ ] **Step 3: Add the canonical fields and schema parsing**

  Define `RunOperationTypeSchema` alongside the run contracts and extend `RunRecordSchema` in `packages/contracts/src/runs.ts`, plus `RunLogDbRowSchema` and `RunLogUpsertRow` in `dashboard-runs/types.ts`, with:

  ```ts
  operationType: RunOperationType | null;
  operationPresetId: string | null;
  modelPresetId: string | null;
  operationPresetJson: string | null;
  modelPresetJson: string | null;
  ```

  Because `RunRecord` is only re-exported from `dashboard-runs/types.ts:33`, the record-shape change belongs in `packages/contracts/src/runs.ts`. Parse stored snapshot text as validated JSON objects at the boundary used by run-detail consumers. Keep raw text in SQLite so snapshots remain lossless, and follow the existing `z.string().nullish()` convention used for the other JSON columns.

- [ ] **Step 4: Add nullable SQLite columns and migration-safe table setup**

  Add the five snake_case columns to the `CREATE TABLE` definition (`table.ts:11-47`) and extend the existing `PRAGMA table_info(run_logs)` block (`table.ts:56-76`) with matching `ALTER TABLE run_logs ADD COLUMN` guards for existing databases. Follow the established pattern exactly: no `NOT NULL`, no default, no `CHECK`. Extend `RUN_LOG_LIST_SELECT_COLUMNS` and `RUN_LOG_DETAIL_SELECT_COLUMNS` and both normalization functions in `run-records.ts` (`normalizeRunRecord` at 23-48 and `normalizeRunRecordFromDbRow` at 121-146). Do not add a new index in this change because the initial requirement is persistence and exact comparison, not dashboard filtering.

- [ ] **Step 5: Extend the run-log write statement**

  Extend `upsertRunLog` (`artifact-upserts.ts:65-141`) so the INSERT column list, bound parameters, and `ON CONFLICT ... DO UPDATE SET` clause all carry the five new fields. Without this the columns exist but nothing writes them, so this step must land in the same task as the schema.

- [ ] **Step 6: Run the focused tests and verify they pass**

  Run: `npm test -- dashboard-runs-partition runtime-db-migration-registry`

  Expected: PASS, including complete-row and legacy-row behavior.

- [ ] **Step 7: Review the self-contained schema change**

  Inspect the diff for only the listed contract, schema, query, normalization, write-statement, and test files. Confirm the `run_kind` `CHECK` constraint is byte-identical to its previous value. Do not commit unless the user explicitly requests a commit.

### Task 2: Preserve and persist identity on every execution path

**Files:**
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/execute.ts`
- Modify: `src/status-server/dashboard-runs/artifact-upserts.ts`
- Modify: `src/status-server/chat-repo-operation-runner.ts`
- Modify: `src/status-server/preset-runner.ts`
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/status-server/routes/repo-agent.ts`
- Modify: `src/status-server/routes/repo-search.ts`
- Modify: `src/status-server/routes/chat-image-caption.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/routes/operations.ts`
- Modify: `src/status-server/routes/status-post.ts`
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/config/status-backend.ts`
- Modify: `src/summary/artifacts.ts`
- Modify: `src/summary/request-runner.ts`
- Modify: `src/summary/core-runner.ts`
- Test: `tests/repo-search-agent-execute.test.ts`
- Test: `tests/repo-search-status-server.test.ts`
- Test: `tests/chat-repo-operation-runner.test.ts`
- Test: `tests/repo-search-logging.test.ts`

**Interfaces:**
- Consumes: `RepoSearchExecutionRequest.taskKind` / `.presetId`, `normalizeRepoSearchTaskKind` (`src/repo-search/task-kind.ts:14-18`), `ChatSession.modelPresetId` / `.modelPreset` (`src/state/chat-sessions.ts:41-43`), `PresetCatalog.requireById` (`src/preset-catalog.ts:142-148`), `ModelRuntimePresetSchema` (`packages/contracts/src/config.ts:107-111`), `upsertRepoSearchRun`, and `upsertRunArtifactPayload`.
- Produces: run-log upserts containing the original operation type, operation preset ID/snapshot, and model-preset ID/snapshot for repo-search, repo-agent, plan, chat, and summary flows.

- [ ] **Step 1: Write regression tests for the lost repo-agent identity**

  Add a repo-agent execution test that reads the persisted upsert payload and asserts `operationType === 'repo-agent'` while the legacy grouping remains `run_kind === 'repo_search'`. Add equivalent assertions for `repo-search`, `plan`, and `chat`; include both the completed persistence path (`execute.ts:520-546`) and the failed path (`execute.ts:637-661`). Persistence is deferred via `setImmediate` inside `scheduleRepoSearchRunPersistence`, so tests must await `awaitRepoSearchRunPersistence` (`execute.ts:200-202`) rather than asserting synchronously.

- [ ] **Step 2: Write preset identity tests**

  Exercise a request with an operation preset and model preset, then assert the persisted payload contains their IDs and snapshots. After mutating the in-memory configuration after request construction, assert the persisted snapshot still represents the configuration used by that request. Add a chat-session case proving a session model snapshot is recorded rather than replaced by the currently active global model preset.

- [ ] **Step 3: Run the focused tests and verify they fail**

  Run: `npm test -- repo-search-agent-execute repo-search-status-server chat-repo-operation-runner repo-search-logging`

  Expected: FAIL because repo-agent is currently collapsed to repo-search and the upsert payload has no preset identity fields.

- [ ] **Step 4: Add model-preset identity to the engine request contract**

  `RepoSearchExecutionRequest` currently exposes only `model?: string`. Add optional `modelPresetId?: string` and `modelPreset?: ModelRuntimePreset` fields (`src/repo-search/types.ts:155-186`) so callers can hand the engine the exact snapshot they used. Keep them optional so non-session callers stay valid, and keep `model` untouched.

- [ ] **Step 5: Preserve the original operation type before legacy normalization**

  In `executeRepoSearchRequest`, retain `executionTaskKind` (`execute.ts:293`) as the canonical `operationType` while the existing collapse at lines 295-299 continues to feed the legacy projection. Widen `upsertRepoSearchRun`'s options (`artifact-upserts.ts:269-295`) to accept both the collapsed `taskKind` and the canonical `operationType`. Do not widen the legacy `run_kind` check constraint to include `repo-agent`; the new canonical field owns that distinction.

- [ ] **Step 6: Resolve and validate operation/model preset snapshots**

  Reuse the preset already resolved at `execute.ts:372` for `operationPresetId` and its snapshot rather than resolving a second time. Resolve model identity from `request.modelPresetId` / `request.modelPreset` when present, and fall back to the active model preset only for non-session paths that carry no historical snapshot. Serialize snapshots only after parsing them with the existing preset schemas (`SiftPresetCollectionSchema`, `ModelRuntimePresetSchema`). If an identity cannot be resolved, persist a null field and a structured warning; do not silently label another preset as the one used.

- [ ] **Step 7: Thread explicit model-preset identity through every construction site**

  All eight engine-request construction sites must pass identity: `chat-repo-operation-runner.ts:152` (from `selected.session.modelPresetId` / `.modelPreset`, **not** the `getActiveModelPreset(effectiveConfig)` value at line 139, which exists only for image admission), `preset-runner.ts:210` (the ephemeral session already built at lines 200-201), `preset-runner.ts:239`, `routes/chat-image-caption.ts:120`, `routes/chat.ts:831`, `routes/chat.ts:1117`, `routes/repo-search.ts:100`, and `routes/repo-agent.ts:120-139`. Note that `repo-agent-sessions.ts` only spreads a stored `engineRequest` at line 335, so the repo-agent identity must be set where the request is built in `routes/repo-agent.ts`, and `RepoAgentEngineRequest` (`repo-agent-sessions.ts:63-66`) must keep carrying the new fields. Ensure the effective configuration used for inference and the metadata persisted for the run refer to the same snapshot.

- [ ] **Step 8: Extend summary artifacts across the status-post transport**

  Summary artifacts do not reach `run_logs` in-process. Add `operationType: 'summary'` plus preset metadata to `buildSummaryRequestArtifact` (`src/summary/artifacts.ts:188-230`) and its producers in `src/summary/request-runner.ts` (success short-circuit 387-404, model completion 439-461, failure 515/522-532), then carry the fields through `body.deferredArtifacts` (`src/config/status-backend.ts:364-373`), `enqueueDeferredArtifacts` (`routes/status-post.ts:587`, plus the direct `upsertRunArtifactPayload` call at line 261), `drainDeferredArtifacts` / `persistDeferredArtifact` (`server-ops.ts:98-155`), and finally `upsertRunArtifactPayload` (`artifact-upserts.ts:173-267`). Because the payload crosses an HTTP boundary, the transport schema must be extended and round-trip validated, not just the in-process type. Summary callers are `preset-runner.ts:161` and `routes/operations.ts:199`. Missing preset identities remain null when summary is invoked without an operation preset.

- [ ] **Step 9: Map non-operation artifact kinds to null**

  `upsertRunArtifactPayload` also handles `planner_debug`, `planner_failed`, and `request_abandoned`, which produce `run_kind` values of `failed_request` and `request_abandoned`. These have no canonical operation type. Persist `operation_type = NULL` for them explicitly rather than defaulting to any member of the union.

- [ ] **Step 10: Run the focused tests and verify they pass**

  Run: `npm test -- repo-search-agent-execute repo-search-status-server chat-repo-operation-runner repo-search-logging`

  Expected: PASS with repo-agent distinguished from repo-search and preset snapshots stable across later configuration edits.

- [ ] **Step 11: Review the execution-path change**

  Inspect the diff and confirm each of the eight engine-request sites and both summary sites supplies the canonical operation type and model-preset identity needed by its run. Do not commit unless the user explicitly requests a commit.

### Task 3: Migrate and expose historical identity safely

**Files:**
- Modify: `src/state/migrations/app-config-migrations.ts`
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/runtime-db.ts` (bump `CURRENT_SCHEMA_VERSION` from 54 to 55)
- Modify: `src/status-server/dashboard-runs/table.ts`
- Modify: `src/status-server/dashboard-runs/queries.ts`
- Modify: `src/status-server/dashboard-runs/run-records.ts`
- Create: `tests/runtime-db-schema-v55.test.ts`
- Test: `tests/runtime-db-migration-registry.test.ts`
- Test: `tests/dashboard-runs-controller-e2e.test.ts`

**Interfaces:**
- Consumes: new nullable columns and legacy `run_kind` values from Tasks 1-2.
- Produces: deterministic migration behavior and API/run-detail records that expose exact identity when available without fabricating historical preset data.

- [ ] **Step 1: Write migration tests for known and unknown history**

  Add a fixture with existing `run_kind` values and assert migration backfills only safe canonical values: `plan` to `plan`, `chat` to `chat`, `repo_search` to `repo-search` when no repo-agent evidence exists, and `summary_request` to `summary`. Assert `failed_request`, `request_abandoned`, and `unknown` rows remain `operation_type = NULL`. Assert `operationPresetId`, `modelPresetId`, and both snapshots remain null because old rows do not contain them. Add a fixture containing the handoff-era repo-agent evidence only outside `run_logs` and assert the migration does not claim it can reconstruct that evidence. Add a fixture that opens an existing v54 database that has never called `ensureRunLogsTable` in that process and assert migration completes without throwing.

- [ ] **Step 2: Run the migration tests and verify they fail**

  Run: `npm test -- runtime-db-schema-v55 runtime-db-migration-registry dashboard-runs-controller-e2e`

  Expected: FAIL until the new migration version and API field exposure are implemented.

- [ ] **Step 3: Resolve the DDL/migration ordering hazard before writing the backfill**

  Registry migrations run at database open (`src/state/runtime-db.ts:352-358`), while `run_logs` DDL is applied lazily by `ensureRunLogsTable` from `queries.ts`. A naive `UPDATE run_logs SET operation_type = ...` in migration 55 will therefore throw `no such table` or `no such column` on an existing database. The v38 precedent (`app-config-migrations.ts:267-276`) avoided this only because its column already existed. Choose and document one approach:

  - (a) have migration 55 call `ensureRunLogsTable` first so the columns exist before the update; or
  - (b) make the backfill idempotent and defensive by checking `sqlite_master` for the table and `PRAGMA table_info(run_logs)` for the column, no-opping otherwise, with `ensureRunLogsTable` performing the same backfill immediately after its `ADD COLUMN` block.

  Option (a) is preferred because it keeps a single backfill implementation. Whichever is chosen, a fresh database stamped directly at version 55 (`runtime-db.ts:335-348`) must reach the same end state.

- [ ] **Step 4: Add migration version 55 with explicit backfill rules**

  Register version 55 after the current maximum of 54 (`registry.ts:645`) and bump `CURRENT_SCHEMA_VERSION` to 55 (`runtime-db.ts:33`). Implement the backfill as a named function in `app-config-migrations.ts` following the `migrateRunLogsBackendToEngineIds` convention. Backfill only canonical operation types derivable from existing `run_kind`; leave repo-agent and all preset identities unknown unless stored data proves them. Document in the migration comment that auxiliary `.siftkit/repo-agent/runs` directories are not a durable migration source.

- [ ] **Step 5: Expose identity fields in list/detail records**

  Confirm the SELECT constants and both `run-records.ts` normalizers extended in Task 1 surface `operationType`, `operationPresetId`, `modelPresetId`, `operationPresetJson`, and `modelPresetJson` to API callers. Keep existing `kind`/`group` values unchanged so old dashboard filters and deletion behavior remain compatible, and keep `normalizeStatusForRunRecord` (`run-records.ts:111-119`) untouched.

- [ ] **Step 6: Add API compatibility assertions**

  Extend the dashboard controller E2E fixture and assert new fields are present as values for new rows and null for legacy rows. Assert existing grouping/filtering still returns repo-agent under the repo-search group while the detail record identifies it canonically as repo-agent.

- [ ] **Step 7: Run the migration and API tests and verify they pass**

  Run: `npm test -- runtime-db-schema-v55 runtime-db-migration-registry dashboard-runs-controller-e2e`

  Expected: PASS with deterministic legacy behavior and unchanged existing filters.

- [ ] **Step 8: Review the migration/API change**

  Inspect the diff and confirm legacy rows retain honest nulls, existing filters remain compatible, the schema version bump and registry entry agree, and no auxiliary run directory is treated as durable database history. Do not commit unless the user explicitly requests a commit.

### Task 4: Document exact-identity comparison

**Files:**
- Modify: `docs/handoff-2026-08-31-runtime-time-token-analysis.md`
- Create: `docs/runtime-run-comparison.md`

**Interfaces:**
- Consumes: canonical identity fields, token/timing fields, and transcript metrics from `run_logs`.
- Produces: documented grouping keys for future comparison reports and a clear statement of what can and cannot be compared for pre-migration rows.

- [ ] **Step 1: Document the canonical comparison key**

  Document this stable grouping tuple:

  ```text
  operationType
  operationPresetId + operationPresetJson
  modelPresetId + modelPresetJson
  model
  backend
  ```

  Explain that `run_kind` remains a coarse compatibility grouping, that pre-migration repo-agent rows cannot be identified from `run_logs` alone, that `failed_request` / `request_abandoned` / `unknown` rows have no canonical operation type by design, and that null identity means "not recorded," not "default preset." Record the schema version (55) at which identity capture begins so future analyses can state their own migration boundary.

- [ ] **Step 2: Update the existing handoff with the migration boundary**

  Add a short note to the handoff stating that future analyses can group directly by canonical operation identity, while the Aug 27-31 analysis still relies on reconstructed repo-agent evidence.

- [ ] **Step 3: Run focused and broad validation**

  Run:

  ```powershell
  npm test -- dashboard-runs-partition runtime-db-migration-registry repo-search-agent-execute chat-repo-operation-runner dashboard-runs-controller-e2e runtime-db-schema-v55
  npm run typecheck
  npm run lint
  npm test
  ```

  Expected: all focused tests, typecheck, lint, and the full test suite pass. If any command fails, report the failing test names and file:line diagnostics instead of treating the plan as complete.

- [ ] **Step 4: Review documentation changes**

  Inspect both documentation files for consistency with the persisted field names and confirm they state the pre-migration limitations. Do not commit unless the user explicitly requests a commit.

## Self-Review Checklist

- [ ] Verify every execution path writes the original operation type before legacy `run_kind` projection.
- [ ] Verify all eight engine-request construction sites and both summary sites supply identity.
- [ ] Verify chat runs use the session model-preset snapshot rather than the current global active preset.
- [ ] Verify summary identity survives the `deferredArtifacts` HTTP round trip, not just the in-process type.
- [ ] Verify migration 55 cannot throw on an existing database whose `run_logs` columns are added lazily.
- [ ] Verify `CURRENT_SCHEMA_VERSION` and the registry's maximum version agree at 55.
- [ ] Verify the `run_kind` SQL `CHECK` constraint is unchanged and no `CHECK` was added to `operation_type`.
- [ ] Verify old rows are not assigned invented preset IDs or snapshots, and that non-operation run kinds stay null.
- [ ] Verify dashboard grouping, deletion, and existing `kind` filters remain compatible.
- [ ] Verify the comparison key distinguishes operation preset edits and model preset edits.
- [ ] Verify no temporary analysis files remain in the repository after implementation.
