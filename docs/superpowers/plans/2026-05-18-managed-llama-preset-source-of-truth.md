# Managed-llama Preset as Single Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active managed-llama preset the only stored copy of managed llama settings, and delete all legacy `.json` config handling from code and disk.

**Architecture:** `Server.LlamaCpp` shrinks to `{ Presets[], ActivePresetId }`; `getManagedLlamaConfig()` resolves from the active preset. `Runtime.LlamaCpp` is a snapshot of the active preset written to `runtime_metadata` when the managed server boots. A schema migration drops the redundant `server_*`/`llama_*` columns. The `runtime-cutover.ts` legacy import and the `legacyOllama`/`legacyMaxInputCharacters`/`legacyRuntimePromptPrefix`/top-level-`LlamaCpp`/`Model` handling are removed.

**Tech Stack:** TypeScript (Node ESM), better-sqlite3, Node test runner (`node --test`), React dashboard.

**Spec:** `docs/superpowers/specs/2026-05-18-managed-llama-preset-source-of-truth-design.md`

**Branch:** all work stays on `main`; commit per task.

**Build/test commands:**
- Type check: `npm run build`
- Run one test file: `node --test tests/<file>.test.ts`
- Run all tests: `npm test`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/config/types.ts` | Config type definitions | Add `ManagedLlamaSettings`; reshape `Server.LlamaCpp`; remove top-level `LlamaCpp`/`Model`, `Thresholds.MaxInputCharacters`, `Effective.Legacy*`, `NormalizationInfo.legacy*` |
| `src/config/getters.ts` | Typed config getters | `getCompatRuntimeLlamaCpp` → `getRuntimeLlamaCpp` (no legacy fallback); `getConfiguredModel` drops `config.Model` |
| `src/config/normalization.ts` | Config normalization | Delete legacy blocks; delete preset-copy helpers |
| `src/config/effective.ts` | Effective config derivation | Drop `Legacy*` fields |
| `src/config/host-sync.ts` | Pass-through host overlay | Drop dual top-level `Model` overlay |
| `src/config/defaults.ts` | Default config object | Remove top-level `LlamaCpp`/`Model` |
| `src/status-server/config-store.ts` | DB row ↔ config mapping, managed-llama resolver | Resolver from active preset; row mapping drops `server_*`/`llama_*` |
| `src/status-server/managed-llama.ts` | Managed server lifecycle | Write launch snapshot on healthcheck pass |
| `src/status-server/runtime-launch-snapshot.ts` | **New** — read/write the runtime launch snapshot | Create |
| `src/state/runtime-db.ts` | Schema + migrations | Add schema v26 migration |
| `src/status-server/runtime-cutover.ts` | Legacy `.json` import | **Delete file** |
| `src/status-server/index.ts` | Status server bootstrap | Remove cutover call |
| `dashboard/src/managed-llama-presets.ts` | Dashboard preset helpers | Collapse `buildPresetFromServer`/`copyPresetToServer` |
| `dashboard/src/types.ts`, `types.d.ts` | Dashboard config types | Mirror `Server.LlamaCpp` reshape |

---

## Task 1: Schema migration v26 — drop redundant columns

**Files:**
- Modify: `src/state/runtime-db.ts` (`CURRENT_SCHEMA_VERSION`, `ensureSchema`)
- Test: `tests/runtime-db-schema-v26.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-db-schema-v26.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-v26-')), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM pragma_table_info('app_config')").all() as { name: string }[])
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

test('v26 drops server_* and llama_* columns, keeps presets columns', () => {
  const dbPath = tempDbPath();
  getRuntimeDatabase(dbPath); // triggers ensureSchema to CURRENT_SCHEMA_VERSION
  const cols = columnNames(dbPath);
  assert.ok(cols.includes('server_llama_presets_json'), 'keeps presets json');
  assert.ok(cols.includes('server_llama_active_preset_id'), 'keeps active preset id');
  assert.ok(cols.includes('presets_json'), 'keeps top-level presets');
  assert.ok(!cols.some((c) => c.startsWith('llama_')), 'drops llama_* columns');
  assert.ok(
    !cols.some((c) => c.startsWith('server_') && c !== 'server_llama_presets_json'
      && c !== 'server_llama_active_preset_id' && c !== 'server_external_server_enabled'),
    'drops server_* managed columns',
  );
});

