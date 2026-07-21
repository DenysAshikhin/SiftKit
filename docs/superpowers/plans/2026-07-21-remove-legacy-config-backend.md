# Remove legacy top-level `config.Backend` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy top-level `config.Backend` field and split the two test seams it smuggled (managed-llama lifecycle disable, summary mock route) onto explicit first-class mechanisms, with production behavior unchanged.

**Architecture:** Migrate every consumer off `config.Backend` *first*, keeping the field present so each commit compiles and tests stay green. Delete the field last (schema, default, normalize, strict-payload gate, sqlite column + v32 migration). The lifecycle-disable seam moves to the existing `disableManagedLlamaStartup` flag.

**Tech Stack:** TypeScript (strict, zod-derived types via `z.infer`), better-sqlite3, `node:test` run via `tsx`. Spec: `docs/superpowers/specs/2026-07-21-remove-legacy-config-backend-design.md`.

> ## ⚠️ THE ONE RULE THAT MATTERS
>
> **The summary pipeline's `backend` default MUST stay the literal `'llama.cpp'`.**
>
> It is a *third* axis — summary provider identity — not the engine axis. 16 sites branch on `backend === 'llama.cpp'`: `chunking.ts:194`; `core-runner.ts:185,190,198,206,273,283,379,386,429,560`; `planner/mode.ts:1329`; `provider-invoke.ts:135`; `request-runner.ts:289`. They gate chunk thresholds, planner prompt budget, planner activation, top-level-llama-pass, retry-with-smaller-chunks, slot allocation, and `allowUnsupportedInput`.
>
> Re-defaulting it to `getActiveInferenceBackend(config)` (`'llama'`/`'exl3'`) silently flips **all of them** to the degraded branch. `analyzer.ts:174` and `eval.ts:89` pass their resolved `backend` straight into `summarizeRequest`, so they are on this path too. Normalizing this axis onto the engine axis is a separate project — **out of scope.**

**Commands:**
- Single test file: `npx tsx --test .\tests\<file>.test.ts`
- Typecheck: `npm run typecheck`
- Full suite: `npm test`

**Sequencing rule:** Tasks 1–6 keep `config.Backend` in the schema and only stop *reading* it. Task 7 removes the field. Do them in order.

---

### Task 1: Collapse the lifecycle gate to the engine axis

**Files:**
- Modify: `src/config/getters.ts:30-40`
- Test: `tests/managed-llama-lifecycle-gate.test.ts`

- [ ] **Step 1: Write the failing test.** Replace the whole file body. The third test is genuinely red today: the current gate ANDs in `config.Backend === 'llama.cpp'`, so a `'noop'` value makes it return `false`.

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

