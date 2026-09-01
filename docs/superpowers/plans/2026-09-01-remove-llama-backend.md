# Remove llama.cpp Backend (exl3-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per repo policy, dispatch tasks to `siftkit repo-agent` in batches of 1–3.

**Goal:** Snapshot the current codebase to a `llama_support` branch, then remove the llama.cpp backend and every live "llama" reference from `main`, leaving exl3 (TabbyAPI/exllamav3) as the only inference backend.

**Architecture:** Three waves. Wave 1 removes llama behavior (runtime, lifecycle, speculative metrics) while keeping shared names, so the tree stays green per task. Wave 2 is a mechanical rename of the shared wire-format/config vocabulary (`LlamaCpp*` → `Inference*`/`Engine*`) plus one new DB migration (v55). Wave 3 scrubs dashboard, scripts, docs, and adds a permanent guard test that fails on any reintroduced `llama` string.

**Tech Stack:** TypeScript (strict, zod-parsed IO), node test runner, SQLite migrations, React dashboard, PowerShell scripts.

---

## Locked decisions (user-approved 2026-09-01)

1. **Full scrub** — shared `LlamaCpp*` protocol types, `Runtime.LlamaCpp` config key, and `ManagedLlama*` schemas are renamed to neutral names. Zero `llama` strings remain in live code.
2. **DB: keep history + new migration** — historical migrations keep their `llama_*` strings (frozen history). One new migration (v55) renames live columns, deletes llama rows/presets, and drops `managed_llama_runs`.
3. **`Backend` field survives as `'exl3'`-only enum** — `InferenceBackendIdSchema = z.enum(['exl3'])`. Presets/DB rows stay shape-compatible; dual-backend *branching* is still deleted (the enum has one member, so branches collapse).

**Frozen-history policy (mirrors decision 2):** `src/state/migrations/**` and dated historical docs (`docs/superpowers/plans/*`, `docs/superpowers/specs/*`, dated `docs/*-2026-*.md` handoffs) may keep `llama` strings. Llama-*dedicated* docs are deleted (the `llama_support` branch preserves them). Living docs (setup guides, READMEs) are scrubbed. The guard test in Task 12 encodes exactly this allowlist.

---

## Global rename map (applies wherever the old name appears — src, tests, dashboard, scripts, bench)

Wire protocol (`src/llm-protocol/types.ts` and all consumers):

| Old | New |
|---|---|
| `LLAMA_CPP_PROTOCOL_FORMAT` | `INFERENCE_PROTOCOL_FORMAT` |
| `LlamaCppChatRole` | `InferenceChatRole` |
| `LlamaCppContentPart` | `InferenceContentPart` |
| `LlamaCppReasoningPart` | `InferenceReasoningPart` |
| `LlamaCppToolCall` | `InferenceToolCall` |
| `LlamaCppChatMessage` | `InferenceChatMessage` |
| `LlamaCppToolDefinition` / `LlamaCppToolDefinitionSchema` / `LlamaCppToolDefinitionsSchema` | `InferenceToolDefinition` / `InferenceToolDefinitionSchema` / `InferenceToolDefinitionsSchema` |
| `LlamaCppResponseFormat` | `InferenceResponseFormat` |
| `LlamaCppChatTemplateKwargs` | `InferenceChatTemplateKwargs` |
| `LlamaCppChatRequest` | `InferenceChatRequest` |
| `LlamaCppUsage` | `InferenceUsage` |
| `NormalizedLlamaCppChatResponse` | `NormalizedInferenceChatResponse` |
| `LlamaCppGenerateResult` | `InferenceGenerateResult` |
| `LlamaCppStructuredOutput` | `InferenceStructuredOutput` |
| `LlamaCppToolCallParser` | `InferenceToolCallParser` |
| `LlamaHttpError` | `InferenceHttpError` |
| `LlamaCppClient` (llm-protocol) | `InferenceClient` |
| `LlamaCppAssistantInference` | `AssistantInferenceClient` |
| `LlamaCppProviderStatus` | `InferenceProviderStatus` |
| `countLlamaCppTokens` / `countLlamaCppTokensDetailed` | `countInferenceTokens` / `countInferenceTokensDetailed` |
| `listLlamaCppModels` | `listInferenceModels` |
| `getLlamaCppProviderStatus` | `getInferenceProviderStatus` |
| `generateLlamaCppResponse` / `generateLlamaCppChatResponse` | `generateInferenceResponse` / `generateInferenceChatResponse` |
| `buildLlamaJsonSchemaResponseFormat` | `buildInferenceJsonSchemaResponseFormat` |
| `planTokenAwareLlamaCppChunks` | `planTokenAwareInferenceChunks` |
| `getLlamaCppChunkThresholdCharacters` | `getInferenceChunkThresholdCharacters` |
| `llamaCppMaxTokens` (summary/types, routes/operations) | `inferenceMaxTokens` |
| `llamaTokenCount` (repo-search) | `inferenceTokenCount` |
| `llamaPromptBudget` (summary/core-runner) | `inferencePromptBudget` |
| span `summary.llama.request` (+ `llama-cpp` trace sections in `scripts/profile-tool-loop-overhead.ts`) | `summary.inference.request` |