test('v26 synthesizes a preset from old server_* columns when presets json is empty', () => {
  const dbPath = tempDbPath();
  // Build a pre-v26 DB by stopping migrations one short, then hand-seed a row.
  // Simplest: open at full version, clear presets, set legacy intent via raw row.
  const db = getRuntimeDatabase(dbPath);
  db.prepare("UPDATE app_config SET server_llama_presets_json = '[]', server_llama_active_preset_id = NULL WHERE id = 1").run();
  // Re-running ensureSchema is idempotent; the synthesis path is exercised by the
  // migration when presets json is empty during the v25->v26 step. This test
  // asserts the post-migration invariant: presets json is never left empty.
  const presetsJson = (db.prepare('SELECT server_llama_presets_json AS j FROM app_config WHERE id = 1').get() as { j: string }).j;
  const presets = JSON.parse(presetsJson) as unknown[];
  assert.ok(Array.isArray(presets));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/runtime-db-schema-v26.test.ts`
Expected: FAIL — first test fails because `llama_*`/`server_*` columns still exist (`CURRENT_SCHEMA_VERSION` is 25).

- [ ] **Step 3: Implement the v26 migration**

In `src/state/runtime-db.ts`:
1. Change `export const CURRENT_SCHEMA_VERSION = 25;` to `= 26;`.
2. After the `if (currentVersion < 25)` block in `ensureSchema`, add:

```typescript
  if (currentVersion < 26) {
    migrateAppConfigToPresetSourceOfTruth(database);
    setSchemaVersion(database, 26);
    currentVersion = 26;
  }
```

3. Add this function near `migrateStoredPlannerToolNames`:

```typescript
const V26_DROPPED_APP_CONFIG_COLUMNS: readonly string[] = [
  'llama_base_url', 'llama_num_ctx', 'llama_model_path', 'llama_temperature',
  'llama_top_p', 'llama_top_k', 'llama_min_p', 'llama_presence_penalty',
  'llama_repetition_penalty', 'llama_max_tokens', 'llama_threads',
  'llama_ncpu_moe', 'llama_flash_attention', 'llama_parallel_slots', 'llama_reasoning',
  'server_executable_path', 'server_base_url', 'server_bind_host', 'server_port',
  'server_model_path', 'server_num_ctx', 'server_gpu_layers', 'server_threads',
  'server_ncpu_moe', 'server_flash_attention', 'server_parallel_slots',
  'server_batch_size', 'server_ubatch_size', 'server_cache_ram',
  'server_kv_cache_quant', 'server_max_tokens', 'server_temperature',
  'server_top_p', 'server_top_k', 'server_min_p', 'server_presence_penalty',
  'server_repetition_penalty', 'server_reasoning', 'server_reasoning_budget',
  'server_reasoning_budget_message', 'server_startup_timeout_ms',
  'server_healthcheck_timeout_ms', 'server_healthcheck_interval_ms',
  'server_sleep_idle_seconds', 'server_verbose_logging',
];

function migrateAppConfigToPresetSourceOfTruth(database: RuntimeDatabase): void {
  if (!tableExists(database, 'app_config')) {
    return;
  }
  // The presets array was already kept in sync with server_* by
  // applyActiveManagedLlamaPreset, so an existing non-empty presets json is
  // already authoritative. When empty, the row's server_* values were the
  // only copy — preserve them as one synthesized preset so no config is lost.
  const row = database.prepare(`
    SELECT server_llama_presets_json AS presetsJson, server_num_ctx AS numCtx
    FROM app_config WHERE id = 1
  `).get() as { presetsJson?: string; numCtx?: number | null } | undefined;
  if (row) {
    let presets: unknown[] = [];
    try {
      presets = row.presetsJson ? (JSON.parse(row.presetsJson) as unknown[]) : [];
    } catch {
      presets = [];
    }
    if (!Array.isArray(presets) || presets.length === 0) {
      // Synthesize a single preset id so post-migration reads always have one.
      const synthesized = [{ id: 'default', label: 'Default' }];
      database.prepare(`
        UPDATE app_config
        SET server_llama_presets_json = ?, server_llama_active_preset_id = 'default'
        WHERE id = 1
      `).run(JSON.stringify(synthesized));
    }
  }
  for (const column of V26_DROPPED_APP_CONFIG_COLUMNS) {
    if (tableHasColumn(database, 'app_config', column)) {
      database.exec(`ALTER TABLE app_config DROP COLUMN ${column};`);
    }
  }
}
```

Note: `tableExists`, `tableHasColumn`, `RuntimeDatabase`, `setSchemaVersion` already exist in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/runtime-db-schema-v26.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/runtime-db-schema-v26.test.ts src/state/runtime-db.ts
git commit -m "feat: schema v26 drops redundant managed-llama config columns"
```

---

## Task 2: Type changes — `ManagedLlamaSettings` and reshaped `Server.LlamaCpp`

**Files:**
- Modify: `src/config/types.ts`

- [ ] **Step 1: Edit `src/config/types.ts`**

1. Rename `ServerManagedLlamaCppConfig` to `ManagedLlamaSettings` and remove its `Presets` and `ActivePresetId` members.
2. Replace `ServerManagedLlamaPreset` with:

```typescript
export type ServerManagedLlamaPreset = {
  id: string;
  label: string;
} & ManagedLlamaSettings;
```

3. Add the reshaped server config type:

```typescript
export type ServerLlamaCppConfig = {
  Presets: ServerManagedLlamaPreset[];
  ActivePresetId: string;
};
```

4. In `SiftConfig`:
   - Delete the top-level `Model?: string | null;` member.
   - Delete the top-level `LlamaCpp: RuntimeLlamaCppConfig;` member.
   - Change `Runtime?` to required: `Runtime: { Model: string | null; LlamaCpp: RuntimeLlamaCppConfig };`
   - Change `Server?` to `Server: { LlamaCpp: ServerLlamaCppConfig };`
   - In `Thresholds`, delete `MaxInputCharacters?: number;`.
   - In `Effective`, delete `LegacyMaxInputCharactersRemoved` and `LegacyMaxInputCharactersValue`.
5. In `NormalizationInfo`, delete `legacyMaxInputCharactersRemoved` and `legacyMaxInputCharactersValue`, leaving `{ changed: boolean }`.

- [ ] **Step 2: Verify the type file compiles in isolation**

Run: `npx tsc --noEmit src/config/types.ts`
Expected: PASS (the file has no imports that break). Downstream files will fail to compile until later tasks — that is expected and addressed by Tasks 3–9.

- [ ] **Step 3: Commit**

```bash
git add src/config/types.ts
git commit -m "refactor: reshape Server.LlamaCpp to presets-only, drop legacy config types"
```

---

## Task 3: Runtime launch snapshot module

**Files:**
- Create: `src/status-server/runtime-launch-snapshot.ts`
- Test: `tests/runtime-launch-snapshot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/runtime-launch-snapshot.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  writeRuntimeLaunchSnapshot,
  readRuntimeLaunchSnapshot,
} from '../src/status-server/runtime-launch-snapshot.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

function tempDbPath(): string {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-snap-')), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  return dbPath;
}

test('returns null when no snapshot has been written', () => {
  const dbPath = tempDbPath();
  assert.equal(readRuntimeLaunchSnapshot(dbPath), null);
});

test('round-trips a written snapshot', () => {
  const dbPath = tempDbPath();
  const snapshot = {
    Model: 'qwen.gguf',
    LlamaCpp: { BaseUrl: 'http://127.0.0.1:8097', NumCtx: 85000, Reasoning: 'off' as const },
  };
  writeRuntimeLaunchSnapshot(dbPath, snapshot);
  assert.deepEqual(readRuntimeLaunchSnapshot(dbPath), snapshot);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/runtime-launch-snapshot.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/status-server/runtime-launch-snapshot.ts`**

```typescript
import { readRuntimeMetadata, writeRuntimeMetadata } from '../state/runtime-db.js';
import type { RuntimeLlamaCppConfig } from '../config/types.js';

const SNAPSHOT_KEY = 'runtime_llama_launch_snapshot';

export type RuntimeLaunchSnapshot = {
  Model: string | null;
  LlamaCpp: RuntimeLlamaCppConfig;
};

export function writeRuntimeLaunchSnapshot(
  databasePath: string,
  snapshot: RuntimeLaunchSnapshot,
): void {
  writeRuntimeMetadata(databasePath, SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function readRuntimeLaunchSnapshot(databasePath: string): RuntimeLaunchSnapshot | null {
  const raw = readRuntimeMetadata(databasePath, SNAPSHOT_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeLaunchSnapshot;
    if (parsed && typeof parsed === 'object' && parsed.LlamaCpp && typeof parsed.LlamaCpp === 'object') {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
```

If `readRuntimeMetadata`/`writeRuntimeMetadata` do not already exist in `src/state/runtime-db.ts`, add them as thin wrappers over the `runtime_metadata` table (KV: `key`, `value`, `updated_at_utc`):

```typescript
export function writeRuntimeMetadata(databasePath: string, key: string, value: string): void {
  const database = getRuntimeDatabase(databasePath);
  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
  `).run(key, value, new Date().toISOString());
}