// RED until Task 1 Step 3. Removed in Task 7 Step 9 when the field no longer exists.
test('managesManagedLlamaLifecycle: ignores any top-level Backend value', () => {
  const config = withActivePreset((c) => {
    c.Backend = 'noop';
  });
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\managed-llama-lifecycle-gate.test.ts`
Expected: FAIL on "ignores any top-level Backend value" — got `false`, expected `true`.

- [ ] **Step 3: Simplify the gate.** In `src/config/getters.ts`, replace the comment block and function at lines 30-40:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test .\tests\managed-llama-lifecycle-gate.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/config/getters.ts tests/managed-llama-lifecycle-gate.test.ts
git commit -m "refactor(config): key managed-llama lifecycle gate on active engine only"
```

---

### Task 2: Move the lifecycle-disable tests onto `disableManagedLlamaStartup`

The real-status-server tests set `config.Backend='noop'` only to stop the managed-llama process from spawning. The harness already accepts `disableManagedLlamaStartup` (`tests/_runtime-helpers.ts:1222` pushes `--disable-managed-llama-startup`).

**Files:**
- Modify: `tests/runtime-status-server.test.ts` (lines 56, 80, 102, 133, 161)
- Modify: `tests/runtime-status-server.lifecycle.test.ts` (lines 57, 82, 101, 169)
- Modify: `tests/execution-ownership.test.ts:19`

- [ ] **Step 1: Edit each `withRealStatusServer` call.** For every occurrence, delete the `config.Backend = 'noop';` line and add `disableManagedLlamaStartup: true` to the options object (second argument). Example:

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

Apply to all 5 sites in `runtime-status-server.test.ts`, all 4 in `runtime-status-server.lifecycle.test.ts`, and the one in `execution-ownership.test.ts:19`.

- [ ] **Step 2: Run the affected suites**

Run: `npx tsx --test .\tests\runtime-status-server.test.ts .\tests\runtime-status-server.lifecycle.test.ts .\tests\execution-ownership.test.ts`
Expected: PASS — servers still report `running:false`/`status:'false'`, now because startup is disabled by flag.

- [ ] **Step 3: Commit**

```bash
git add tests/runtime-status-server.test.ts tests/runtime-status-server.lifecycle.test.ts tests/execution-ownership.test.ts
git commit -m "test: disable managed-llama startup via flag instead of config.Backend='noop'"
```

---

### Task 3: Give the summary provider its own schema, constant, and resolver

Introduce the two-value domain as a runtime schema, an explicit default constant, and a resolver — so the default can never drift onto the engine axis again. Values and all 16 comparison sites stay exactly as they are.

**Files:**
- Modify: `src/summary/types.ts` (add schema/type/constant/resolver; retype `SummaryRequest.backend`)
- Modify: `src/summary/request-runner.ts:76-79, 195-204, 239-244`
- Modify: `src/eval-types.ts:7`
- Test: Create `tests/summary-provider-default.test.ts`

- [ ] **Step 1: Write the failing regression test.** Create `tests/summary-provider-default.test.ts`. This is the guard for the highest-risk change — it asserts the default keeps the `'llama.cpp'` branch alive downstream.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUMMARY_PROVIDER,
  SummaryProviderIdSchema,
  resolveSummaryProvider,
} from '../src/summary/types.js';
import { shouldRetryWithSmallerChunks } from '../src/summary/chunking.js';
import { isOversizedMockInput } from '../src/summary/request-runner.js';

test('the default summary provider is the real llama.cpp provider', () => {
  assert.equal(DEFAULT_SUMMARY_PROVIDER, 'llama.cpp');
  assert.equal(resolveSummaryProvider(undefined), 'llama.cpp');
  assert.equal(resolveSummaryProvider('mock'), 'mock');
});

test('the provider domain is exactly llama.cpp and mock', () => {
  assert.deepEqual(SummaryProviderIdSchema.options, ['llama.cpp', 'mock']);
  assert.throws(() => SummaryProviderIdSchema.parse('llama'));
  assert.throws(() => SummaryProviderIdSchema.parse('exl3'));
  assert.throws(() => SummaryProviderIdSchema.parse('noop'));
});

test('the default provider keeps the llama.cpp branch in downstream gates', () => {
  // Regression guard: if the default ever becomes 'llama'/'exl3', chunk retry silently dies.
  // The error text must match chunking.ts:202's /llama\.cpp generate failed with HTTP 400\b/iu.
  const retryableError = new Error('llama.cpp generate failed with HTTP 400 (bad request)');
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    backend: resolveSummaryProvider(undefined),
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), true);
  // Same call with an engine-id backend returns false — this is exactly the regression.
  assert.equal(shouldRetryWithSmallerChunks({
    error: retryableError,
    backend: 'llama',
    inputText: 'x'.repeat(4096),
    chunkThreshold: 2048,
  }), false);
});