Config / runtime / server (contracts, `src/config/*`, status-server):

| Old | New |
|---|---|
| `Runtime.LlamaCpp` (SiftConfig key) | `Runtime.Engine` |
| `RuntimeLlamaCppConfig(Schema)` | `RuntimeEngineConfig(Schema)` |
| `RUNTIME_OWNED_LLAMA_CPP_KEYS` / `RuntimeOwnedLlamaCppKey` | `RUNTIME_OWNED_ENGINE_KEYS` / `RuntimeOwnedEngineKey` |
| `getRuntimeLlamaCpp` | `getRuntimeEngine` |
| `getConfiguredLlamaBaseUrl` / `getConfiguredLlamaNumCtx` | `getConfiguredEngineBaseUrl` / `getConfiguredEngineNumCtx` |
| `applyHostLlamaRuntimeSettings` / `resetHostLlamaSettingsCacheForTests` | `applyHostEngineRuntimeSettings` / `resetHostEngineSettingsCacheForTests` |
| `managesManagedLlamaLifecycle` | `managesManagedEngineLifecycle` (true when active preset is managed exl3) |
| `SIFT_DEFAULT_LLAMA_BASE_URL` / `_NUM_CTX` / `_MAX_TOKENS` / sampling defaults / `_REASONING_BUDGET(_MESSAGE)` / `_SLEEP_IDLE_SECONDS` | `SIFT_DEFAULT_ENGINE_*` (same values) |
| `SIFT_DEFAULT_LLAMA_MODEL` (gguf), `_BIND_HOST`, `_PORT`, `_GPU_LAYERS`, `_BATCH_SIZE`, `_UBATCH_SIZE`, `_CACHE_RAM`, `_KV_CACHE_QUANTIZATION` | **deleted** where llama-only (see field table below); `_CACHE_RAM` / `_KV_CACHE_QUANTIZATION` become `SIFT_DEFAULT_ENGINE_*` if exl3 consumes them (exl3 uses KV cache modes via `getExl3CacheModes`) |
| `ManagedLlamaSettingsShape/Schema` | `ModelPresetSettingsShape/Schema` |
| `ManagedLlamaKvCacheQuantization(Schema)` | `ModelKvCacheQuantization(Schema)` |
| `ManagedLlamaSettings` (type) | `ModelPresetSettings` |
| `ManagedLlamaStartupFailureSchema` (`packages/contracts/src/managed-llama-failure.ts`) | `ManagedEngineStartupFailureSchema` in `managed-engine-failure.ts` (drop llama-OOM-specific fields; keep what the tabby path reports) |
| `disableManagedLlamaStartup` / `--disable-managed-llama-startup` | `disableManagedEngineStartup` / `--disable-managed-engine-startup` |
| `wakeManagedLlamaForIncomingModelRequest` | `wakeManagedEngineForIncomingModelRequest` |
| `runtime_llama_launch_snapshot` (runtime KV key) | `runtime_engine_launch_snapshot` (old key deleted by migration; snapshot `LlamaCpp` field → `Engine`) |
| `server_llama_presets_json` / `server_llama_active_preset_id` (live columns) | `server_model_presets_json` / `server_model_active_preset_id` (migration v55) |
| `DEFAULT_LLAMA_MODEL` (config-store) | deleted; default preset comes from exl3 defaults (Task 5) |
| `getManagedLlamaLogRoot` → `.siftkit/logs/managed-llama` | `getManagedEngineLogRoot` → `.siftkit/logs/managed-engine` |
| `pruneManagedLlamaLogChunks` | `pruneManagedEngineLogChunks` |
| Route `POST /config/llama-cpp/test` / `LlamaCppConfigTestEndpoint` / dashboard `testLlamaCppBaseUrl` | `POST /config/engine/test` / `EngineConfigTestEndpoint` / `testEngineBaseUrl` |
| Routes `/dashboard/admin/managed-llama/runs[/:id]` / `ManagedLlamaRun*Endpoint` | `/dashboard/admin/managed-runs[/:id]` / `ManagedRun*Endpoint` |
| `stream_kind 'managed_llama'` (contracts benchmark.ts, schema-helpers, state/dashboard-benchmark) | `'managed_engine'` (new rows; old rows deleted by migration) |
| `SIFT_DEFAULT_LLAMA_PORT` env guard / `SIFTKIT_GUARD_LLAMA_PORT` (test-runner) | `SIFT_DEFAULT_ENGINE_PORT` guard / `SIFTKIT_GUARD_ENGINE_PORT` (guards the exl3/tabby port) |

