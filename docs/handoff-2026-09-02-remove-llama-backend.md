> Historical handoff, superseded by [the completed main integration](handoff-2026-09-04-exl3-main-integration.md). The unfinished tasks and operational directions below describe the earlier session only.

# Handoff: remove llama.cpp backend (plan `docs/superpowers/plans/2026-09-01-remove-llama-backend.md`)

Date: 2026-09-02. Worktree: `.worktrees/remove-llama-backend`, branch `remove-llama-backend`, base `990e1880`.
Constraints in force: no SiftKit, no subagents, CLAUDE.md rules (no `any`/assertions/non-null, TDD, typecheck + lint green, no shims/compat paths). Scratch dir `C:\tmp\rsx` (delete at completion). Main checkout is dirty with the user's unrelated WIP and must not be touched.

## Commits so far

| Commit | Plan tasks | State |
| --- | --- | --- |
| `d9480103` | Tasks 2–4 (runtime collapse, speculative metrics, llama runtime core) | done |
| `f809d9a3` | Task 5 (contracts + config scrub, exl3-only backend enum) | done, full suite 3303/3310 — only the two schema-version-55 asserts failed, owned by Task 6 |

## Current work: Task 6 (migration v57) — uncommitted

The plan numbers this "v55"; the registry was already at v56 on the base branch, so it is **v57**.

Implemented (uncommitted, typecheck + lint green):
- `src/state/migrations/app-config-migrations.ts`: `migrateRuntimeToExl3Only` + `toExl3Preset`, `EXL3_PRESET_KEYS`, `V57_KV_CACHE_QUANTIZATION_FALLBACK`. Renames `server_llama_presets_json/server_llama_active_preset_id` → `server_model_presets_json/server_model_active_preset_id` (guarded), rewrites presets JSON (drops presets with `Backend === 'llama'`, keeps every key in `ModelPresetFieldSchema.options` plus id/label/Backend, maps unsupported `KvCacheQuantization` → `f16`, fixes active id, NULL when nothing survives), deletes `run_logs`/`inference_runs` rows with `backend='llama'`, `benchmark_logs` rows with `stream_kind='managed_llama'`, and the `runtime_metadata` key `runtime_llama_launch_snapshot`.
- `src/state/migrations/registry.ts`: v57 entry appended; import added.
- `src/state/runtime-db.ts`: `CURRENT_SCHEMA_VERSION = 57`; fresh DDL uses the new column names. Legacy detection at line 52 intentionally still names the old column (history).
- `src/state/migrations/schema-helpers.ts`: fresh `inference_runs` CHECK is `('exl3')`; `benchmark_logs` stream kind `'managed_engine'`.
- `src/state/dashboard-benchmark.ts`: stream-kind enum/record key `managed_llama` → `managed_engine`.
- `src/status-server/config-store.ts`: all column names renamed.
- Tests updated: `assistant-migration` and `runtime-db-schema-v51` assert 57; `runtime-loadconfig`, `config-stale-preset-field`, `runtime-db-schema-v26` (post-migration reads + `KEPT_SERVER_COLUMNS`) use the new names; `model-idle-action-migration` got `downgradeAppConfigToV46()` (renames columns back + version 46 in both seeds) and `presetsJsonColumn()` for reads that run on both shapes.
- New TDD test `tests/state-migrations-v57.test.ts` (5 tests). Wrote it first, saw it fail, then implemented.

**Blocker being debugged when interrupted:** the v57 test's `seedV56Database` throws `SQLITE_ERROR` in the fixture itself (not in the migration). Probe of a leftover fixture DB (`%TEMP%\sk-v57-*`) showed `no such table: run_logs` — `writeConfig()` alone does not create `run_logs` (it is created lazily by `src/status-server/dashboard-runs/table.ts`). Fix: create `run_logs` in the seed (copy its DDL from `table.ts:10-48`, or call the dashboard-runs ensure function) before the inserts. Also `benchmark_sessions` insert and `runtime_metadata` insert were verified OK. After the fix rebuild (`npm run build:test`) and run:

```
node dist/test-runner/run-tests.js state-migrations-v57 model-idle-action-migration runtime-db-schema-v26 runtime-db-schema-v33 runtime-db-schema-v34 runtime-db-schema-v37 runtime-db-schema-v51 config-stale-preset-field runtime-loadconfig assistant-migration config-no-top-level-backend dashboard-benchmark config runtime-db
```

Other Task 6 failures seen in the last run (may resolve with the fixture fix, re-check):
- `runtime-db-schema-v26` "synthesizes a preset when presets json is empty" → 0 presets after v57: the v26-synthesized preset has no `Backend`; the drop rule was changed from `Backend !== 'exl3'` to `Backend === 'llama'` so Backend-less presets survive (matches `normalizeInferenceBackend`, which treats missing as exl3). Not yet re-run.
- `runtime-db-schema-v34` "drops the llama-shaped run tables" → `SQLITE_ERROR`, message not captured. That seed has only `runtime_schema` + `managed_llama_runs*`; suspect one of the v57 DELETE statements or `tableHasColumn` on a missing table. Reproduce with `node --test .test-build/tests/runtime-db-schema-v34.test.js` and print the error message (the reporter hides `SqliteError.message`; wrap `getRuntimeDatabase` temporarily).
- `managed_llama_runs` was already dropped by v34, so v57 does not drop it (deviation from plan text).

