# Simplify Runtime Database Schema Implementation Plan

> **For implementation:** Use `superpowers:executing-plans` task by task. This request authorizes this plan only. Do not use SiftKit, create worktrees, commit, reset databases, or modify application code during planning.

**Goal:** Remove historical database compatibility machinery while preserving the current database and all current functionality.

**Execution update (2026-09-08):** The current code and a read-only check of `.siftkit/runtime.sqlite` both report v66. Implementation preserves v66 and rejects incompatible versions (including v65 and v67); the v65 references below describe the planning-time state. Per the user's execution instructions, work stays on `main`, without SiftKit, worktrees, or commits, with at most one Luna subagent active. Database validation uses a consistent SQLite backup and a separate copy; the live database is not opened through the new application code.

**Completed (2026-09-08):** All three tasks are implemented. A single Luna agent handled the core replacement; the primary agent completed restore, coverage transfer, store cleanup, review, and verification. Current DDL comparison checked 121 existing objects with no omissions or unexpected changes; the domain-owned operation-mode default is the intended difference. Copy validation preserved 69 tables, 71,935 rows, identities, and three nonempty FTS query results.

**Validation:** `npm run build:test`, `npm test` (3,487 passed, five skipped), `npm run test:dashboard` (399 passed), `npm run typecheck`, `npm run lint`, and `git diff --check` passed. The full suite initially found three raw-database fixtures, which were updated to normal initialization while preserving their assertions. The initial bootstrap RED build was blocked by obsolete migration-test imports; independent replay against the original implementation later demonstrated 13 failing schema regressions. Restore and store regressions were also observed failing before their corresponding changes. No live rollout or commit was performed.

**Cleanup exception:** Temporary verification files and database copies remain in `.scratch/runtime-schema`. Automatic approval review rejected both recursive and file-by-file deletion with only “blocked by policy”; cleanup could not be completed.

**Architecture:** Define the current runtime schema once, retain the existing assistant schema module, and use a small initializer with an explicit version check. Delete migration replay, version inference, historical data transformations, and store-local schema repairs. Backups restore only into the same current format.

**Tech stack:** Existing TypeScript, `better-sqlite3`, Zod, and Node test runner. No new dependencies, ORM, migration framework, or schema generator.

**Spec:** The design and acceptance criteria below are the specification; no separate document is needed.

## Verified local state

Read-only inspection on 2026-09-07 found:

- `.siftkit/runtime.sqlite` has `runtime_schema.version = 65`.
- `src/state/runtime-db.ts:40` defines `CURRENT_SCHEMA_VERSION = 65`.
- The database contains the current `server_model_presets_json`, `tool_call_status`, and `hold_json` columns.
- All three saved model presets have `IdleAction = "none"`; none uses the removed `freeze` action.

**The inspected local database is on the latest recorded schema. No reset or conversion is required by this plan.** These checks establish the version and selected recent fields, not a full integrity audit or the state of databases in other checkouts. No application initialization or migration was invoked during inspection.

## Scope and decisions

- Support empty databases and the current format only. Reject older, newer, malformed-version, and unversioned nonempty databases explicitly.
- Preserve the existing v65 marker and `runtime_schema` table. Renumbering to v1 or replacing the marker with `PRAGMA user_version` would introduce an unnecessary data transition.
- Preserve all current records, identities, timestamps, JSON snapshots, evidence references, and FTS mappings. Do not normalize or rewrite them during startup.
- Keep application tables, indexes, foreign keys, CHECK constraints, FTS tables, and assistant registry/owner/device seeding. Their presence in migration files does not make them obsolete.
- Keep `runtime_metadata`, retention, WAL configuration, handle caching, backup hashes, and key custody. They serve current behavior.
- Remove historical functions, constants, tests, and exceptions after their current-behavior coverage has been retained.
- Remove the automatic delete-and-recreate response to `SQLITE_NOTADB` in `getRuntimeDatabase`. An unreadable database must produce an error and remain available for diagnosis.
- Do not broaden this into a config-storage redesign, table renaming, general metrics normalization cleanup, assistant redesign, or deletion of historical planning documents.
- Future incompatible schema changes increment the single marker and require an explicitly scoped transition decision. Do not retain a speculative upgrade framework now.

