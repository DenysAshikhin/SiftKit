# Managed-llama preset as single source of truth

Date: 2026-05-18
Status: Approved (design)

## Problem

Managed llama.cpp settings (NumCtx, ModelPath, sampling, speculative
decoding, etc.) are stored in **three** denormalized places that
`applyActiveManagedLlamaPreset()` keeps bidirectionally in sync:

1. The active entry of `Server.LlamaCpp.Presets[]` (`server_llama_presets_json`).
2. The inline `Server.LlamaCpp.*` fields (~40 `server_*` columns in `app_config`).
3. `Runtime.LlamaCpp` (16 `llama_*` columns), the client-side view used for
   prompt-budget math.

The legacy top-level `LlamaCpp` and `Model` keys add a fourth shadow copy.

This duplication lets the copies drift. It also produced a misleading
diagnosis during a repo-search latency investigation: an orphaned
`~/.siftkit/config.json` (`NumCtx: 150000`) — a file nothing in the code
reads anymore — appeared to contradict the running server (`85000`), when
in fact `85000` was correct (it is the active preset `qwen3-6-27b-q4-thinking`).

The runtime config already lives in SQLite (`app_config`), served over the
`/config` HTTP endpoint. The remaining `.json` config handling is dead or
legacy-only code.

## Goal

The **active managed-llama preset** becomes the single stored source of
truth for managed llama settings. All legacy `.json` config handling is
removed from code, and stale `.json` config files are deleted from disk.

Out of scope: the separate top-level `Presets` array (`presets_json`,
`SiftPreset[]`) is left untouched.

## Approach

Reference model — the active preset is the only stored copy; the effective
managed config and the runtime view are resolved from it. No denormalized
`Server.LlamaCpp.*` fields, no bidirectional sync.

## Design

### 1. Type changes — `src/config/types.ts`

- Extract `ManagedLlamaSettings` = today's `ServerManagedLlamaCppConfig`
  minus `Presets` / `ActivePresetId`.
- `ServerManagedLlamaPreset = { id: string; label: string } & ManagedLlamaSettings`
  (shape unchanged).
- `Server.LlamaCpp` becomes `{ Presets: ServerManagedLlamaPreset[]; ActivePresetId: string }`
  — no inline managed fields.
- Remove the top-level `LlamaCpp` and `Model` keys from `SiftConfig`.
- `Runtime` becomes required: `Runtime: { Model: string | null; LlamaCpp: RuntimeLlamaCppConfig }`.
- Remove `Thresholds.MaxInputCharacters`, `Effective.LegacyMaxInputCharactersRemoved`,
  `Effective.LegacyMaxInputCharactersValue`, and the
  `legacyMaxInputCharacters*` fields from `NormalizationInfo`.
- Mirror the type changes in `dashboard/src/types.ts` and
  `dashboard/src/types.d.ts`.

### 2. Resolver — `src/status-server/config-store.ts`

- Add `getActiveManagedLlamaPreset(config)` — find the preset whose `id`
  matches `Server.LlamaCpp.ActivePresetId`; fall back to `Presets[0]`.
- `getManagedLlamaConfig()` resolves managed settings from the active
  preset instead of reading inline `Server.LlamaCpp.*` fields.
- Rename `getCompatRuntimeLlamaCpp()` to `getRuntimeLlamaCpp()`; it returns
  `Runtime.LlamaCpp` only — drop the `cfg.LlamaCpp` legacy fallback.
- Delete `applyActiveManagedLlamaPreset`, `copyManagedLlamaFields`,
  `managedLlamaFieldsDiffer`, `MANAGED_LLAMA_FIELD_KEYS`.
- Delete `copyManagedLlamaPresetToServer` / `copyManagedLlamaServerToPreset`,
  `MANAGED_LLAMA_PRESET_KEYS`, `MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS` from
  `src/config/normalization.ts` once unused.
- Dashboard: `dashboard/src/managed-llama-presets.ts` `buildPresetFromServer`
  / `copyPresetToServer` collapse — the UI edits preset objects directly
  because `Server.LlamaCpp` *is* the preset list plus `ActivePresetId`.

### 3. Schema migration — `app_config`, `runtime_schema` version bump

- Increment the `runtime_schema` version; add a migration step.
- Migration:
  1. If `server_llama_presets_json` is empty/invalid, synthesize one preset
     from the existing `server_*` columns (reuse `normalizeManagedLlamaPresetArray`
     fallback logic) so no current config is lost.
  2. Ensure `server_llama_active_preset_id` is set to a valid preset id.
  3. `ALTER TABLE app_config DROP COLUMN` for every `server_*` column
     except `server_llama_presets_json` and `server_llama_active_preset_id`,
     and for every `llama_*` column.