test('only the mock provider rejects oversized input', () => {
  assert.equal(isOversizedMockInput('mock', 100, 50), true);
  assert.equal(isOversizedMockInput('mock', 10, 50), false);
  assert.equal(isOversizedMockInput('llama.cpp', 100, 50), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\summary-provider-default.test.ts`
Expected: FAIL — `DEFAULT_SUMMARY_PROVIDER`, `SummaryProviderIdSchema`, `resolveSummaryProvider`, and `isOversizedMockInput` do not exist.

- [ ] **Step 3: Add the schema, constant, and resolver.** In `src/summary/types.ts`, add near the top (after the existing `z` import):

```ts
/**
 * Summary provider identity. NOT the inference engine axis: 'llama.cpp' means the
 * real, fully-capable provider (chunking, planner, slots) and is what 16 downstream
 * sites compare against. 'mock' is the test double. Never set this to 'llama'/'exl3'.
 */
export const SummaryProviderIdSchema = z.enum(['llama.cpp', 'mock']);
export type SummaryProviderId = z.infer<typeof SummaryProviderIdSchema>;
export const DEFAULT_SUMMARY_PROVIDER: SummaryProviderId = 'llama.cpp';

export function resolveSummaryProvider(requested: SummaryProviderId | undefined): SummaryProviderId {
  return requested ?? DEFAULT_SUMMARY_PROVIDER;
}
```

- [ ] **Step 4: Retype the request field.** In `src/summary/types.ts`, change line 35 of `SummaryRequest`:

```ts
  backend?: SummaryProviderId;
```

And in `src/eval-types.ts`, change line 7 of the eval request type:

```ts
  Backend?: SummaryProviderId;
```

adding `import type { SummaryProviderId } from './summary/types.js';` to `src/eval-types.ts`.

- [ ] **Step 5: Rename + invert the oversized predicate.** In `src/summary/request-runner.ts`, replace lines 76-79:

```ts
/** Only the mock provider cannot chunk, so mock input above `maxInputCharacters` is rejected. */
export function isOversizedMockInput(backend: string, inputLength: number, maxInputCharacters: number): boolean {
  return backend === 'mock' && inputLength > maxInputCharacters;
}
```

- [ ] **Step 6: Use the resolver and drop the redundant host-settings guard.** In `src/summary/request-runner.ts`, replace lines 195-200:

```ts
    this.backend = resolveSummaryProvider(this.request.backend);
    this.model = this.request.model || getConfiguredModel(this.config);
    logSummaryProgress(`config_done request_id=${this.requestId} backend=${this.backend} model=${this.model}`);
    this.config = await this.applyHostLlamaSettings(this.config);
```

`applyHostLlamaRuntimeSettings` already no-ops unless the active preset has `ExternalServerEnabled`, so calling it unconditionally preserves production behavior. Add `resolveSummaryProvider` to the existing import from `./types.js`.

- [ ] **Step 7: Update the reject helper.** In `src/summary/request-runner.ts`, replace `rejectOversizedNonLlamaInput` (lines 239-244):

```ts
  private rejectOversizedMockInput(config: SiftConfig, backend: string): void {
    const maxInputCharacters = getChunkThresholdCharacters(config) * 4;
    if (isOversizedMockInput(backend, this.inputText.length, maxInputCharacters)) {
      throw new Error(`Error: recieved input of ${this.inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
    }
  }
```

Update its call site (line 204) to `this.rejectOversizedMockInput(this.config, this.backend);`.

- [ ] **Step 8: Run tests + typecheck**

Run: `npx tsx --test .\tests\summary-provider-default.test.ts`
Expected: PASS
Then: `npm run typecheck`
Expected: may fail where callers pass a plain `string` into `backend` — fixed in Task 4. If so, proceed to Task 4 before committing.

- [ ] **Step 9: Commit**

```bash
git add src/summary/types.ts src/summary/request-runner.ts src/eval-types.ts tests/summary-provider-default.test.ts
git commit -m "feat(summary): add SummaryProviderId schema, default constant, and resolver"
```

---

### Task 4: Route every caller through the resolver or the engine axis

Split by whether the value feeds `summarizeRequest`.

**Files:**
- Modify: `src/status-server/eval.ts:72`
- Modify: `src/command-output/analyzer.ts:114`
- Modify: `src/command-output/types.ts:26,53`
- Modify: `src/status-server/route-request-normalizers.ts:23`
- Modify: `src/status-server/routes/core.ts:693`
- Modify: `src/cli/run-test.ts:38,46,70`
- Modify: `src/install.ts:87,102`
- Modify: `src/cli/run-eval.ts:11`, `src/cli/args.ts:25`

- [ ] **Step 1: `eval.ts` — feeds the summary pipeline, keep `'llama.cpp'`.** Change line 72 to:

```ts
  const backend = resolveSummaryProvider(request.Backend);
```

Add `import { resolveSummaryProvider } from '../summary/types.js';`.

- [ ] **Step 2: `analyzer.ts` — feeds the summary pipeline, keep `'llama.cpp'`.** Change line 114 to:

```ts
    const backend = resolveSummaryProvider(request.backend);
```

Add `import { resolveSummaryProvider } from '../summary/types.js';`. Then retype `backend?: string` → `backend?: SummaryProviderId` at `src/command-output/types.ts:26` and `:53`, importing the type from `../summary/types.js`.

- [ ] **Step 3: Validate the HTTP boundary.** In `src/status-server/route-request-normalizers.ts`, change line 23 to `backend: SummaryProviderId | undefined;` (import the type). In `src/status-server/routes/core.ts:693`, replace:

```ts
        backend: reader.optionalString('backend'),
```

with:

```ts
        backend: parseOptionalSummaryProvider(reader.optionalString('backend')),
```

and add this helper near the other normalizers in `src/status-server/routes/core.ts`:

```ts
function parseOptionalSummaryProvider(value: string | undefined): SummaryProviderId | undefined {
  if (value === undefined) return undefined;
  const parsed = SummaryProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unsupported backend '${value}'; expected one of: llama.cpp, mock.`);
  }
  return parsed.data;
}
```

importing `SummaryProviderIdSchema` and `SummaryProviderId` from `../../summary/types.js`.

- [ ] **Step 4: Validate the CLI `--backend` arg.** In `src/cli/args.ts`, change line 25 to `backend?: SummaryProviderId;` (import the type). In `src/cli/run-eval.ts:11`, the value flows into `runEvaluation`; parse it where the arg is read so an invalid `--backend` fails loud:

```ts
    Backend: parsed.backend === undefined ? undefined : SummaryProviderIdSchema.parse(parsed.backend),
```

importing `SummaryProviderIdSchema` from `../summary/types.js`.

- [ ] **Step 5: `run-test.ts` — display label + engine probe.** Replace lines 38-46:

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

Add `getActiveInferenceBackend` to the `../config/index.js` import.

- [ ] **Step 6: `install.ts` — display label + engine probe.** Replace line 87:

```ts
    if (getActiveInferenceBackend(config) === 'llama') {
      const providerStatus = await getLlamaCppProviderStatus(config);
      providerReachable = Boolean(providerStatus.Reachable);
      models = providerReachable ? await listLlamaCppModels(config) : [];
    }
```

And line 102:

```ts
    Backend: getActiveInferenceBackend(config),
```

Add `getActiveInferenceBackend` to the existing config import.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Any remaining error is a caller still passing a bare `string` as `backend` — fix it by parsing through `SummaryProviderIdSchema` or by passing a literal.

- [ ] **Step 8: Run the summary + command-output suites**

Run: `npx tsx --test .\tests\summary-provider-default.test.ts .\tests\runtime-summarize.test.ts .\tests\summary-cli.test.ts .\tests\cli-http-boundary.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/status-server/eval.ts src/command-output/analyzer.ts src/command-output/types.ts src/status-server/route-request-normalizers.ts src/status-server/routes/core.ts src/cli/run-test.ts src/cli/run-eval.ts src/cli/args.ts src/install.ts
git commit -m "refactor: resolve summary provider via resolver, probe/label via active engine"
```

---

### Task 5: Drop the hardcoded top-level `Backend` in the planner request config

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:386`

- [ ] **Step 1: Delete line 386** (`    Backend: 'llama.cpp',`) from the object returned by `buildPlannerRequestConfig`. The per-preset `Backend: options.backend ?? 'llama'` at line 404 stays — that is the real engine axis.

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

### Task 6: Drop `'Backend'` from the strict-config-payload gate

`isStrictConfigPayload` decides whether a `POST /config` body is a full replacement or a partial merge. While `'Backend'` is required, a complete payload from a client that no longer sends the field is silently treated as partial and merged with stale stored state.

**Files:**
- Modify: `src/status-server/routes/core.ts:242-254`
- Test: Create `tests/config-strict-payload.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/config-strict-payload.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { isStrictConfigPayloadForTests } from '../src/status-server/routes/core.js';

test('a complete config payload without top-level Backend is strict', () => {
  const config = getDefaultConfigObject();
  const payload = JSON.parse(JSON.stringify(config));
  delete payload.Backend;
  payload.LlamaCpp = {};
  assert.equal(isStrictConfigPayloadForTests(payload), true);
});

test('a genuinely partial payload is not strict', () => {
  assert.equal(isStrictConfigPayloadForTests({ PolicyMode: 'conservative' }), false);
});
```

- [ ] **Step 2: Export the predicate for testing.** In `src/status-server/routes/core.ts`, add an export alias next to `isStrictConfigPayload`:

```ts
export function isStrictConfigPayloadForTests(value: OptionalJsonValue): boolean {
  return isStrictConfigPayload(value);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test .\tests\config-strict-payload.test.ts`
Expected: FAIL on the first test — `'Backend'` is still in `topLevelRequired`, so a payload without it returns `false`.

- [ ] **Step 4: Remove `'Backend'` from the required list.** In `src/status-server/routes/core.ts`, delete the `'Backend',` entry (line 244) from `topLevelRequired`, leaving:

```ts
  const topLevelRequired = [
    'Version',
    'PolicyMode',
    'RawLogRetention',
    'IncludeRepoFileListing',
    'PromptPrefix',
    'LlamaCpp',
    'Runtime',
    'Thresholds',
    'Interactive',
    'Server',
  ];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test .\tests\config-strict-payload.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/core.ts tests/config-strict-payload.test.ts
git commit -m "fix(status-server): stop requiring legacy Backend for a strict config payload"
```

---

### Task 7: Delete the top-level `config.Backend` field

**Files:**
- Modify: `packages/contracts/src/config.ts:146`
- Modify: `src/config/defaults.ts:77`
- Modify: `src/config/normalization.ts:437-440`
- Modify: `src/status-server/config-store.ts:54,140,174,224,257`
- Modify: `src/state/runtime-db.ts:24,120` + migration tail (~line 1142)
- Modify: `tests/runtime-db-schema-v31.test.ts` (rename to v32)
- Modify: 16 fixture sites (listed in Step 8) + `tests/managed-llama-lifecycle-gate.test.ts`
- Test: Create `tests/config-no-top-level-backend.test.ts`

- [ ] **Step 1: Write the failing invariant + migration tests.** Create `tests/config-no-top-level-backend.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));
const VersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ColumnNameRowSchema
      .parse(db.prepare("SELECT name FROM pragma_table_info('app_config')").all())
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function schemaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return VersionRowSchema.parse(db.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version;
  } finally {
    db.close();
  }
}

test('default config has no top-level Backend field', () => {
  assert.equal('Backend' in getDefaultConfigObject(), false);
});

test('normalization drops any provided top-level Backend', () => {
  const normalized = normalizeConfigObject({ Backend: 'llama.cpp' });
  assert.equal('Backend' in normalized, false);
});

test('a fresh database is created at v32 without the backend column', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 32);
  const dbPath = tempDbPath('sk-v32-fresh-');
  getRuntimeDatabase(dbPath);
  assert.equal(columnNames(dbPath).includes('backend'), false);
  assert.equal(schemaVersion(dbPath), 32);
});
```

- [ ] **Step 2: Add the v31→v32 migration test.** Append to the same file. It seeds a v31 `app_config` that still has `backend TEXT NOT NULL`, then asserts the migration drops it.

```ts
test('v32 migration drops the legacy backend column from an existing v31 database', () => {
  const dbPath = tempDbPath('sk-v32-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 31);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      backend TEXT NOT NULL,
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL,
      include_agents_md INTEGER NOT NULL DEFAULT 1,
      include_repo_file_listing INTEGER NOT NULL DEFAULT 1,
      prompt_prefix TEXT,
      runtime_model TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL,
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL,
      server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
      server_llama_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0,
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{}',
      presets_json TEXT NOT NULL DEFAULT '[]',
      web_search_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );
    INSERT INTO app_config (
      id, version, backend, policy_mode, raw_log_retention,
      thresholds_min_characters_for_summary, thresholds_min_lines_for_summary,
      interactive_enabled, interactive_wrapped_commands_json, interactive_idle_timeout_ms,
      interactive_max_transcript_characters, interactive_transcript_retention,
      presets_json, updated_at_utc
    ) VALUES (
      1, '0.1.0', 'llama.cpp', 'conservative', 1,
      500, 16,
      1, '[]', 900000,
      60000, 1,
      '[]', '2026-07-21T00:00:00.000Z'
    );
  `);
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.equal(columnNames(dbPath).includes('backend'), false);
  assert.equal(schemaVersion(dbPath), 32);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test .\tests\config-no-top-level-backend.test.ts`
Expected: FAIL — field still present, `CURRENT_SCHEMA_VERSION` is 31.

- [ ] **Step 4: Remove from the contract schema.** In `packages/contracts/src/config.ts` line 146, delete `Backend: z.string(),` from the top-level config schema. The per-preset `Backend: InferenceBackendIdSchema` (line 84) stays.

- [ ] **Step 5: Remove from defaults.** In `src/config/defaults.ts`, delete line 77 (`    Backend: 'llama.cpp',`).

- [ ] **Step 6: Remove the dead normalization remap.** In `src/config/normalization.ts`, replace lines 437-441:

```ts
  const merged = getRecord(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), input ?? {}));
  delete merged.Backend;
  delete merged.Paths;