The chosen approach is a current-schema bootstrap with no historical upgrades. Squashing the chain into one retained migration still keeps compatibility machinery. Replacing the database with a fresh file would unnecessarily discard current data. Neither is needed.

## Why the existing code is larger than necessary

| Evidence | Action |
| --- | --- |
| `src/state/migrations/registry.ts:45` contains 60 registered entries ending at v65. | Delete the registry and historical steps. |
| `src/state/migrations/schema-version-detection.ts:4` guesses old versions from column names. | Delete inference; trust only a validated current marker. |
| `src/state/runtime-db.ts:67`, `:270`, and migration helpers duplicate current DDL and repair it afterward. | Use current DDL directly, with one definition per object. |
| `src/state/migrations/schema-helpers.ts:60` adds chat columns; `:323` adds assistant fields after table creation. | Put final fields into their CREATE TABLE definitions. |
| `src/state/migrations/app-config-migrations.ts` and `exl3-migration.ts` transform retired formats and snapshots. | Delete both completely. |
| `src/status-server/dashboard-runs/table.ts:8`, `idle-summary.ts:386`, and `metrics.ts:299` create or repair schema inside consumers. | Move current DDL to the initializer; remove ALTER/probe paths and their callers. |
| `src/state/runtime-error-events.ts:27` repeats error-event DDL already defined elsewhere. | Keep one schema definition; error persistence only inserts rows. |
| `src/assistant/control/restore-service.ts:191` permits older backups, migrates snapshots, and copies column intersections. | Require current versions and matching columns; no snapshot upgrade or partial copy. |
| `src/assistant/storage/schema.ts:623` contains a historical FTS backfill. | Delete the backfill; retain current FTS tables, rowid fields, and normal write behavior. |

## Final ownership

| File | Responsibility |
| --- | --- |
| New `src/state/runtime-schema.ts` | Current non-assistant DDL and explicit `initializeRuntimeSchema(database)` composition. No registry, callbacks-as-steps, version inference, or historical SQL. |
| `src/assistant/storage/schema.ts` | Current assistant DDL, domain metadata/table lists, and existing `seedAssistantRegistries`. |
| `src/state/runtime-db.ts` | Paths, connection lifecycle, validated version read, current-only open/bootstrap, metadata access, and existing retention behavior. |
| `src/state/database-handle.ts` | Existing shared database handle type; unchanged. |
| `src/assistant/control/restore-service.ts` | Current-format validation and restore through existing transactional flow. |
| Existing stores and status-server modules | Current data access; no schema creation or column upgrades. |

Delete the entire `src/state/migrations/` directory. Delete `src/status-server/dashboard-runs/table.ts` once its DDL and optional-table guards have no callers. Do not replace either with a compatibility wrapper.

### Initialization contract

1. Open the selected file. Inspect its version and whether it contains application objects before executing persistent PRAGMAs or schema statements.
2. A genuinely empty database is initialized in one SQLite transaction: create current tables/indexes/FTS, seed assistant registries and local identity once, then insert the v65 marker. A failure rolls back both schema and seed writes; close the failed handle.
3. A nonempty database must have exactly the expected valid singleton version row. Reject a missing/invalid marker or any version other than 65 with the database path and expected/actual version. Do not infer, stamp, upgrade, reset, or delete it.
4. For an accepted current database, reuse the same current DDL with `CREATE ... IF NOT EXISTS`. This also initializes the currently lazy `run_logs` and `idle_summary_snapshots` tables if unused so far. Do not seed again or update existing records. Creation of absent current objects is the only initialization behavior; no ALTER, rebuild, or data backfill.
5. Preserve foreign-key enforcement, WAL, synchronous mode, and handle caching. Failed opens must not enter the cache.
6. Do not add a generic schema-diff or repair engine. A missing column or incompatible current table definition must surface through SQL/validated reads, never be patched on access. The version marker is a format contract, not an integrity certificate.