**Deleted outright (no rename):** `ManagedLlamaSpeculativeType`, all `SpeculativeNgram*` / `SpeculativeMtp*` preset fields, `ManagedLlamaSpeculativeMetricsSnapshot` and all speculative-metrics plumbing, `allocateLlamaCppSlotId` and all `id_slot`/`cache_prompt` request options, `LLAMA_TOKENIZE_PATH` branch, OOM-diagnosis (`diagnoseManagedLlamaOom`, `buildGpuOomGuidance`), llama-only preset fields `ExecutablePath`, `BindHost`, `Port`, `GpuLayers`, `Threads`*, `NcpuMoe`, `FlashAttention`, `BatchSize`, `UBatchSize`, `VerboseLogging`* (*keep any field `preset-compatibility.ts` marks as exl3-supported — verify against `src/inference-presets/preset-compatibility.ts:82-180` before deleting each).

## File disposition — deletions

Source: `src/status-server/managed-llama.ts`, `managed-llama-runtime.ts`, `managed-llama-speculative-tracker.ts`, `llama-run-recorder.ts`, `src/inference-presets/llama-preset-adapter.ts`, `src/inference-presets/request-compatibility.ts` (collapses; fold surviving exl3 half into `preset-compatibility.ts`), `dashboard/src/managed-llama-restart.ts`.
Scripts: `scripts/verify-llama-live.ps1`, `scripts/stop-llama-server.ps1`, `scripts/benchmark-llamacpp-models.ps1`, `scripts/sweep-llamacpp-batch-ubatch.ps1`, `scripts/start-qwen35-9b-q8-200k-thinking-managed.ps1`, `scripts/benchmark-siftkit-spec-settings.ps1`, `bench/spec-settings.ts`.
Tests: `tests/llama-cpp.test.ts`, `tests/llama-cpp-client-thinking-budget.test.ts` (port surviving reasoning-budget assertions to a renamed client test first), all 8 `tests/managed-llama-*.test.ts`, `tests/providers-llama-cpp-local-usage.test.ts` (port to renamed provider), `tests/runtime-provider-llama.test.ts`, `tests/helpers/managed-llama-fixtures.ts`, `tests/chat-speculative-fallback.e2e.test.ts`, `tests/chat-oom-guidance.test.ts`, `tests/benchmark-spec-settings.test.ts`.
Docs/eval: `eval/llama-spec-prompt.txt`, `eval/benchmark-matrices/*.json` (gguf matrices), `eval/tmp/ai_core_60_case19/`, the 6 llama-dedicated `docs/superpowers/plans|specs/*llama*` files.
Renamed files: `src/llm-protocol/llama-cpp-client.ts` → `inference-client.ts`; `src/providers/llama-cpp.ts` → `src/providers/inference.ts`; `packages/contracts/src/managed-llama-failure.ts` → `managed-engine-failure.ts`.

---

### Task 1: Snapshot branch `llama_support`

**Files:** none (git only). Working tree must be clean on `main`.

- [ ] **Step 1:** Verify clean tree: `git status --porcelain` → empty output. If not empty, STOP and report.
- [ ] **Step 2:** `git branch llama_support` (snapshot of current `main` HEAD; do NOT switch — all work continues on `main`).
- [ ] **Step 3:** `git push -u origin llama_support`
- [ ] **Step 4:** Verify: `git branch -a --contains HEAD` lists both `main` and `llama_support`; `git rev-parse llama_support main` prints the same hash twice.

### Task 2: Collapse dual-backend runtime wiring; rename the startup flag

**Files:**
- Modify: `src/status-server/preset-runtime-coordinator.ts:34,360,425` — delete `Backend === 'llama' ? llamaRuntime : exl3Runtime` branches; coordinator holds only `exl3Runtime`. Remove `llamaRuntime` constructor param.
- Modify: `src/status-server/index.ts:59-96,141-142,215,221,252,297-347,380-483` — remove `ManagedLlamaRuntime`/`ManagedLlamaConfig`/lifecycle imports and construction, llama shutdown hooks, `pruneManagedLlamaLogChunks` call (keep the exl3/tabby equivalents). Rename option `disableManagedLlamaStartup` → `disableManagedEngineStartup` (it now gates managed-tabby startup — same test-isolation purpose).
- Modify: `src/status-server/main.ts:4,12,18,23,39` — flag `--disable-managed-llama-startup` → `--disable-managed-engine-startup`; drop llama shutdown hooks.
- Modify: `src/status-server/server-types.ts:77-159` — delete `ManagedLlamaState`, `EnsureManagedLlamaOptions`, `ShutdownManagedLlamaOptions`; remove llama fields from `ServerContext`; rename `disableManagedLlamaStartup` field.
- Modify: `src/status-server/server-ops.ts:71-72,333-341,613-614,638-641` — delete `wakeManagedLlamaForIncomingModelRequest` llama path (rename to `wakeManagedEngineForIncomingModelRequest`, delegating to the exl3 runtime via the coordinator); remove llama startup-state checks and llama flush enqueue.
- Modify: `src/status-server/routes/status-post.ts:34,322`, `src/status-server/routes/server-admin.ts:71,89-94,192-219,274-293`, `src/status-server/routes/chat.ts:33,131` — same renames; readiness endpoints consult the exl3 runtime only.
- Modify: all tests using `disableManagedLlamaStartup` (assistant-*, dashboard-*, etc. — mechanical): `disableManagedLlamaStartup` → `disableManagedEngineStartup`.