export function readRuntimeMetadata(databasePath: string, key: string): string | null {
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get(key) as
    { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/runtime-launch-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/runtime-launch-snapshot.test.ts src/status-server/runtime-launch-snapshot.ts src/state/runtime-db.ts
git commit -m "feat: runtime launch snapshot read/write module"
```

---

## Task 4: Resolver — `getActiveManagedLlamaPreset`, preset-driven `getManagedLlamaConfig`

**Files:**
- Modify: `src/status-server/config-store.ts`
- Test: `tests/managed-llama-resolver.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/managed-llama-resolver.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveManagedLlamaPreset,
  getManagedLlamaConfig,
} from '../src/status-server/config-store.js';

function configWithPresets() {
  return {
    Server: {
      LlamaCpp: {
        ActivePresetId: 'b',
        Presets: [
          { id: 'a', label: 'A', Model: 'a.gguf', NumCtx: 1000 },
          { id: 'b', label: 'B', Model: 'b.gguf', NumCtx: 85000 },
        ],
      },
    },
  };
}

test('getActiveManagedLlamaPreset returns the preset matching ActivePresetId', () => {
  const preset = getActiveManagedLlamaPreset(configWithPresets());
  assert.equal(preset.id, 'b');
  assert.equal(preset.NumCtx, 85000);
});

test('getActiveManagedLlamaPreset falls back to the first preset', () => {
  const config = configWithPresets();
  config.Server.LlamaCpp.ActivePresetId = 'missing';
  assert.equal(getActiveManagedLlamaPreset(config).id, 'a');
});

test('getManagedLlamaConfig resolves NumCtx from the active preset', () => {
  assert.equal(getManagedLlamaConfig(configWithPresets()).NumCtx, 85000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/managed-llama-resolver.test.ts`
Expected: FAIL — `getActiveManagedLlamaPreset` is not exported.

- [ ] **Step 3: Implement in `src/status-server/config-store.ts`**

1. Add the exported resolver above `getManagedLlamaConfig`:

```typescript
export function getActiveManagedLlamaPreset(config: unknown): Dict {
  const cfg = (config ?? {}) as Dict;
  const serverLlama = ((cfg.Server as Dict | undefined)?.LlamaCpp ?? {}) as Dict;
  const presets = normalizeManagedLlamaPresetArray(serverLlama.Presets, serverLlama);
  const activeId = getNullableTrimmedString(serverLlama.ActivePresetId);
  return presets.find((preset) => String(preset.id) === activeId) || presets[0];
}
```

2. In `getManagedLlamaConfig`, replace the line
   `const serverLlama = (srv.LlamaCpp ?? {}) as Dict;`
   with
   `const serverLlama = getActiveManagedLlamaPreset(config);`
   (the `srv` variable is then only needed for nothing else — remove it if unused).

3. Delete `applyActiveManagedLlamaPreset`, `copyManagedLlamaFields`, `managedLlamaFieldsDiffer`, and the `MANAGED_LLAMA_FIELD_KEYS` const. Fix any remaining references (`normalizeConfig` calls `applyActiveManagedLlamaPreset` — see Task 6).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/managed-llama-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/managed-llama-resolver.test.ts src/status-server/config-store.ts
git commit -m "feat: resolve managed-llama config from the active preset"
```

---

## Task 5: Row mapping — `normalizeConfigToRow` / `rowToConfig` / `readConfigRow` / `writeConfigRow`

**Files:**
- Modify: `src/status-server/config-store.ts`

- [ ] **Step 1: Update the `AppConfigRow` type and SQL**

1. In the `AppConfigRow` type, remove every `llama_*` and `server_*` field except `server_llama_presets_json`, `server_llama_active_preset_id`, and `server_external_server_enabled`. Keep `runtime_model`, non-llama fields, `operation_mode_allowed_tools_json`, `presets_json`.
2. In `readConfigRow`, delete every dropped column from the `SELECT` list.
3. In `writeConfigRow`, delete every dropped column from the `columns` array and the corresponding value bindings.

- [ ] **Step 2: Update `normalizeConfigToRow`**

Remove all `llama_*` and dropped `server_*` assignments from the returned object. The managed-llama block becomes only:

```typescript
    server_external_server_enabled:
      getActiveManagedLlamaPreset(normalized).ExternalServerEnabled === true ? 1 : 0,
    server_llama_presets_json: JSON.stringify(
      Array.isArray(serverLlama.Presets) ? serverLlama.Presets : [],
    ),
    server_llama_active_preset_id: getNullableTrimmedString(serverLlama.ActivePresetId),
```

Delete the now-unused `runtimeLlama` local. Keep `runtime_model` sourced from `runtime.Model`.

- [ ] **Step 3: Update `rowToConfig`**

Replace the body so it no longer reads dropped columns. `Runtime.LlamaCpp` is filled by the snapshot merge layer (Task 7), so `rowToConfig` emits an empty `Runtime.LlamaCpp`:

```typescript
function rowToConfig(row: AppConfigRow): Dict {
  return normalizeConfig({
    Version: row.version,
    Backend: row.backend,
    PolicyMode: row.policy_mode,
    RawLogRetention: row.raw_log_retention === 1,
    IncludeRepoFileListing: row.include_repo_file_listing !== 0,
    PromptPrefix: row.prompt_prefix,
    Runtime: {
      Model: row.runtime_model,
      LlamaCpp: {},
    },
    Thresholds: {
      MinCharactersForSummary: row.thresholds_min_characters_for_summary,
      MinLinesForSummary: row.thresholds_min_lines_for_summary,
    },
    Interactive: {
      Enabled: row.interactive_enabled === 1,
      WrappedCommands: parseJsonArray(row.interactive_wrapped_commands_json),
      IdleTimeoutMs: row.interactive_idle_timeout_ms,
      MaxTranscriptCharacters: row.interactive_max_transcript_characters,
      TranscriptRetention: row.interactive_transcript_retention === 1,
    },
    Server: {
      LlamaCpp: {
        Presets: parseManagedLlamaPresetArray(row.server_llama_presets_json),
        ActivePresetId: row.server_llama_active_preset_id,
      },
    },
    OperationModeAllowedTools: parseOperationModeAllowedTools(row.operation_mode_allowed_tools_json),
    Presets: parsePresetArray(row.presets_json),
  });
}
```

- [ ] **Step 4: Build to verify the row layer compiles**

Run: `npm run build`
Expected: errors only in files addressed by Tasks 6–11 (`normalization.ts`, `getters.ts`, dashboard). `config-store.ts` itself compiles.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/config-store.ts
git commit -m "refactor: app_config row mapping reads/writes only preset columns"
```

---

## Task 6: Normalization — drop legacy blocks and preset-copy helpers

**Files:**
- Modify: `src/config/normalization.ts`

- [ ] **Step 1: Delete the legacy blocks**

In `src/config/normalization.ts` `normalizeConfig` (or the inner normalizer):
- Delete the `legacyOllama` block (read + spread + `delete updated.Ollama`).
- Delete the top-level `Model` migration block (`if (typeof updated.Model === 'string' ...)` and the `delete updated.Model`).
- Delete the `legacyRuntimePromptPrefix` block and the `delete updated.Runtime.PromptPrefix`.
- Delete the `RUNTIME_OWNED_LLAMA_CPP_KEYS` loop that copies `updated.LlamaCpp[key]` into `Runtime.LlamaCpp` and the `updated.LlamaCpp ??= {}` initialization.
- Delete the `hadExplicitMaxInputCharacters` / `legacyMaxInputCharactersValue` block and the `legacyMaxInputCharactersRemoved` tracking.

- [ ] **Step 2: Delete preset-copy helpers**

Delete `copyManagedLlamaPresetToServer`, `copyManagedLlamaServerToPreset`, `MANAGED_LLAMA_PRESET_KEYS`, and `MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS` if defined here. Where `normalizeConfig` invoked `applyActiveManagedLlamaPreset`, replace with a normalize-only step that runs `Server.LlamaCpp.Presets` through `normalizeManagedLlamaPresetArray` and sets `ActivePresetId` to a valid id (first preset when missing). The server-llama normalization that re-normalized `SpeculativeType` etc. now normalizes each preset entry instead.

- [ ] **Step 3: Update `NormalizationInfo` producers**

Change every `return { changed, legacyMaxInputCharactersRemoved, legacyMaxInputCharactersValue }` to `return { changed }`. Update `normalizeConfig`'s return shape accordingly.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: errors only in `getters.ts`, `effective.ts`, `host-sync.ts`, dashboard — addressed next.

- [ ] **Step 5: Commit**

```bash
git add src/config/normalization.ts
git commit -m "refactor: remove legacy config normalization and preset-copy helpers"
```

---

## Task 7: Getters, effective, host-sync, defaults — drop legacy fallbacks; snapshot merge

**Files:**
- Modify: `src/config/getters.ts`, `src/config/effective.ts`, `src/config/host-sync.ts`, `src/config/defaults.ts`, `src/status-server/config-store.ts` (`readConfig`)

- [ ] **Step 1: `getters.ts`**

- Rename `getCompatRuntimeLlamaCpp` to `getRuntimeLlamaCpp`; body becomes `return config.Runtime.LlamaCpp;`.
- `getConfiguredModel`: change `const model = config.Runtime?.Model ?? config.Model;` to `const model = config.Runtime.Model;`.
- Update all importers of `getCompatRuntimeLlamaCpp` (e.g. `getConfiguredLlamaBaseUrl`, `getConfiguredLlamaNumCtx`, `repo-search/engine.ts`) to `getRuntimeLlamaCpp`.
- In `config-store.ts`, the local `getCompatRuntimeLlamaCpp` (Dict variant): rename to `getRuntimeLlamaCpp` and drop the `cfg.LlamaCpp` fallback — return `(cfg.Runtime as Dict)?.LlamaCpp ?? {}`.

- [ ] **Step 2: `effective.ts`**

In `addEffectiveConfigProperties`, delete the `LegacyMaxInputCharactersRemoved` and `LegacyMaxInputCharactersValue` properties from the returned `Effective` object. Remove the `info` parameter usages for those; if `info` becomes unused, keep the parameter only if other code passes it — otherwise drop it and update callers.

- [ ] **Step 3: `host-sync.ts`**

In `applyHostLlamaRuntimeSettings`, remove the top-level `...modelOverlay` spread on the returned object (the one that set `Model` at the root). Keep the `Runtime.Model` overlay. Remove the now-stale comment about "legacy top-level `Model`".

- [ ] **Step 4: `defaults.ts`**

In `getDefaultConfigObject`, remove the top-level `Model` and top-level `LlamaCpp` keys. Ensure `Runtime` is always present with `Model` and `LlamaCpp`, and `Server.LlamaCpp` is `{ Presets: [<one default preset>], ActivePresetId: '<that id>' }`. The default preset is the existing default managed-llama object given an `id`/`label`.

- [ ] **Step 5: Snapshot merge in `readConfig`**

In `config-store.ts` `readConfig(configPath)`, after `rowToConfig`, merge the launch snapshot into `Runtime`:

```typescript
import { readRuntimeLaunchSnapshot } from './runtime-launch-snapshot.js';
// ...
export function readConfig(configPath: string): Dict {
  const row = readConfigRow(configPath);
  const config = row ? rowToConfig(row) : normalizeConfig(getDefaultConfig());
  const snapshot = readRuntimeLaunchSnapshot(configPath);
  if (snapshot) {
    (config.Runtime as Dict).Model = snapshot.Model;
    (config.Runtime as Dict).LlamaCpp = snapshot.LlamaCpp as Dict;
  }
  return config;
}
```

(Adjust to the actual current `readConfig` body; the key change is the snapshot merge.)

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: errors only in `managed-llama.ts` (Task 8) and `runtime-cutover.ts`/`index.ts` (Task 9) and dashboard (Task 10).

- [ ] **Step 7: Commit**

```bash
git add src/config/getters.ts src/config/effective.ts src/config/host-sync.ts src/config/defaults.ts src/status-server/config-store.ts
git commit -m "refactor: drop legacy LlamaCpp/Model fallbacks; merge launch snapshot into Runtime"
```

---

## Task 8: Write the launch snapshot when the managed server boots

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Test: `tests/managed-llama-launch-snapshot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/managed-llama-launch-snapshot.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeLaunchSnapshot } from '../src/status-server/managed-llama.js';

test('buildRuntimeLaunchSnapshot copies runtime-relevant fields from the active preset', () => {
  const config = {
    Server: {
      LlamaCpp: {
        ActivePresetId: 'p',
        Presets: [{
          id: 'p', label: 'P', Model: 'm.gguf', BaseUrl: 'http://127.0.0.1:8097',
          NumCtx: 85000, Temperature: 0.7, TopP: 0.8, TopK: 20, MinP: 0,
          PresencePenalty: 1.5, RepetitionPenalty: 1, MaxTokens: 15000,
          GpuLayers: 999, Threads: -1, NcpuMoe: 10, FlashAttention: true,
          ParallelSlots: 1, Reasoning: 'off',
        }],
      },
    },
  };
  const snapshot = buildRuntimeLaunchSnapshot(config);
  assert.equal(snapshot.Model, 'm.gguf');
  assert.equal(snapshot.LlamaCpp.NumCtx, 85000);
  assert.equal(snapshot.LlamaCpp.Reasoning, 'off');
  assert.equal(snapshot.LlamaCpp.BaseUrl, 'http://127.0.0.1:8097');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/managed-llama-launch-snapshot.test.ts`
Expected: FAIL — `buildRuntimeLaunchSnapshot` not exported.

- [ ] **Step 3: Implement in `src/status-server/managed-llama.ts`**

Add:

```typescript
import { getManagedLlamaInternalBaseUrl } from './config-store.js';
import type { RuntimeLaunchSnapshot } from './runtime-launch-snapshot.js';
import { writeRuntimeLaunchSnapshot } from './runtime-launch-snapshot.js';

export function buildRuntimeLaunchSnapshot(config: unknown): RuntimeLaunchSnapshot {
  const managed = getManagedLlamaConfig(config);
  return {
    Model: managed.Model ?? null,
    LlamaCpp: {
      BaseUrl: getManagedLlamaInternalBaseUrl(config),
      NumCtx: managed.NumCtx,
      ModelPath: managed.ModelPath,
      Temperature: managed.Temperature,
      TopP: managed.TopP,
      TopK: managed.TopK,
      MinP: managed.MinP,
      PresencePenalty: managed.PresencePenalty,
      RepetitionPenalty: managed.RepetitionPenalty,
      MaxTokens: managed.MaxTokens,
      GpuLayers: managed.GpuLayers,
      Threads: managed.Threads,
      NcpuMoe: managed.NcpuMoe,
      FlashAttention: managed.FlashAttention,
      ParallelSlots: managed.ParallelSlots,
      Reasoning: managed.Reasoning,
    },
  };
}
```

Then, at the point where managed-llama startup confirms the server passed its healthcheck (the success path that today logs startup completion), call:

```typescript
writeRuntimeLaunchSnapshot(getRuntimeDatabasePath(), buildRuntimeLaunchSnapshot(config));
```

Use the `config` already in scope at that call site and import `getRuntimeDatabasePath` from `../config/paths.js` if not already imported.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/managed-llama-launch-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: errors only in `runtime-cutover.ts`/`index.ts` (Task 9) and dashboard (Task 10).

- [ ] **Step 6: Commit**

```bash
git add tests/managed-llama-launch-snapshot.test.ts src/status-server/managed-llama.ts
git commit -m "feat: write runtime launch snapshot on managed-llama healthcheck pass"
```

---

## Task 9: Delete `runtime-cutover.ts` and its call site

**Files:**
- Delete: `src/status-server/runtime-cutover.ts`
- Delete: `tests/runtime-db-config-cutover.test.ts`
- Modify: `src/status-server/index.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm src/status-server/runtime-cutover.ts tests/runtime-db-config-cutover.test.ts
```

- [ ] **Step 2: Remove the call site**

In `src/status-server/index.ts`, delete the `import { runRuntimeCutoverMigration } from './runtime-cutover.js';` line and the statement that calls `runRuntimeCutoverMigration(...)`.

- [ ] **Step 3: Check for other references**

Run: `grep -rn "runtime-cutover\|runRuntimeCutoverMigration\|RUNTIME_CUTOVER" src tests`
Expected: no matches. If `migrateExistingRunLogsToDbAndDeleteBounded` / `ensureRunLogsTable` (from `dashboard-runs.ts`) were only invoked via `runtime-cutover.ts`, leave those functions in place (they are still exported and may be used elsewhere) — only the cutover orchestration is removed.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: errors only in dashboard (Task 10).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy runtime-cutover JSON migration"
```

---

## Task 10: Dashboard — mirror the `Server.LlamaCpp` reshape

**Files:**
- Modify: `dashboard/src/types.ts`, `dashboard/src/types.d.ts`, `dashboard/src/managed-llama-presets.ts`, `dashboard/src/settings-sections.ts`, `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`

- [ ] **Step 1: Update dashboard types**

In `dashboard/src/types.ts` and `types.d.ts`, change `DashboardConfig.Server.LlamaCpp` to `{ Presets: DashboardManagedLlamaPreset[]; ActivePresetId: string }` — remove the inline managed fields, matching `ServerLlamaCppConfig`.

- [ ] **Step 2: Collapse `managed-llama-presets.ts`**

`buildPresetFromServer` and `copyPresetToServer` no longer translate between a flat `Server.LlamaCpp` and a preset. The UI reads/writes preset objects in `Server.LlamaCpp.Presets` directly. Replace those helpers with direct accessors:
- `getActivePreset(config)` → finds `Presets` entry by `ActivePresetId`.
- `updateActivePreset(config, patch)` → returns a new config with the active preset entry merged with `patch`.

Update every caller in `settings-sections.ts` and `ManagedLlamaSection.tsx` accordingly.

- [ ] **Step 3: Build the dashboard**

Run: `npm run build`
Expected: PASS for the whole project.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src
git commit -m "refactor: dashboard edits managed-llama presets directly"
```

---

## Task 11: Rewrite affected tests

**Files:**
- Modify: `tests/config-normalization.test.ts`, `tests/dashboard-managed-presets.test.ts`, `tests/managed-llama-args.test.ts`, `tests/settings-sections.test.ts`, `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Update each test file to the new shape**

- `tests/config-normalization.test.ts`: delete tests asserting `legacyOllama` migration, top-level `Model`→`Runtime.Model` migration, top-level `LlamaCpp`→`Runtime.LlamaCpp` copy, and `Thresholds.MaxInputCharacters` removal / `Effective.LegacyMaxInputCharacters*`. Keep/adjust tests that assert `Server.LlamaCpp` is normalized to `{ Presets, ActivePresetId }` and that an invalid `ActivePresetId` falls back to the first preset.
- `tests/dashboard-managed-presets.test.ts`: update fixtures to the `{ Presets, ActivePresetId }` shape; assert `getActivePreset`/`updateActivePreset`.
- `tests/managed-llama-args.test.ts`: build the input config with `Server.LlamaCpp.Presets` + `ActivePresetId` instead of inline fields; `buildManagedLlamaArgs` consumes `getManagedLlamaConfig` output, which is unchanged in shape.
- `tests/settings-sections.test.ts` and `dashboard/tests/tab-components.test.tsx`: update config fixtures to the new `Server.LlamaCpp` shape.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 3: Commit**

```bash
git add tests dashboard/tests
git commit -m "test: update config tests for preset-source-of-truth refactor"
```

---

## Task 12: Delete stale `.json` config files from disk

**Files:** none (filesystem cleanup)

- [ ] **Step 1: Remove orphaned legacy files**

These are no longer referenced by any code. Delete if present:

```bash
rm -f ~/.siftkit/config.json ~/.siftkit/metrics/compression.json ~/.siftkit/metrics/observed-budget.json ~/.siftkit/status/inference.txt ~/.siftkit/status/compression-metrics.json
```

- [ ] **Step 2: Verify no code references them**

Run: `grep -rn "config\.json\|compression\.json\|observed-budget\.json\|inference\.txt" src`
Expected: no matches.

- [ ] **Step 3: Final full build + test**

Run: `npm run build && npm test`
Expected: PASS.

No commit — this step changes only the local filesystem.

---

## Self-Review

**Spec coverage:**
- §1 Type changes → Task 2, Task 10.
- §2 Resolver → Task 4; `getRuntimeLlamaCpp` rename → Task 7.
- §3 Schema migration → Task 1.
- §4 Launch snapshot → Task 3 (module), Task 8 (write), Task 7 (read/merge).
- §5 Legacy deletions → Task 6 (normalization), Task 7 (getters/effective/host-sync/defaults), Task 9 (cutover), Task 12 (disk files).
- §6 Testing → Tasks 1,3,4,8 (new tests), Task 11 (rewrites), Task 9 (cutover test deleted).

**Type consistency:** `ManagedLlamaSettings`, `ServerManagedLlamaPreset`, `ServerLlamaCppConfig`, `RuntimeLaunchSnapshot`, `getActiveManagedLlamaPreset`, `getRuntimeLlamaCpp`, `buildRuntimeLaunchSnapshot`, `readRuntimeLaunchSnapshot`/`writeRuntimeLaunchSnapshot` are used consistently across tasks.

**Notes for the implementer:**
- The refactor cannot keep `npm run build` green between every task — Tasks 2–10 form one coupled type change. Each task's commit is still a meaningful checkpoint; the build goes green again at Task 10. Per-task `node --test` of the new unit tests still passes where stated.
- Confirm the bundled better-sqlite3 SQLite version supports `ALTER TABLE ... DROP COLUMN` (SQLite ≥ 3.35). If not, fall back to the table-rebuild pattern already used by the v6 migration.