`getSchemaVersion(database)` remains a validated, read-only accessor for initialized databases. It must stop creating `runtime_schema`. Empty-database classification belongs to the opener. Parse database rows with Zod and infer types; handle absent rows explicitly.

## Task 1: Make backup restore current-format only

**Modify:** `src/assistant/control/restore-service.ts`, `src/state/runtime-db.ts`, `tests/assistant-backup-restore.test.ts`.

**Interfaces:** Preserve preview/confirm responses and the `schemaVersion` manifest field. Remove `migrateDatabaseFile` and its only production caller; introduce no replacement migration API.

- [x] Add failing restore regression cases: manifest version 64 and 66 are rejected; a manifest marked 65 with a snapshot marked 64 is rejected; missing snapshot marker or a missing assistant table/column is rejected; all failures preserve target rows, blob files, and custody state.
- [x] Retain the successful current backup round trip, wrong-token, hash-verification, and FTS/search coverage. When testing a modified snapshot, recompute its manifest hash so schema validation is actually reached.
- [x] Run `npm run build:test`, then `npm test -- assistant-backup-restore`; verify failures specifically reach the newly required rejection behavior.
- [x] Change the manifest check from `>` to `!== CURRENT_SCHEMA_VERSION`. After extraction, open the snapshot with `{ readonly: true, fileMustExist: true }`, validate its own marker, and close it. Do not configure or initialize the snapshot.
- [x] Before deleting target rows, validate that every copied assistant table exists and that source and target column sets match. Keep explicit named-column copying; remove intersection/filter behavior and the zero-columns early return. Preserve FTS rowid relationships and existing FK-safe copy ordering.
- [x] Delete `migrateDatabaseFile` from `runtime-db.ts`. Leave backup/export version publication and archive contracts intact.
- [x] Rebuild and run `npm test -- assistant-backup-restore assistant-export`. Confirm current round trips succeed and rejected snapshots do not touch target data.

**Acceptance:** Restore has no upgrade path, no partial-column compatibility, and no mutation of an incompatible snapshot or target.

## Task 2: Replace migration replay with current schema initialization

**Create:** `src/state/runtime-schema.ts`, `tests/runtime-db-schema.test.ts`.

**Modify:** `src/state/runtime-db.ts`, `src/assistant/storage/schema.ts`; current-behavior tests identified below.

**Delete:** All eight files in `src/state/migrations/`; `tests/runtime-db-migration-registry.test.ts`; historical-only fixtures/tests after coverage transfer.

**Interfaces:** Keep `getRuntimeDatabase`, `closeRuntimeDatabase`, `getSchemaVersion`, `CURRENT_SCHEMA_VERSION`, and `RuntimeDatabase`. Add only `initializeRuntimeSchema(database: RuntimeDatabase): void`; it creates current objects and does not own version checks or seed timing.

- [x] Add failing bootstrap tests for unversioned nonempty, v64, v66, malformed markers, and unreadable files. Assert failed opens preserve file contents and sentinel data. Test that the version accessor performs no writes.
- [x] Add a bootstrap rollback test using Node's test mock API to make `SystemClock.prototype.nowUtc` from `src/assistant/clock.ts` throw during seeding. Restore the mock in `finally`; inspect the failed file with a raw read-only SQLite handle. Assert no partial schema/seed rows or current marker survive. Do not add a production injection interface.
- [x] Add success tests for fresh creation, current reopen with unchanged rows/identity, and complete bootstrap-owned tables. Task 3 extends this to the remaining lazy tables. Reuse `createManagedTempDir`; close handles in `finally`.

Example test to add to `tests/runtime-db-schema.test.ts`:

```ts
test('opening a current database preserves stored values and device identity', () => {
  const dbPath = join(createManagedTempDir('siftkit-current-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    const ValueRow = z.object({ value: z.string() });
    const before = ValueRow.parse(database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.local_device_id'",
    ).get());
    database.prepare(
      'INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)',
    ).run('schema-test.sentinel', 'preserve-exactly', '2026-09-07T00:00:00.000Z');
    closeRuntimeDatabase();

    const reopened = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(reopened), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(ValueRow.parse(reopened.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.local_device_id'",
    ).get()), before);
    assert.equal(ValueRow.parse(reopened.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema-test.sentinel'",
    ).get()).value, 'preserve-exactly');
  } finally {
    closeRuntimeDatabase();
  }
});
```