- [ ] **Step 1:** Make the edits above. Mechanical flag rename: `rg -l disableManagedLlamaStartup` then replace in each file.
- [ ] **Step 2:** `npm run typecheck` → PASS. `rg -n "ManagedLlamaRuntime|disableManagedLlamaStartup" src tests` → no matches.
- [ ] **Step 3:** Run server-lifecycle-adjacent tests (e.g. `tests/assistant-routes.test.ts`, coordinator tests) → PASS.
- [ ] **Step 4:** Commit: `git commit -m "refactor: collapse runtime coordination to exl3-only, rename managed-startup flag"`

### Task 3: Delete the speculative-metrics subsystem

llama.cpp speculative-decode stats have no exl3 equivalent (tabby's draft-engagement signal in `managed-tabby.ts:325` is separate and stays).

**Files:**
- Delete: `src/status-server/managed-llama-speculative-tracker.ts`
- Modify (strip `managedLlamaSpeculativeSnapshot` / `ManagedLlamaSpeculativeMetricsSnapshot` fields and dead code paths): `src/status-server/inference-run-flush-queue.ts:14-16,43,242,297`, `inference-run-flush-worker.ts:8,15`, `status-run-registry.ts:2,22,39,79,93,112,154-155`, `terminal-metadata.ts:17,266-268`, `routes/chat.ts:491-513,805,820,909,1090,1164` (speculative-cursor policy), `routes/status-post.ts:38-40,336,419,447-449`, `chat-repo-operation-runner.ts:48-52,77,147-148,173-182,260,271-272` (also remove OOM diagnosis usage — full deletion lands in Task 4).
- Delete tests: `tests/chat-speculative-fallback.e2e.test.ts`, `tests/benchmark-spec-settings.test.ts`.
- Delete: `scripts/benchmark-siftkit-spec-settings.ps1`, `bench/spec-settings.ts`.

- [ ] **Step 1:** Delete files, strip fields, chase compile errors until `npm run typecheck` passes.
- [ ] **Step 2:** `rg -in "speculative" src/status-server src/state | rg -iv "tabby|draft"` → no llama speculative remnants (preset `Speculative*` fields go in Task 5).
- [ ] **Step 3:** Run flush-queue/run-registry/chat-route tests → PASS.
- [ ] **Step 4:** Commit: `git commit -m "refactor: remove llama speculative-metrics subsystem"`

### Task 4: Delete llama runtime core, adapter, and satellites

**Files:**
- Delete: `src/status-server/managed-llama.ts`, `managed-llama-runtime.ts` (already unreferenced after Tasks 2–3), `llama-run-recorder.ts`, `src/inference-presets/llama-preset-adapter.ts`.
- Modify: `src/status-server/inference-run-recorder.ts:22-23,75-77,95-96,104` — delete llama-behavior doc comments; `inference-run-log-storage-filter.ts` — if only the llama recorder consumed it, delete the file; if the tabby recorder uses it, remove the `llama_`/`ggml_` regexes.
- Modify: `src/status-server/file-picker.ts:107-114` — delete `managed-llama-executable` / `managed-llama-model` picker targets; `packages/contracts/src/system.ts:20-21` — remove those target literals (contracts schema edit is safe here: removal only).
- Modify: `src/status-server/paths.ts:38-39` — `getManagedLlamaLogRoot` → `getManagedEngineLogRoot`, dir `managed-llama` → `managed-engine`.
- Modify: `src/status-server/dashboard-benchmark-runner.ts:94,197-198,241,256` — `restartManagedLlama` → restart the active engine via the preset-runtime coordinator (`restartManagedEngine`).
- Modify: `src/status-server/dashboard-runs/run-records.ts:16` — remove legacy `'llama.cpp'` label collapse.
- Modify: `src/status-server/chat.ts:162,264,285-310,845,855` — remove `llama: { cachePrompt }` request option and `allocateLlamaCppSlotId` usage; `getActiveServerLlamaPreset` → `getActiveServerModelPreset`.
- Delete tests: `tests/managed-llama-args.test.ts`, `managed-llama-blank-startup.test.ts`, `managed-llama-config-backend-guard.test.ts`, `managed-llama-exl3-shared-port.test.ts`, `managed-llama-launch-snapshot.test.ts`, `managed-llama-lifecycle-gate.test.ts`, `managed-llama-process-exit-sync-guard.test.ts`, `managed-llama-resolver.test.ts`, `managed-llama-startup-failure.test.ts`, `tests/helpers/managed-llama-fixtures.ts`, `tests/runtime-provider-llama.test.ts`, `tests/chat-oom-guidance.test.ts`.

- [ ] **Step 1:** Delete/modify per list; chase compile errors. Any *other* file that imports a deleted symbol: delete the llama path there too (fail-loudly rule — no stubs).
- [ ] **Step 2:** `npm run typecheck` → PASS. `rg -n "managed-llama|ManagedLlama" src` → only preset-schema names remain (renamed in Task 5).
- [ ] **Step 3:** Run status-server + chat test files → PASS.
- [ ] **Step 4:** Commit: `git commit -m "refactor: delete llama.cpp managed runtime and adapter"`

### Task 5: Contracts + config scrub (atomic rename wave — green only at task end)

**Files:**
- Modify: `packages/contracts/src/config.ts` — `InferenceBackendIdSchema = z.enum(['exl3'])` (`:26`); delete `ManagedLlamaSpeculativeTypeSchema` (`:10`); rename `ManagedLlamaKvCacheQuantizationSchema` → `ModelKvCacheQuantizationSchema` (`:5`); `RuntimeLlamaCppConfigSchema` → `RuntimeEngineConfigSchema` (`:56`, drop llama-only keys); `ManagedLlamaSettingsShape/Schema` → `ModelPresetSettingsShape/Schema` (`:68-104`), deleting llama-only fields per the "Deleted outright" list (cross-check each against `preset-compatibility.ts:82-180`); root `Runtime: { Engine: RuntimeEngineConfigSchema }` (`:321`).
- Rename: `packages/contracts/src/managed-llama-failure.ts` → `managed-engine-failure.ts` with `ManagedEngineStartupFailureSchema`; update `packages/contracts/src/index.ts:10`.
- Modify: `packages/contracts/src/benchmark.ts:11` — `'managed_llama'` → `'managed_engine'`.
- Modify: `src/config/constants.ts`, `types.ts`, `getters.ts`, `host-sync.ts`, `overrides.ts`, `effective.ts`, `index.ts` — apply the config rename table; delete llama-only default constants.
- Modify: `src/config/defaults.ts:104-170` — replace the default llama preset with a default exl3 preset:

```ts
// defaults.ts — default preset construction (replaces the llama block at :104-152)
const defaultPreset: ModelPresetSettings = {
  Backend: 'exl3',
  Model: '', // user must select a model before first launch; server surfaces a config-required error
  NumCtx: SIFT_DEFAULT_ENGINE_NUM_CTX,
  MaxTokens: SIFT_DEFAULT_ENGINE_MAX_TOKENS,
  // ...remaining exl3-supported fields from ModelPresetSettingsShape with SIFT_DEFAULT_ENGINE_* values
};
// Runtime block at :170 becomes: Runtime: { Engine: {} }
```

- Modify: `src/status-server/config-store.ts` — column names → `server_model_presets_json` / `server_model_active_preset_id` (`:68-69,144-147,182-183,234-235,266-267`); delete `DEFAULT_LLAMA_MODEL :39`; snapshot writer emits `Engine` (`:326-348`); update re-exports `:377-388`.
- Modify: `src/status-server/runtime-launch-snapshot.ts` — key `runtime_engine_launch_snapshot`, field `Engine: RuntimeEngineConfig`.
- Modify: `src/inference-presets/preset-compatibility.ts` — delete the llama column of the field matrix and llama-only field entries; rename `getExl3CacheModes` param type. Fold `request-compatibility.ts` exl3 half in; delete that file.
- Modify: `src/status-server/chat-turn-telemetry.ts:3-4,19-22`, `src/status-server/routes/dashboard.ts:116` — renamed getters/preset lookups.
- Modify tests: `config-schema-contract.test.ts`, `config-normalization.test.ts`, `config-no-top-level-backend.test.ts`, `dashboard-managed-presets.test.ts`, `dashboard-managed-file-picker.test.ts`, `settings/preset` tests — rewrite llama fixtures as exl3 fixtures; assertions that *forbid* stale llama artifacts (e.g. `config-schema-contract.test.ts:30-173`) are updated to forbid the old names entirely (they become part of the scrub's regression net).

- [ ] **Step 1:** Rewrite contracts first, then chase compile errors outward through `src/config` → `status-server` → tests. No aliases, no re-exports of old names.
- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3:** Run config + contracts + preset test files → PASS.
- [ ] **Step 4:** `rg -n "LlamaCpp|ManagedLlama|SIFT_DEFAULT_LLAMA" src/config packages/contracts` → no matches.
- [ ] **Step 5:** Commit: `git commit -m "refactor: rename config/contracts vocabulary to engine/model-preset, exl3-only backend enum"`

### Task 6: DB migration v55

**Files:**
- Modify: `src/state/migrations/registry.ts` — append version 55 (history above stays byte-identical).
- Modify: `src/state/migrations/schema-helpers.ts:94,307` — fresh-install DDL: `CHECK (backend IN ('exl3'))`, stream kind `'managed_engine'`.
- Modify: `src/state/runtime-db.ts:44,52,113-114` — column-presence checks target the new names.
- Test: `tests/state-migrations-v55.test.ts` (new).

- [ ] **Step 1: Write the failing test** — seed a pre-v55 DB fixture containing: a llama preset + an exl3 preset in `server_llama_presets_json` with `server_llama_active_preset_id` pointing at the llama preset; a `managed_llama_runs` table with one row; runs rows with `backend='llama'` and `backend='exl3'`; a benchmark log row with `stream_kind='managed_llama'`; a `runtime_llama_launch_snapshot` KV entry. Assert post-migration: columns renamed; only the exl3 preset remains with llama-only fields stripped; active id points at the surviving exl3 preset (or NULL if none survived); `managed_llama_runs` gone; no `backend='llama'` rows; no `managed_llama` stream rows; old KV key gone.
- [ ] **Step 2:** Run it → FAIL (migration 55 not found).
- [ ] **Step 3: Implement migration 55:**

```ts
{
  version: 55,
  migrate: (db) => {
    db.exec(`ALTER TABLE app_config RENAME COLUMN server_llama_presets_json TO server_model_presets_json`);
    db.exec(`ALTER TABLE app_config RENAME COLUMN server_llama_active_preset_id TO server_model_active_preset_id`);
    db.exec(`DROP TABLE IF EXISTS managed_llama_runs`);
    // delete llama-backed run rows from each runs table (use actual table names from schema-helpers)
    db.exec(`DELETE FROM <runs_table> WHERE backend = 'llama'`);
    db.exec(`DELETE FROM <benchmark_log_table> WHERE stream_kind = 'managed_llama'`);
    db.exec(`DELETE FROM <runtime_kv_table> WHERE key = 'runtime_llama_launch_snapshot'`);
    // rewrite presets JSON: drop Backend!=='exl3' presets; strip llama-only fields; fix active id
    rewritePresetsJson(db); // parse with ModelPresetSettingsSchema.strip-unknown semantics, explicit not a shim
  },
}
```

  Old llama rows/tables carry a `llama_*` CHECK in their stored DDL on existing DBs; leave the constraint as-is (DB-internal text, not codebase — tightening would force full table rebuilds for zero behavior change).
- [ ] **Step 4:** Run the new test + full migrations test file → PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(db): migration v55 — rename preset columns, purge llama rows and tables"`

### Task 7: Repo-wide symbol renames (protocol + providers + consumers)

**Files:** every file matching the wire-protocol rename table — `src/llm-protocol/*`, `src/providers/*`, `src/agent-loop/*`, `src/assistant/inference/client.ts`, `src/summary/**`, `src/repo-search/**`, `src/planner-protocol/*`, `src/cli/*`, `src/install.ts`, `src/image-retention-policy.ts`, `src/line-read-guidance.ts`, `src/lib/http-client.ts`, `src/state/dashboard-benchmark.ts`, `src/status-server/routes/operations.ts:214`, `bench/repro/repro-fixture60-malformed-json.ts`, `scripts/approval-red-team/*.ts`, `scripts/profile-tool-loop-overhead.ts`, and all tests referencing these symbols.

- [ ] **Step 1:** Apply the wire-protocol rename table mechanically (one `rg -l '<Old>'` + replace pass per row, in table order). Type renames only — no file moves yet.
- [ ] **Step 2:** `npm run typecheck` → PASS after full pass; `rg -n "LlamaCpp|LlamaHttp" src tests bench scripts dashboard` → only file-path imports of `llama-cpp-client`/`llama-cpp` remain (moved in Task 8).
- [ ] **Step 3:** `npm run test 2>&1 | siftkit summary --question "Pass/fail, failing tests, root errors, file:line anchors."` → all pass.
- [ ] **Step 4:** Commit: `git commit -m "refactor: rename LlamaCpp* wire-protocol vocabulary to Inference*"`

### Task 8: File renames + boundary-test update

**Files:**
- Rename: `src/llm-protocol/llama-cpp-client.ts` → `src/llm-protocol/inference-client.ts` (`git mv`); class already renamed in Task 7.
- Rename: `src/providers/llama-cpp.ts` → `src/providers/inference.ts` (`git mv`).
- Rename tests: `tests/llama-cpp.test.ts` → `tests/providers-inference.test.ts`; `tests/llama-cpp-client-thinking-budget.test.ts` → `tests/inference-client-thinking-budget.test.ts`; `tests/providers-llama-cpp-local-usage.test.ts` → `tests/providers-inference-local-usage.test.ts` (keep test bodies — they cover the surviving shared client/provider; only names/fixtures change).
- Modify: all import paths; `tests/agent-loop-boundary.test.ts:11-48` — allowlist becomes `src/llm-protocol/inference-client.ts`; test title "inference HTTP request construction lives only in InferenceClient".

- [ ] **Step 1:** `git mv` the files; fix imports (`rg -l "llama-cpp"`).
- [ ] **Step 2:** `npm run typecheck` → PASS; boundary test → PASS.
- [ ] **Step 3:** `rg -in "llama" src/llm-protocol src/providers tests/agent-loop-boundary.test.ts` → no matches.
- [ ] **Step 4:** Commit: `git commit -m "refactor: rename llama-cpp client/provider files to inference"`

### Task 9: Delete residual llama-only request branches

**Files:**
- Modify: `src/llm-protocol/inference-backend.ts:33` — delete the `llama: { cachePrompt }` option block; exl3 options remain the only shape.
- Modify: `src/llm-protocol/inference-request-builder.ts:10-13` — delete `cache_prompt`/`id_slot` emission and the `backend === 'llama'` condition.
- Modify: `src/llm-protocol/image-attachments.ts:148-149` — remove the "images require exl3" backend gate (single backend: images always permitted; validation of attachment shape stays).
- Modify: `src/status-server/routes/inference-passthrough.ts:31-266` — delete `LLAMA_TOKENIZE_PATH` and llama branch; `EXL3_TOKENIZE_PATH` path only.
- Modify: delete `allocateLlamaCppSlotId` (`src/repo-search/engine/task-loop-support.ts:101-107`) and every call site (`summary/chunking.ts:212-216`, `cli/run-auto-approval-probe.ts`, `scripts/approval-red-team/runner.ts`, `repo-search/engine/task-loop.ts`) — slot IDs were llama.cpp parallel-slot routing; exl3/tabby requests carry no slot.
- Modify: `src/test-runner/run-tests.ts:8,53`, `src/test-runner/live-instance-guard.ts` — engine-port guard rename per table.
- Modify: comment-level scrub: `src/summary/chunking.ts:209` ("llama.cpp generate failed" error-match → renamed provider error text — update the thrown message in `providers/inference.ts` and the matcher together), `src/preset-system-prompt.ts:9`, `src/repo-search/engine/llm-approval-gate.ts:48`, `src/lib/provider-helpers.ts:2,253,286,312`, `src/assistant/domain/node-types.ts:44`, `src/preset-catalog.ts:67`, `src/summary/types.ts:12`.

- [ ] **Step 1:** Make edits; chase compile errors.
- [ ] **Step 2:** `npm run typecheck` → PASS; run summary/repo-search/passthrough test files → PASS.
- [ ] **Step 3:** `rg -in "llama|gguf" src bench` → zero matches outside `src/state/migrations/`.
- [ ] **Step 4:** Commit: `git commit -m "refactor: remove llama-only request branches, slots, and comments"`

### Task 10: Dashboard scrub

**Files:**
- Modify: `dashboard/src/types.ts:3-25` — renamed contract re-exports.
- Modify: `dashboard/src/api.ts:353-357` — `testEngineBaseUrl` → `POST /config/engine/test`; managed-runs endpoints → `/dashboard/admin/managed-runs`.
- Modify: `dashboard/src/settings-runtime.ts:19-34` — write `config.Runtime.Engine.*`; drop llama-only keys.
- Delete: `dashboard/src/managed-llama-restart.ts` (llama OOM modal) + its call sites.
- Modify: `dashboard/src/settings-draft-editor.ts:131-135,368`, `settings-action-groups.ts:90-94` — keep KV-cache-quantization action (renamed type); delete speculative-type action; delete llama+freeze guard.
- Modify: `dashboard/src/settings-sections.ts:117-160+` — delete llama-only field controls (executable path, bind host, port, threads, NcpuMoe, flash attention, batch/ubatch, ngram speculative, gguf labels); keep exl3 fields.
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx` — remove the backend toggle (`:171`; single backend), remote-llama URL detection (`:27-224`), MTP warnings, ngram helpers, gguf label.
- Modify: `dashboard/src/tabs/settings/ModelRuntimeResidencyPanel.tsx:100` — freeze message drops the llama mention.
- Modify tests: `dashboard/tests/model-preset-groups.test.ts`, `model-runtime-control-state.test.ts`, `model-preset-groups-component.test.tsx`, `use-inference-runtime-status.test.tsx` — exl3 fixtures; assertions that llama controls/labels are GONE replace the old llama assertions.

- [ ] **Step 1:** Update dashboard tests first to the exl3-only expectations → run → FAIL.
- [ ] **Step 2:** Make the source edits → dashboard tests PASS.
- [ ] **Step 3:** `npm run typecheck` (workspace-wide) → PASS; `rg -in "llama|gguf" dashboard` → no matches.
- [ ] **Step 4:** Commit: `git commit -m "refactor(dashboard): exl3-only settings UI, engine-named endpoints"`

### Task 11: Scripts, eval, docs, packaging cleanup

**Files:**
- Delete: the 7 scripts/bench files and eval artifacts listed in "File disposition".
- Delete: `docs/superpowers/plans/2026-07-20-llama-model-list-readiness.md`, `docs/superpowers/plans/2026-08-09-managed-llama-process-leak.md`, `docs/superpowers/specs/2026-04-19-managed-llama-acceptance-rate-design.md`, `docs/superpowers/specs/2026-05-18-managed-llama-preset-source-of-truth-design.md`, `docs/superpowers/specs/2026-07-20-llama-model-list-readiness-design.md`, `docs/superpowers/specs/2026-08-09-managed-llama-process-leak-design.md`.
- Leave untouched (frozen history): all other dated docs under `docs/superpowers/**`, `docs/analysis/**`, dated `docs/*-2026-*.md` handoffs, `docs/mockups/`.
- Modify (living docs): `docs/exl3-backend-setup.md:17,29`, `docs/exl3-backend-validation.md:30` — drop llama.cpp comparison lines or mark them "(historical: llama.cpp backend removed 2026-09, see branch `llama_support`)".
- Modify: `package.json:45` — delete `"verify:llama-live"` script.
- Modify: `SiftKit/SiftKit.psd1:30` — tag `'llama.cpp'` → `'exllamav3'`.
- Modify: `assistant/personalized_llm_assistant_interactive_mockup.html:1206` — mockup chip "Llama 3.1 8B" → an exl3-era model name (it's a model name in a mockup; change for the scrub).

- [ ] **Step 1:** Delete/modify per list.
- [ ] **Step 2:** `npm run typecheck && npm run lint` → PASS (script deletions can break lint globs — fix config if so).
- [ ] **Step 3:** Commit: `git commit -m "chore: remove llama scripts, eval fixtures, dedicated docs, and packaging refs"`

### Task 12: Guard test + full verification

**Files:**
- Create: `tests/no-llama-references.test.ts`

- [ ] **Step 1: Write the guard test** (fails loudly on any reintroduction):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'packages', 'dashboard/src', 'dashboard/tests', 'tests', 'scripts', 'bench', 'eval'];
const ALLOWED = [/^src[\\/]state[\\/]migrations[\\/]/u, /^tests[\\/]no-llama-references\.test\.ts$/u];
const PATTERN = /llama|gguf/iu;

const collect = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? collect(path) : [path];
  });

test('no llama references outside frozen migration history', () => {
  const offenders = ROOTS.flatMap((root) => collect(root))
    .map((path) => relative('.', path))
    .filter((path) => !ALLOWED.some((allowed) => allowed.test(path)))
    .filter((path) => PATTERN.test(readFileSync(path, 'utf8')) || PATTERN.test(path));
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2:** Run it → PASS (if it fails, the offender list IS the remaining punch list — fix each, no allowlist additions).
- [ ] **Step 3:** Full verification: `npm run typecheck && npm run lint` → PASS; `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."` → all pass.
- [ ] **Step 4:** Manual smoke: start the status server, confirm exl3 preset loads, chat round-trip works, dashboard settings render without llama controls, `/dashboard/admin/managed-runs` responds.
- [ ] **Step 5:** Commit: `git commit -m "test: guard against llama reference reintroduction; complete exl3-only migration"`

---

## Risks

- **Task 5/7 are wide atomic renames** — the tree is red mid-task; never pause a dispatch between their steps. If a repo-agent stalls mid-rename, finish that task directly rather than redispatching.
- **`defaults.ts` exl3 default preset with `Model: ''`** — verify the server surfaces a clear "configure a model" state instead of crash-looping (covered by config-normalization tests updated in Task 5).
- **Migration v55 runs against your live `~/.siftkit` DB** — it deletes llama presets/runs by design; the `llama_support` branch + the DB's prior state are the rollback. Consider backing up the SQLite file before first post-migration launch.
- **`preset-compatibility.ts` field dispositions** — the llama-only vs exl3 field split must be read from the code (`:82-180`), not assumed; a field wrongly deleted breaks exl3 presets loudly at zod-parse time (intended failure mode).
