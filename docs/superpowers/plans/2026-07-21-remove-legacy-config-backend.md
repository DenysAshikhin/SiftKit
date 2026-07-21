# Remove legacy top-level `config.Backend` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy top-level `config.Backend` field and split the two test seams it smuggled (managed-llama lifecycle disable, summary mock route) onto existing first-class mechanisms, with production behavior unchanged.

**Architecture:** Migrate every consumer off `config.Backend` *first* (reading the active engine via `getActiveInferenceBackend(config)` or the request `backend` override), keeping the field present so each commit compiles and tests stay green. Delete the field last (schema, default, normalize, sqlite column + migration). The lifecycle-disable seam moves to the existing `disableManagedLlamaStartup` flag; the summary mock seam stays a request-only `backend: 'mock'` override.

**Tech Stack:** TypeScript (strict, zod-derived types via `z.infer`), better-sqlite3, `node:test` run via `tsx`. Spec: `docs/superpowers/specs/2026-07-21-remove-legacy-config-backend-design.md`.

**Commands:**
- Single test file: `npx tsx --test .\tests\<file>.test.ts`
- Typecheck: `npm run typecheck`
- Full suite: `npm test`

**Sequencing rule:** Tasks 1–5 keep `config.Backend` in the schema and only stop *reading* it. Task 6 removes the field. Do them in order.

---

### Task 1: Collapse the lifecycle gate to the engine axis

**Files:**
- Modify: `src/config/getters.ts:30-40`
- Test: `tests/managed-llama-lifecycle-gate.test.ts`

- [ ] **Step 1: Update the failing test** — replace the file body so it no longer exercises the deleted `config.Backend='noop'` scenario and asserts the gate keys purely on the active engine.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { managesManagedLlamaLifecycle } from '../src/config/getters.js';
import type { SiftConfig } from '../src/config/types.js';

function withActivePreset(mutate: (config: SiftConfig) => void): SiftConfig {
  const config = getDefaultConfigObject();
  mutate(config);
  return config;
}

test('managesManagedLlamaLifecycle: active llama preset drives the lifecycle', () => {
  const config = getDefaultConfigObject();
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), true);
});