- [x] Run the focused tests and confirm the new failure cases expose current migration/reset behavior before replacing it.
- [x] Move final DDL out of `applyBaseSchema` and `schema-helpers.ts` into `runtime-schema.ts`, removing duplicate definitions. Move inference/benchmark DDL intact. Fold `assistant_json`, chat `images`/`image_meta`/`removed_image_count`, and assistant `user_demoted` into their actual CREATE TABLE definitions. Preserve existing `user_notes`, `hold_json`, FTS rowids, current token fields, and all current checks/indexes.
- [x] Compose the existing assistant SQL blocks directly. Keep `seedAssistantRegistries` and invoke it only during new-database initialization, with the existing clock/device-ID dependencies. Delete `backfillAssistantFtsRowids` and historical migration comments.
- [x] Remove the hardcoded migration copy of operation-mode defaults. Source the SQL default from `getDefaultOperationModeAllowedTools()` in `src/presets.ts`, serializing it with correct SQL string quoting. Keep config defaults owned by the existing domain function.
- [x] Implement the initialization contract above. Delete registry iteration, version detection, FK-disable/rebuild machinery, redundant ensure helpers, obsolete-table DROP statements, and corruption-triggered removal of the DB/WAL/SHM files.
- [x] Redirect the existing retention table-existence check to the existing `tableExists` in `src/status-server/dashboard-runs/table.ts` until Task 3 removes both. Do not create another helper or retain historical column-introspection code. Task 3 makes the currently lazy tables mandatory and removes their absence guards.
- [x] Transfer current behavior tests before deleting historical tests; use the coverage mapping below. Update imports so no code/test depends on deleted migration files.
- [x] Rebuild and run `npm test -- runtime-db-schema assistant-schema chat-sessions-db config-no-top-level-backend model-idle-action processed-input-metrics runtime-results-db`. All selected names must resolve to existing tests.

**Acceptance:** Empty/current databases work; incompatible/unreadable files fail without destructive recovery; current records are preserved; `src/state/migrations/` is gone; current schema contains no historical transformation SQL.

### Required test cleanup and coverage transfer

| Existing tests | Treatment |
| --- | --- |
| `tests/runtime-db-schema-v*.test.ts` | Move fresh/current column, backend constraint, and field-contract checks into `runtime-db-schema.test.ts`; delete old upgrade fixtures and version-named files. |
| `tests/assistant-migration.test.ts` | Rename to `assistant-schema.test.ts`; retain fresh tables, registry contents, seeding, uniqueness, jobs, nonce protection, FTS, and query-index assertions. Remove downgrade/replay/backfill tests. |
| `tests/model-idle-action-migration.test.ts` | Rename to `model-idle-action.test.ts`; retain current defaults and rejection of missing/invalid/removed actions. Delete old JSON conversion scenarios. |
| `tests/state-migrations-v63.test.ts`, `tests/token-accounting-backfill.test.ts` | Delete historical transformations. Retain current backend/stream constraints and token-accounting behavior in current schema/consumer tests. |
| `tests/chat-sessions-db.test.ts`, `tests/processed-input-metrics.test.ts`, `tests/config-no-top-level-backend.test.ts` | Remove downgrade-based sections, preserving current serialization, totals, defaults, and strict config rejection tests. |
| `tests/config-normalization.test.ts` | Replace its migration-constant dependency with the existing negative-input fixture mechanism. Keep rejection assertions. |
| `tests/helpers/app-config-migration-fixture.ts` | Delete after all historical callers are removed. |
| `tests/no-llama-references.test.ts` | Remove the blanket `src/state/migrations/` exemption and test that such a path no longer bypasses the audit. Preserve narrowly scoped invalid-input fixtures still used by current rejection tests. |

## Task 3: Remove schema ownership from stores