```

- [ ] **Step 7: Remove the sqlite column from the row layer.** In `src/status-server/config-store.ts`:
  - Delete `backend: z.string(),` from `AppConfigRowSchema` (line 54).
  - Delete `backend: String(normalized.Backend || 'llama.cpp'),` from `normalizeConfigToRow` (line 140).
  - Delete `Backend: row.backend,` from `rowToConfig` (line 174).
  - Delete `      backend,` from the `SELECT` list in `readConfigRow` (line 224).
  - Delete `    'backend',` from the `columns` array in `writeConfigRow` (line 257).

- [ ] **Step 8: Remove the DDL column, bump the version, add the drop migration.** In `src/state/runtime-db.ts`:
  - Delete `      backend TEXT NOT NULL,` from the `CREATE TABLE IF NOT EXISTS app_config` DDL (line 120).
  - Change line 24 to `export const CURRENT_SCHEMA_VERSION = 32;`.
  - Insert immediately after the `currentVersion < 31` block (after line 1142):

```ts
  if (currentVersion < 32) {
    if (tableHasColumn(database, 'app_config', 'backend')) {
      database.exec('ALTER TABLE app_config DROP COLUMN backend;');
    }
    setSchemaVersion(database, 32);
    currentVersion = 32;
  }
```

- [ ] **Step 9: Purge every remaining top-level `Backend` in tests.** Delete the `Backend: '...'` property (or `config.Backend = '...'` assignment) at each site:

Fixtures: `tests/cli-http-boundary.test.ts:73,129`; `tests/dashboard-managed-presets.test.ts:104`; `tests/dashboard-presets.test.ts:34`; `tests/helpers/runtime-config.ts:83`; `tests/host-sync.test.ts:24`; `tests/runtime-provider-llama.test.ts:32`; `tests/runtime-results-db.test.ts:39,57`; `tests/runtime-status-server.lifecycle.test.ts:179`; `tests/runtime-summarize.test.ts:462,809`; `tests/summary-cli.test.ts:33`; `tests/_test-helpers.ts:111,294,350`; `tests/config.test.ts:275`.

Assignments: `tests/helpers/runtime-benchmark-repro.ts:32`; `tests/managed-llama-exl3-shared-port.test.ts:98` (also delete the stale comment at line 72 mentioning the legacy gate); `tests/managed-llama-process-exit-sync-guard.test.ts:75,103`.

Lifecycle gate test: delete the third test ("ignores any top-level Backend value") added in Task 1 — the field no longer exists, so the scenario is gone. The first two tests stay.

**Where the removed fixture value was `'mock'` and that fixture drives a summary run** (`cli-http-boundary.test.ts`, `runtime-results-db.test.ts`, `runtime-summarize.test.ts`, `summary-cli.test.ts`, `_test-helpers.ts:294,350`), pass `backend: 'mock'` on the summary **request** instead, so the mock route still engages.

- [ ] **Step 10: Retarget the schema-version test.** Rename `tests/runtime-db-schema-v31.test.ts` → `tests/runtime-db-schema-v32.test.ts`, change the assertion at line 31 to `assert.equal(CURRENT_SCHEMA_VERSION, 32);`, and update the test titles from v31 to v32. Its existing `inference_json` / `server_exl3_json` assertions stay valid.

- [ ] **Step 11: Confirm the guard test needs no change.**

Run: `git grep -nE "^\s*(config|c)\.Backend|^\s*Backend:" -- tests/managed-llama-config-backend-guard.test.ts`
Expected: no output — the file only touches per-preset `Backend`, so it compiles unchanged.

- [ ] **Step 12: Typecheck (catches every stray reader)**

Run: `npm run typecheck`
Expected: PASS. Any remaining `.Backend` error on a `SiftConfig` is a missed site — fix per Task 4's rules (summary-feeding → `resolveSummaryProvider`, display → `getActiveInferenceBackend`).

- [ ] **Step 13: Run the new + config/db suites**

Run: `npx tsx --test .\tests\config-no-top-level-backend.test.ts .\tests\runtime-db-schema-v32.test.ts .\tests\config.test.ts .\tests\config-schema-contract.test.ts .\tests\contracts-config.test.ts .\tests\config-strict-payload.test.ts`
Expected: PASS.

- [ ] **Step 14: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(config): delete legacy top-level Backend field, column, and v32 migration"
```