test('managesManagedLlamaLifecycle: active exl3 preset must NOT drive the llama lifecycle', () => {
  const config = withActivePreset((c) => {
    const base = c.Server.ModelPresets.Presets[0];
    if (!base) throw new Error('default preset missing');
    const exl3Preset = { ...base, id: 'exl3-main', Backend: 'exl3' as const };
    c.Server.ModelPresets = { ActivePresetId: exl3Preset.id, Presets: [exl3Preset, base] };
  });
  assert.equal(managesManagedLlamaLifecycle(config), false);
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `npx tsx --test .\tests\managed-llama-lifecycle-gate.test.ts`
Expected: PASS (both cases already hold under the current two-axis gate — this locks the behavior before simplifying the implementation).

- [ ] **Step 3: Simplify the gate** — in `src/config/getters.ts`, replace the comment block and function at lines 30-40 with:

```ts
/**
 * True only when SiftKit should drive the standalone managed-llama.cpp lifecycle:
 * the active preset must be llama-backed. The exl3/TabbyAPI runtime is owned by the
 * PresetRuntimeCoordinator, so these llama-specific start/stop/reap paths no-op when
 * an exl3 preset is active.
 */
export function managesManagedLlamaLifecycle(config: SiftConfig): boolean {
  return getActiveInferenceBackend(config) === 'llama';
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx tsx --test .\tests\managed-llama-lifecycle-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/getters.ts tests/managed-llama-lifecycle-gate.test.ts
git commit -m "refactor(config): key managed-llama lifecycle gate on active engine only"
```

---

### Task 2: Move the lifecycle-disable tests onto `disableManagedLlamaStartup`

The real-status-server tests set `config.Backend='noop'` only to stop the managed-llama process from spawning. The harness already accepts `disableManagedLlamaStartup` (`tests/_runtime-helpers.ts:1222` pushes `--disable-managed-llama-startup`). Switch each test to that flag and drop the `config.Backend` assignment.

**Files:**
- Modify: `tests/runtime-status-server.test.ts` (5 sites: lines 56, 80, 102, 133, 161)
- Modify: `tests/runtime-status-server.lifecycle.test.ts` (4 sites: lines 57, 82, 101, 169)
- Modify: `tests/execution-ownership.test.ts:19`

- [ ] **Step 1: Edit each `withRealStatusServer` call.** For every occurrence, delete the `config.Backend = 'noop';` line and add `disableManagedLlamaStartup: true` to the options object passed as the second argument. Example transform in `tests/runtime-status-server.test.ts`:

Before:
```ts
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      // ...
    }, {
      statusPath,
      configPath,
    });
```

After:
```ts
    const config = getDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      // ...
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
```

Apply the identical edit to all 5 sites in `runtime-status-server.test.ts`, all 4 in `runtime-status-server.lifecycle.test.ts`, and the one in `execution-ownership.test.ts:19` (match its local `withRealStatusServer` options object).

- [ ] **Step 2: Run the affected suites**

Run: `npx tsx --test .\tests\runtime-status-server.test.ts .\tests\runtime-status-server.lifecycle.test.ts .\tests\execution-ownership.test.ts`
Expected: PASS — servers report `running:false`/`status:'false'` exactly as before, now because startup is disabled by flag rather than by the removed field.

- [ ] **Step 3: Commit**

```bash
git add tests/runtime-status-server.test.ts tests/runtime-status-server.lifecycle.test.ts tests/execution-ownership.test.ts
git commit -m "test: disable managed-llama startup via flag instead of config.Backend='noop'"
```

---

### Task 3: Reduce the summary backend axis to real-vs-mock

The summary `backend` value's only behavioral role is the mock switch. Default it to the active engine, drop the redundant `'llama.cpp'` host-settings guard (the function self-gates on `ExternalServerEnabled`), and make oversized rejection mock-only.

**Files:**
- Modify: `src/summary/request-runner.ts:76-79` (oversized predicate), `:195-200` (resolve + host-settings guard), `:239-244` (reject helper)
- Test: `tests/summary-status-server.test.ts:772` (mock via request override), plus a new unit test for the predicate

- [ ] **Step 1: Write the failing predicate test.** Append to `tests/summary-request-runner.test.ts` if it exists, otherwise create it:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { isOversizedMockInput } from '../src/summary/request-runner.js';

test('isOversizedMockInput: only the mock provider rejects oversized input', () => {
  assert.equal(isOversizedMockInput('mock', 100, 50), true);
  assert.equal(isOversizedMockInput('mock', 10, 50), false);
  assert.equal(isOversizedMockInput('llama', 100, 50), false);
  assert.equal(isOversizedMockInput('exl3', 100, 50), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\summary-request-runner.test.ts`
Expected: FAIL — `isOversizedMockInput` is not exported (current export is `isOversizedNonLlamaInput`).

- [ ] **Step 3: Rename + invert the predicate.** In `src/summary/request-runner.ts`, replace lines 76-79:

```ts
/** Only the mock provider cannot chunk, so mock input above `maxInputCharacters` is rejected. */
export function isOversizedMockInput(backend: string, inputLength: number, maxInputCharacters: number): boolean {
  return backend === 'mock' && inputLength > maxInputCharacters;
}
```

- [ ] **Step 4: Default backend to the active engine + drop the host-settings guard.** In `src/summary/request-runner.ts` replace lines 195-200:

```ts
    this.backend = this.request.backend || getActiveInferenceBackend(this.config);
    this.model = this.request.model || getConfiguredModel(this.config);
    logSummaryProgress(`config_done request_id=${this.requestId} backend=${this.backend} model=${this.model}`);
    this.config = await this.applyHostLlamaSettings(this.config);
```

(`applyHostLlamaSettings` → `applyHostLlamaRuntimeSettings` already no-ops unless the active preset has `ExternalServerEnabled`, so calling it unconditionally is safe and preserves production behavior.)

- [ ] **Step 5: Update the reject helper.** In `src/summary/request-runner.ts` replace the body of `rejectOversizedNonLlamaInput` (lines 239-244), renaming it to match:

```ts
  private rejectOversizedMockInput(config: SiftConfig, backend: string): void {
    const maxInputCharacters = getChunkThresholdCharacters(config) * 4;
    if (isOversizedMockInput(backend, this.inputText.length, maxInputCharacters)) {
      throw new Error(`Error: recieved input of ${this.inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
    }
  }
```

Then update its call site (was line 204) from `this.rejectOversizedNonLlamaInput(this.config, this.backend);` to `this.rejectOversizedMockInput(this.config, this.backend);`.

- [ ] **Step 6: Import `getActiveInferenceBackend`.** In `src/summary/request-runner.ts`, add `getActiveInferenceBackend` to the existing import from `../config/index.js` (the same import that already brings in `getConfiguredModel`, `getConfiguredLlamaBaseUrl`, `loadConfig`).

- [ ] **Step 7: Point the mock summary test at the request override.** In `tests/summary-status-server.test.ts` around line 772, delete `config.Backend = 'mock';` and instead pass `backend: 'mock'` on the summary request object that test issues (the request body / `SummaryRequest` it constructs). If the test drives the HTTP route, add `backend: 'mock'` to the JSON payload; if it constructs a `SummaryRequest` directly, add `backend: 'mock'` to that object.

- [ ] **Step 8: Run tests + typecheck**

Run: `npx tsx --test .\tests\summary-request-runner.test.ts .\tests\summary-status-server.test.ts`
Then: `npm run typecheck`
Expected: PASS — no remaining references to `isOversizedNonLlamaInput` or `rejectOversizedNonLlamaInput`.

- [ ] **Step 9: Commit**

```bash
git add src/summary/request-runner.ts tests/summary-request-runner.test.ts tests/summary-status-server.test.ts
git commit -m "refactor(summary): reduce backend axis to real-vs-mock, default to active engine"
```

---

### Task 4: Source label/probe sites from the active engine

Every remaining read of `config.Backend` is either a reporting label or the llama-provider probe. Replace each with `getActiveInferenceBackend(config)`.

**Files:**
- Modify: `src/status-server/eval.ts:72`
- Modify: `src/command-output/analyzer.ts:114`
- Modify: `src/cli/run-test.ts:38,46,70`
- Modify: `src/install.ts:87,102`

- [ ] **Step 1: `eval.ts`.** Change line 72 to:

```ts
  const backend = request.Backend || getActiveInferenceBackend(config);
```

Add `getActiveInferenceBackend` to the existing `../config/index.js` import in that file.

- [ ] **Step 2: `analyzer.ts`.** Change line 114 to:

```ts
    const backend = request.backend || getActiveInferenceBackend(config);
```

Add `getActiveInferenceBackend` to the existing `../config/index.js` import.

- [ ] **Step 3: `run-test.ts`.** Change the probe (lines 38 and 46) and the label (line 70) to use the active engine:

```ts
  const usesManagedLlama = getActiveInferenceBackend(config) === 'llama';
  const providerStatus = usesManagedLlama
    ? await getLlamaCppProviderStatus(config)
    : {
        Available: true,
        Reachable: true,
        BaseUrl: 'mock://local',
        Error: null,
      };
  const models = usesManagedLlama && providerStatus.Reachable ? await listLlamaCppModels(config) : ['mock-model'];
```

And line 70:

```ts
    Backend: getActiveInferenceBackend(config),
```

Add `getActiveInferenceBackend` to the `../config/index.js` import at the top of `run-test.ts` (currently `getConfigPath, getConfiguredModel, loadConfig`).

- [ ] **Step 4: `install.ts`.** Change the probe (line 87) and label (line 102):

```ts
    if (getActiveInferenceBackend(config) === 'llama') {
      const providerStatus = await getLlamaCppProviderStatus(config);
      providerReachable = Boolean(providerStatus.Reachable);
      models = providerReachable ? await listLlamaCppModels(config) : [];
    }
```

```ts
    Backend: getActiveInferenceBackend(config),
```

Add `getActiveInferenceBackend` to the existing config import in `install.ts`.

- [ ] **Step 5: Typecheck + run touched suites**

Run: `npm run typecheck`
Then: `npx tsx --test .\tests\command-output-analyzer.test.ts .\tests\runtime-cli.test.ts`
Expected: PASS (adjust the file list to whichever suites cover analyzer/run-test/install in this repo; if unsure run `npm test`).

- [ ] **Step 6: Commit**

```bash
git add src/status-server/eval.ts src/command-output/analyzer.ts src/cli/run-test.ts src/install.ts
git commit -m "refactor: source backend label/probe from active engine, not config.Backend"
```

---

### Task 5: Drop the hardcoded top-level `Backend` in the planner request config

`buildPlannerRequestConfig` spreads `getDefaultConfigObject()` and re-sets the top-level `Backend`. Once the field is gone (Task 6) this line will not typecheck; remove it now.

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:386`

- [ ] **Step 1: Delete line 386** (`    Backend: 'llama.cpp',`) from the returned object literal in `buildPlannerRequestConfig`. The per-preset `Backend: options.backend ?? 'llama'` at line 404 stays — that is the real engine axis.

- [ ] **Step 2: Typecheck + planner tests**

Run: `npm run typecheck`
Then: `npx tsx --test .\tests\planner-streaming-timings.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/repo-search/planner-protocol.ts
git commit -m "refactor(repo-search): drop legacy top-level Backend from planner request config"
```

---

### Task 6: Delete the top-level `config.Backend` field

Now that nothing reads it, remove the field from the schema, default, normalization, and the sqlite persistence layer (column + migration).

**Files:**
- Modify: `packages/contracts/src/config.ts:146`
- Modify: `src/config/defaults.ts:77`
- Modify: `src/config/normalization.ts:437-440`
- Modify: `src/status-server/config-store.ts:54,140,174` (row schema, write, read)
- Modify: `src/state/runtime-db.ts:120` (DDL), `:24` (version), and the migration tail (~line 1142)
- Modify: `tests/helpers/runtime-benchmark-repro.ts:32`, `tests/managed-llama-exl3-shared-port.test.ts:98`, `tests/managed-llama-process-exit-sync-guard.test.ts:75,103`, `tests/managed-llama-config-backend-guard.test.ts`
- Test: new `tests/config-no-top-level-backend.test.ts`

- [ ] **Step 1: Write the failing invariant test.** Create `tests/config-no-top-level-backend.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';

test('default config has no top-level Backend field', () => {
  assert.equal('Backend' in getDefaultConfigObject(), false);
});

test('normalization drops any provided top-level Backend', () => {
  const normalized = normalizeConfigObject({ Backend: 'llama.cpp' });
  assert.equal('Backend' in normalized, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\config-no-top-level-backend.test.ts`
Expected: FAIL — the field is still present.

- [ ] **Step 3: Remove from the contract schema.** In `packages/contracts/src/config.ts` line 146, delete `Backend: z.string(),` from the top-level config object schema. The per-preset `Backend: InferenceBackendIdSchema` (line 84) stays.

- [ ] **Step 4: Remove from defaults.** In `src/config/defaults.ts`, delete line 77 (`    Backend: 'llama.cpp',`).

- [ ] **Step 5: Remove the dead normalization remap.** In `src/config/normalization.ts`, delete the block at lines 437-440:

```ts
  const merged = getRecord(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), input ?? {}));
  if (merged.Backend === 'ollama') {
    merged.Backend = 'llama.cpp';
  }
  delete merged.Paths;
```

becomes:

```ts
  const merged = getRecord(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), input ?? {}));
  delete merged.Backend;
  delete merged.Paths;
```

(`delete merged.Backend` drops any legacy field a persisted/user config still carries, satisfying the normalization test.)

- [ ] **Step 6: Remove the sqlite column from the row layer.** In `src/status-server/config-store.ts`:
  - Delete `backend: z.string(),` from `AppConfigRowSchema` (line 54).
  - Delete `backend: String(normalized.Backend || 'llama.cpp'),` from `normalizeConfigToRow` (line 140).
  - Delete `backend,` from the `SELECT` list in `readConfigRow` (line 224).
  - Delete `'backend',` from the `columns` array in `writeConfigRow` (line 257).
  - Delete `Backend: row.backend,` from `rowToConfig` (line 174).

- [ ] **Step 7: Remove the DDL column and add the drop migration.** In `src/state/runtime-db.ts`:
  - Delete `      backend TEXT NOT NULL,` from the `CREATE TABLE IF NOT EXISTS app_config` DDL (line 120).
  - Bump `export const CURRENT_SCHEMA_VERSION = 31;` (line 24) to `32`.
  - Append a version-32 migration immediately after the `currentVersion < 31` block (after line 1142), mirroring the existing `ALTER TABLE app_config DROP COLUMN` pattern used at line 721:

```ts
  if (currentVersion < 32) {
    if (tableHasColumn(database, 'app_config', 'backend')) {
      database.exec('ALTER TABLE app_config DROP COLUMN backend;');
    }
    setSchemaVersion(database, 32);
    currentVersion = 32;
  }
```

- [ ] **Step 8: Purge remaining `config.Backend = '...'` in tests/helpers.** Delete these now-invalid assignments (each is implied by the active llama preset):
  - `tests/helpers/runtime-benchmark-repro.ts:32` — delete `config.Backend = 'llama.cpp';`
  - `tests/managed-llama-exl3-shared-port.test.ts:98` — delete `config.Backend = 'llama.cpp';` (and the stale comment at line 72 referencing `legacy config.Backend='llama.cpp' gate`)
  - `tests/managed-llama-process-exit-sync-guard.test.ts:75,103` — delete both `config.Backend = 'llama.cpp';`

- [ ] **Step 9: Retarget the config-backend guard test.** Replace `tests/managed-llama-config-backend-guard.test.ts` so it guards the new invariants instead of the removed field. It already builds an exl3-active config via `withExl3Active` and asserts `getManagedLlamaConfig` fails loud + `buildRuntimeLaunchSnapshot` behavior — those assertions remain valid and reference no top-level `Backend`. Confirm the file contains no `config.Backend` / `.Backend =` assignment against the top-level object; if it does, remove it. (Per the read, its current body already only touches per-preset `Backend` — leave the assertions, just ensure it compiles after the field removal.)

- [ ] **Step 10: Typecheck (catches every stray reader)**

Run: `npm run typecheck`
Expected: PASS. If the compiler flags any remaining `.Backend` read on a `SiftConfig`, fix that site to `getActiveInferenceBackend(config)` (label) or `getActiveInferenceBackend(config) === 'llama'` (probe) — there should be none left after Tasks 1–5.

- [ ] **Step 11: Run the invariant test + config/db suites**

Run: `npx tsx --test .\tests\config-no-top-level-backend.test.ts .\tests\config.test.ts .\tests\config-schema-contract.test.ts .\tests\contracts-config.test.ts`
Expected: PASS.

- [ ] **Step 12: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/contracts/src/config.ts src/config/defaults.ts src/config/normalization.ts src/status-server/config-store.ts src/state/runtime-db.ts tests/config-no-top-level-backend.test.ts tests/helpers/runtime-benchmark-repro.ts tests/managed-llama-exl3-shared-port.test.ts tests/managed-llama-process-exit-sync-guard.test.ts tests/managed-llama-config-backend-guard.test.ts
git commit -m "feat(config): delete legacy top-level Backend field and its sqlite column"
```

---

### Task 7: Final verification

- [ ] **Step 1: Confirm no top-level `config.Backend` references remain.**

Run: `git grep -nE "\.Backend\b" -- src | grep -viE "preset\.Backend|activePreset\.Backend|target\.Backend|previous\.Backend|request\.Backend|\.Backend ==?= '(llama|exl3)'"`
Expected: only per-preset / request-DTO matches; **no** read of a top-level `SiftConfig.Backend`.

- [ ] **Step 2: Confirm the two seams are independent and explicit.**

Run: `git grep -nE "disableManagedLlamaStartup|=== 'mock'" -- src tests | head`
Expected: lifecycle disable flows through `disableManagedLlamaStartup`; mock routing flows through the request `backend === 'mock'` override — no shared field.

- [ ] **Step 3: Full typecheck + test.**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Final commit if any verification fixups were needed** (otherwise skip).

```bash
git add -A
git commit -m "chore: verification fixups for config.Backend removal"
```

---

## Notes / out of scope (do NOT touch)

- **exl3 summary behavior** is deliberately unchanged. `applyHostLlamaRuntimeSettings` self-gates on `ExternalServerEnabled` and chunking is shared across real backends, so removing the `'llama.cpp'` guards is behavior-neutral. No exl3 fix is folded in.
- **Hardcoded run-log `backend: 'llama.cpp'`** labels in `src/status-server/routes/core.ts:133,178` and `src/status-server/dashboard-runs/artifact-upserts.ts:326` do **not** read `config.Backend` — they are pre-existing independent literals in the dashboard run-log DTO and compile fine after the field removal. Threading the active engine into them requires unrelated `config` plumbing; left untouched.
- **Output DTO label schemas** `Backend: z.string()` in `src/eval-types.ts:31` and `src/summary/types.ts:53` stay `string` — they carry a reporting label whose value now comes from the active engine.