- Keep: `server_llama_presets_json`, `server_llama_active_preset_id`,
  `presets_json`, and all non-llama columns (thresholds, interactive,
  policy, backend, etc.).
- This is a forward-only schema migration, not a legacy-compat shim.

### 4. Runtime launch snapshot

- `Runtime.LlamaCpp` is a snapshot of the active preset taken when the
  managed server boots (decision: snapshot at launch, not live-derived).
- In `src/status-server/managed-llama.ts`, after the managed server passes
  its healthcheck on startup, write a `runtime_llama_launch_snapshot` key
  into `runtime_metadata` — JSON of the active preset's runtime-relevant
  fields (`BaseUrl`, `NumCtx`, `ModelPath`, `Temperature`, `TopP`, `TopK`,
  `MinP`, `PresencePenalty`, `RepetitionPenalty`, `MaxTokens`, `GpuLayers`,
  `Threads`, `NcpuMoe`, `FlashAttention`, `ParallelSlots`, `Reasoning`, and
  the resolved `Model`).
- The config service builds `Runtime.LlamaCpp` / `Runtime.Model` from this
  snapshot.
- Absent snapshot (server never launched) → empty `Runtime.LlamaCpp` →
  `Effective.RuntimeConfigReady = false` via the existing
  `getMissingRuntimeFields` path. Fails loud; no silent fallback.
- Pass-through mode is unchanged: `applyHostLlamaRuntimeSettings()` still
  overlays the host SiftKit's live `Runtime.LlamaCpp` / `Runtime.Model`.
- Editing the active preset while a server is running does not change the
  snapshot; a relaunch applies it. This matches "use preset settings on
  launch."

### 5. Legacy deletions

- Delete `src/status-server/runtime-cutover.ts` in full, its import and
  call site in `src/status-server/index.ts`, and the
  `runtime_cutover_v1_complete` marker logic. This removes the legacy
  `config.json` / `compression.json` / `observed-budget.json` / chat-session
  `.json` import **and** the run-log / `idle-summary.sqlite` migration
  (decision: delete whole file). Installs that never ran the cutover lose
  pre-cutover run-log / idle-summary data — accepted.
- `src/config/normalization.ts`: delete the `legacyOllama` block, the
  `legacyMaxInputCharacters` block, and the `legacyRuntimePromptPrefix`
  block. Remove the corresponding lines in `src/config/effective.ts`.
- Remove all reads/writes of top-level `LlamaCpp` and `Model`:
  `getDefaultConfig`, `normalizeConfig`, `rowToConfig`,
  `normalizeConfigToRow`, and the dual-`Model` overlay in
  `src/config/host-sync.ts`.
- Delete stale `.json` config files from disk during plan execution:
  `~/.siftkit/config.json`, `~/.siftkit/metrics/compression.json`,
  `~/.siftkit/status/inference.txt`, and similar orphans. No code
  references them; this is a one-time cleanup, not a code change.

### 6. Testing (TDD)

New / rewritten tests:

- `getActiveManagedLlamaPreset` returns the matching preset and falls back
  to `Presets[0]`.
- `getManagedLlamaConfig` resolves from the active preset.
- `getRuntimeLlamaCpp` returns `Runtime.LlamaCpp` with no legacy fallback.
- Schema migration drops the `server_*` / `llama_*` columns and preserves
  `server_llama_presets_json` / `server_llama_active_preset_id`, including
  the empty-presets synthesis path.
- Launch-snapshot write on healthcheck pass; config service reads it into
  `Runtime.LlamaCpp`.
- Absent snapshot → `RuntimeConfigReady = false`.
- Pass-through overlay (`applyHostLlamaRuntimeSettings`) still works.

Delete:

- `tests/runtime-db-config-cutover.test.ts`.
- Legacy-Ollama and `MaxInputCharacters` test cases in
  `tests/config-normalization.test.ts`.

Rewrite to the new shape:

- `tests/config-normalization.test.ts`, `tests/dashboard-managed-presets.test.ts`,
  `tests/managed-llama-args.test.ts`, `tests/settings-sections.test.ts`,
  `dashboard/tests/tab-components.test.tsx`.

Target near-100% branch coverage on the resolver, the migration, and the
snapshot write/read paths.

## Non-goals

- Top-level `Presets` (`presets_json`) refactor.
- The repo-search compaction-thrash latency fix (separate issue: compaction
  has no hysteresis and re-triggers at the budget ceiling).

## Risks

- `ALTER TABLE ... DROP COLUMN` rewrites `app_config`. The table has one
  row, so cost is negligible despite the 2.6 GB database.
- Deleting `runtime-cutover.ts` is irreversible for un-migrated installs;
  accepted per "no legacy, fail loud."