---

### Task 8: Final verification

- [ ] **Step 1: No top-level `config.Backend` readers remain.**

Run: `git grep -nE "\.Backend\b" -- src | grep -viE "preset\.Backend|activePreset\.Backend|target\.Backend|previous\.Backend|request\.Backend|\.Backend [!=]==? '(llama|exl3)'"`
Expected: no read of a top-level `SiftConfig.Backend`.

- [ ] **Step 2: The summary provider default is intact — the critical regression check.**

Run: `git grep -nE "backend [!=]==? 'llama\.cpp'" -- src | wc -l`
Expected: `16` — unchanged from before this work.

Run: `npx tsx --test .\tests\summary-provider-default.test.ts`
Expected: PASS.

- [ ] **Step 3: The two seams are independent and explicit.**

Run: `git grep -nE "disableManagedLlamaStartup|=== 'mock'" -- src tests | head`
Expected: lifecycle disable flows through `disableManagedLlamaStartup`; mock routing flows through the request `backend === 'mock'` override — no shared field.

- [ ] **Step 4: Full typecheck + test.**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

## Out of scope (do NOT touch)

- **The 16 `backend === 'llama.cpp'` summary sites.** Normalizing the summary provider axis onto the engine axis requires deciding exl3 semantics for chunking, planner activation, prompt budgeting, and slot allocation. Separate project.
- **exl3 summary behavior** is unchanged. `applyHostLlamaRuntimeSettings` self-gates on `ExternalServerEnabled`, and oversized rejection only ever fired for mock — so removing those two `'llama.cpp'` guards is behavior-neutral.
- **Hardcoded run-log labels** `backend: 'llama.cpp'` in `src/status-server/routes/core.ts:133,178` and `src/status-server/dashboard-runs/artifact-upserts.ts:326` do not read `config.Backend` and compile fine after removal. Threading the active engine in requires unrelated `config` plumbing.
- **Output DTO label schemas** `Backend: z.string()` in `src/eval-types.ts:31` and `src/summary/types.ts:53` stay `string`.