Then: `npm run typecheck` equivalents (see below), `npm run lint`, full suite, commit `feat(db): migration v57 — rename preset columns, purge llama rows and tables`.

## Remaining tasks (7–12) — per plan
- Task 7: repo-wide symbol renames (`LlamaCpp*` → `Inference*` incl. `install.ts`/`run-test.ts` result key `LlamaCppBaseUrl`, `getLlamaCppProviderStatus`, `countLlamaCppTokens`, `generateLlamaCppResponse`, `planTokenAwareLlamaCppChunks`, `LlamaCppAssistantInference`, etc.).
- Task 8: file renames (`src/llm-protocol/llama-cpp-client.ts` → `inference-client.ts`, `src/providers/llama-cpp.ts` → `providers/inference.ts`, test file renames, `agent-loop-boundary` allowlist).
- Task 9: residual llama request branches. Note much is already gone in Task 5: `cache_prompt`/`id_slot`/`timings_per_token` emission, `reasoning_content` kwarg, llama tokenize path in the request builder. Still present: `InferenceRequestInput.llama` option + `llama: { cachePrompt, slotId }` in `llama-cpp-client.ts:buildChatRequest`, `allocateLlamaCppSlotId` and `slotId` plumbing (task-loop, chunking, approval probe, red-team runner, `live-*` tests), `isExl3 ? '/v1/token/encode' : '/tokenize'` in `countTokens`, `EXL3_TOKENIZE_PATH`/llama branch in `inference-passthrough.ts`, "llama.cpp tokenize error" log text, stream `timings` parsing in the client (llama-only; tests already assume wall-clock duration), `TokenCountSource` is `'exl3' | 'estimate'` (tests updated to `(exl3)`).
- Task 10: dashboard scrub — `testLlamaCppBaseUrl` → `testEngineBaseUrl`, `POST /config/llama-cpp/test` → `/config/engine/test` (`server-admin.ts` `LlamaCppConfigTestEndpoint`), `/dashboard/admin/managed-llama/runs*` endpoints in `routes/dashboard.ts`, `settings-sections.ts` help texts (and `tests/settings-sections.test.ts` label list incl. GpuLayers/Bind host/Port), `ModelRuntimeResidencyPanel.tsx:100` wording, toast strings.
- Task 11: scripts/eval/docs/packaging cleanup.
- Task 12: guard test — pattern must exclude `exllamav3` (e.g. `/(?<!ex)llama|gguf/iu`); full verification + manual smoke.

## Test-infrastructure decisions made in Task 5 (keep consistent)
- Production default preset has `Model: null` (server starts degraded until a model is chosen). Tests therefore use `getDefaultServerConfig()` from `tests/helpers/mock-config.ts` (config-store default + `MOCK_MODEL_ID`), `mockModelPreset()` now defaults `Model` to `MOCK_MODEL_ID`, `mockSiftConfig` fills null `Model` per preset entry, and `configureDashboardTestEnv` seeds the default server config into the runtime DB.
- Stub servers: `withStubServer({ config: { Server: { ModelPresets: { Presets: [{ NumCtx }] } } } })` — partial presets are merged over the default preset by `withStubPresetDefaults` in `tests/_runtime-helpers.ts`. The `_test-helpers.ts` PUT handler no longer force-resets preset BaseUrl.
- Fake tokenizers serve `POST /v1/token/encode` with body `{ text }` and reply `{ count }`/`{ length }`; `tokenizeRequests[i].text` holds the text.
- `tests/helpers/runtime-config.ts` preset no longer pins `MaxTokens: 4096` (response reserve tests expect the 15 000 default).
- `llm-auto-approval` byte-preservation test sets `MaintainPerStepThinking: true` explicitly (a normalized default preset carries derived `false`s that stick when a fixture flips `Reasoning` on).

## Verification commands
```
npx tsc -b packages/contracts/tsconfig.json
npx tsc -p tsconfig.json --noEmit ; npx tsc -p tsconfig.scripts.json --noEmit ; npx tsc -p dashboard/tsconfig.json --noEmit
npx tsc -p tsconfig.bench.json --noEmit ; npx tsc -p tsconfig.test.json --noEmit ; npx tsc -p dashboard/tsconfig.test.json --noEmit ; npx tsc -p tsconfig.analysis.json --noEmit
npm run lint
npm run build:test && node dist/test-runner/run-tests.js <name...>      # full suite: no args, ~5 min, ~3310 tests
```
Do not edit `tests/` or `src/` while the full suite runs: the test-runner tests spawn the runner and fail with "Test artifacts are stale". If the runner hangs, kill it via `taskkill //PID <pid> //T //F` (find with `Get-CimInstance Win32_Process` filtering `*run-tests.js*`).

## Deviations to report at completion
Combined Wave A commit; deleted wake function; OOM guidance/startupFailure removed; obsolete llama tests deleted (idle-action freeze rejection, llama image refusal, slot/cache_prompt assertions, timings_per_token, repro-fixture60 non-llama guard); default `Model: null` (plan said `''`); KV enum narrowed to exl3 modes; migration number v57 (plan: v55); column rename done in Task 6 not Task 5; `managed_llama_runs` drop omitted (already dropped at v34); presets without `Backend` are kept, only explicit `llama` presets are dropped; bench repro llama guard removed; `Server.Exl3` unknown-field tests replaced the `Server.LlamaCpp` ones; main tree left untouched.