**Modify:** `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`, `src/state/runtime-error-events.ts`, `src/status-server/metrics.ts`, `src/status-server/idle-summary.ts`, `src/status-server/server-ops.ts`, and `src/status-server/dashboard-runs/{queries,artifact-upserts,deletion}.ts`.

**Delete:** `src/status-server/dashboard-runs/table.ts`, including its remaining table-existence helper.

**Tests:** `tests/runtime-db-schema.test.ts`, `tests/error-diagnostics.test.ts`, `tests/processed-input-metrics.test.ts`, `tests/dashboard-runs-partition.test.ts`, `tests/runtime-history-prune.test.ts`, `tests/runtime-status-server.idle-summary.test.ts`.

- [x] Add failing tests asserting `run_logs` and `idle_summary_snapshots` exist immediately after opening a fresh runtime DB, without first calling a store. Check their current columns and indexes. Retain real store read/write tests to prove consumers work with this schema.
- [x] Add a regression that removes a current required column in an isolated DB and verifies the relevant consumer errors instead of repairing it. Test error recording on a current DB and failure on an uninitialized DB; error insertion must not silently create its own schema.
- [x] Run the targeted tests and record the intended failures.
- [x] Move current run-log and idle-summary DDL into `runtime-schema.ts`. Keep error-event DDL only there. Delete `ensureRunLogsTable`, `ensureIdleSummarySnapshotsTable`, `ensureRuntimeErrorEventsTable`, timing-column ALTER lists, schema-probe row schemas used only by these functions, and all ensure calls.
- [x] Remove `tableExists` guards for canonical tables in retention/deletion; absent required tables must produce SQL errors. Keep unrelated checks for optional files/artifacts and ordinary row-not-found behavior.
- [x] Update tests using raw `new Database(...)` plus a removed ensure function to open a normal initialized runtime DB. For tests intentionally exercising invalid databases, keep raw construction and assert the failure.
- [x] Rebuild and run `npm test -- runtime-db-schema error-diagnostics processed-input-metrics dashboard-runs-partition dashboard-runs-controller-e2e runtime-history-prune runtime-status-server.idle-summary`.

**Acceptance:** One schema initialization path owns all current DDL. Stores issue queries/writes only; no ALTER-on-read, lazy ensure wrappers, or suppressed schema-repair errors remain.

## Final validation and delivery

- [x] Recheck the user's selected DB version read-only before any eventual rollout. If it differs from v65, report the mismatch and stop that rollout without changing the data. Do not resurrect compatibility code.
- [x] Before opening real user data with the new implementation, make a consistent SQLite backup using the existing backup API; do not copy a live WAL database as a lone file. Keep it outside the active runtime path. Validate the new implementation against a copy first, comparing current records, identities, and FTS results.
- [x] Run `npm run build:test`, the focused suites above, then `npm test`, `npm run test:dashboard`, `npm run typecheck`, and `npm run lint`. Report pre-existing failures separately; never weaken valid tests to finish the cleanup.
- [x] Search active source/tests for `MIGRATIONS`, `detectEffectiveSchemaVersion`, `migrateDatabaseFile`, `backfillAssistantFtsRowids`, imports from `state/migrations`, the removed ensure functions, and `ALTER TABLE`. Expected: no production historical upgrades or store repairs; ALTER may remain in isolated negative-test setup only.
- [x] Review current DDL ownership: each table/index is defined once across `runtime-schema.ts` and `assistant/storage/schema.ts`. No migration directory, historical fixtures, compatibility wrappers, database reset path, or temporary helper remains.
- [x] Review the final diff independently against the acceptance criteria; preserve unrelated changes; do not commit unless requested.
- [ ] Remove scratch artifacts from `.scratch/runtime-schema`: blocked by automatic approval review as recorded above.

**Risks to verify:** Omitted final columns currently supplied by helpers; dropped current assertions hidden in version-named tests; raw-database tests bypassing initialization; restore column/FTS mapping regressions. Current user data must remain intact. Removing support for old database/backup formats is intentional.

**Planning validation:** Repository inspection and local database reads only. No implementation, application initialization, migrations, or test suites were run to create this plan.
