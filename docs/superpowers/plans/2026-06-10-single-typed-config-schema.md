# Single Typed Config Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `SiftConfig` the single typed config contract for CLI/client, status server, and dashboard, and remove `Dict` from config boundaries called out by `ARCHITECTURE-REVIEW.md` F3/F10.

**Architecture:** Keep the shared contract in `src/config/*`: `types.ts` owns the shape, `defaults.ts` owns defaults, and `normalization.ts` owns parsing/repair into `SiftConfig`. The status server imports that contract instead of defining untyped defaults, and the dashboard aliases its config-facing types to the same source contract instead of mirroring the schema.

**Tech Stack:** TypeScript strict mode, Node test runner via repo scripts, dashboard TypeScript/Vite typecheck.

---

## Context

`ARCHITECTURE-REVIEW.md` identifies:
- F3: `src/lib/types.ts` exports `Dict = Record<string, unknown>` and config/chat/server surfaces overuse it, especially `src/status-server/config-store.ts`.
- F10: config exists as client typed config, server untyped defaults, dashboard mirrored types, and runtime DB flattening.
- Priority 1: "Single typed config schema shared by client/server/dashboard; kill `Dict` at the boundaries (F3, F10)."

This plan targets config boundaries only. Other `Dict` uses for arbitrary tool payloads, DB artifact JSON, or non-config chat/run records are outside this slice unless a config value crosses that boundary.

## File Map

- Modify `src/config/types.ts`
  - Add missing live top-level config fields: `IncludeAgentsMd`, `IncludeRepoFileListing`, `OperationModeAllowedTools`, `Presets`.
  - Reuse `OperationModeAllowedTools` and `SiftPreset` from `src/presets.ts`.
  - Export the config-facing aliases needed by dashboard code.
- Modify `src/config/defaults.ts`
  - Make `getDefaultConfigObject()` the only default config source.
  - Include every live field currently produced by `src/status-server/config-store.ts:getDefaultConfig()`.
- Modify `src/config/normalization.ts`
  - Move typed normalization from `src/status-server/config-store.ts`.
  - Return `SiftConfig`, never `Dict`.
  - Keep `unknown` only at JSON/input boundaries and immediately normalize into typed fields.
- Modify `src/config/getters.ts`
  - Keep active preset/runtime getters typed on `SiftConfig`.
  - Add small typed getters currently duplicated in `config-store.ts` if needed by the server.
- Modify `src/status-server/config-store.ts`
  - Delete duplicated config constants/defaults/web-search normalization.
  - Import `getDefaultConfigObject`, `normalizeConfig`, `toPersistedConfigObject`, and config getters from `src/config/*`.
  - Change `getDefaultConfig`, `readConfig`, `writeConfig`, row conversion, `buildRuntimeLaunchSnapshot`, `getRuntimeLlamaCpp`, and `getActiveManagedLlamaPreset` to typed config signatures.
- Modify `src/status-server/routes/core.ts`
  - Type `/config` GET/PUT handling through `SiftConfig`.
  - Keep parsed request bodies as `unknown` until normalized.
- Modify config-consuming status modules as required by type errors:
  - `src/status-server/managed-llama.ts`
  - `src/status-server/routes/chat.ts`
  - `src/status-server/chat.ts`
  - `src/status-server/chat-prompt-context.ts`
  - `src/status-server/preset-runner.ts`
  - `src/status-server/server-types.ts`
- Modify `dashboard/src/types.d.ts`
  - Replace duplicated `DashboardConfig` schema with aliases to shared config types.
- Modify `dashboard/tsconfig.json`
  - Allow dashboard typechecking to resolve shared type-only imports from `../src/config`, `../src/web-search`, and `../src/presets`.
- Modify dashboard config consumers only where aliases expose stricter types:
  - `dashboard/src/api.ts`
  - `dashboard/src/App.tsx`
  - `dashboard/src/tabs/SettingsTab.tsx`
  - `dashboard/src/managed-llama-presets.ts`
  - `dashboard/src/settings-runtime.ts`
  - `dashboard/src/dashboard-presets.ts`
- Add/modify tests:
  - `tests/config-schema-contract.test.ts`
  - `tests/config-normalization.test.ts`
  - `tests/config.test.ts`
  - `tests/runtime-loadconfig.test.ts`
  - `tests/runtime-status-server.test.ts`
  - `tests/settings-runtime.test.ts`
  - `tests/settings-sections.test.ts`
  - `dashboard/tests/tab-components.test.tsx` if dashboard config rendering needs fixture updates.

---

### Task 1: Add Failing Contract Tests For Single Config Source

**Files:**
- Create: `tests/config-schema-contract.test.ts`
- Modify: `tests/config-normalization.test.ts`

- [ ] **Step 1: Write a source-level regression that fails on current duplicated config boundaries**

Create `tests/config-schema-contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { SiftConfig } from '../src/config/types.ts';
import {
  getDefaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
} from '../src/status-server/config-store.ts';

test('status-server config-store exposes the shared typed config contract', () => {
  const defaultConfig: SiftConfig = getDefaultConfig();
  const normalizedConfig: SiftConfig = normalizeConfig(defaultConfig);
  const sharedDefault: SiftConfig = getDefaultConfigObject();

  assert.equal(defaultConfig.Version, sharedDefault.Version);
  assert.equal(defaultConfig.Server.LlamaCpp.ActivePresetId, sharedDefault.Server.LlamaCpp.ActivePresetId);
  assert.equal(normalizedConfig.WebSearch?.ProviderOrder[0], 'tavily');

  assert.equal(typeof readConfig, 'function');
  assert.equal(typeof writeConfig, 'function');
});

test('config-store does not define untyped config defaults or Dict signatures', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');

  assert.doesNotMatch(source, /import type \{ Dict \} from ['"]\.\.\/lib\/types\.js['"]/u);
  assert.doesNotMatch(source, /const DEFAULT_MANAGED_LLAMA_PRESET: Dict/u);
  assert.doesNotMatch(source, /export function getDefaultConfig\(\): Dict/u);
  assert.doesNotMatch(source, /export function normalizeConfig\(input: unknown\): Dict/u);
  assert.doesNotMatch(source, /export function readConfig\(configPath: string\): Dict/u);
  assert.doesNotMatch(source, /export function writeConfig\(configPath: string, config: Dict\): void/u);
});

test('dashboard config type is an alias of shared SiftConfig', () => {
  const source = fs.readFileSync('dashboard/src/types.d.ts', 'utf8');

  assert.match(source, /import type \{[\s\S]*SiftConfig[\s\S]*\} from ['"]\.\.\/\.\.\/src\/config\/types['"]/u);
  assert.match(source, /export type DashboardConfig = SiftConfig;/u);
  assert.doesNotMatch(source, /export type DashboardConfig = \{/u);
});
```

- [ ] **Step 2: Add normalization assertions for live fields missing from `SiftConfig`**

Append to `tests/config-normalization.test.ts`:

```ts
test('normalizeConfig returns the typed live config fields used by server and dashboard', () => {
  const normalized = normalizeConfig({
    IncludeAgentsMd: false,
    IncludeRepoFileListing: false,
    OperationModeAllowedTools: {
      summary: ['find_text'],
      'read-only': ['repo_rg'],
      full: [],
    },
    Presets: [{
      id: 'custom',
      label: 'Custom',
      description: 'Custom preset',
      presetKind: 'chat',
      operationMode: 'summary',
      promptPrefix: 'prefix',
      allowedTools: ['find_text'],
      surfaces: ['web'],
      useForSummary: false,
      builtin: false,
      deletable: true,
      includeAgentsMd: false,
      includeRepoFileListing: false,
      repoRootRequired: false,
      maxTurns: 4,
    }],
  });

  assert.equal(normalized.IncludeAgentsMd, false);
  assert.equal(normalized.IncludeRepoFileListing, false);
  assert.deepEqual(normalized.OperationModeAllowedTools.summary, ['find_text']);
  assert.equal(normalized.Presets[0]?.id, 'custom');
});
```

- [ ] **Step 3: Run the new focused tests and confirm they fail**

Run:

```powershell
npm test -- tests/config-schema-contract.test.ts tests/config-normalization.test.ts
```

Expected:
- `config-store does not define untyped config defaults or Dict signatures` fails.
- Typecheck may fail because `SiftConfig` lacks fields used by the new test.

- [ ] **Step 4: Commit the failing tests**

```powershell
git add tests/config-schema-contract.test.ts tests/config-normalization.test.ts
git commit -m "test: pin shared typed config schema contract"
```

---

### Task 2: Complete The Shared `SiftConfig` Type

**Files:**
- Modify: `src/config/types.ts`
- Test: `tests/config-schema-contract.test.ts`

- [ ] **Step 1: Add the missing top-level typed fields**

In `src/config/types.ts`, import preset types and add these fields to `SiftConfig`:

```ts
import type { OperationModeAllowedTools, SiftPreset } from '../presets.js';
```

```ts
export type SiftConfig = {
  Version: string;
  Backend: string;
  PolicyMode: string;
  RawLogRetention: boolean;
  IncludeAgentsMd: boolean;
  IncludeRepoFileListing: boolean;
  PromptPrefix?: string | null;
  Runtime: {
    Model: string | null;
    LlamaCpp: RuntimeLlamaCppConfig;
  };
  Thresholds: {
    MinCharactersForSummary: number;
    MinLinesForSummary: number;
  };
  Interactive: {
    Enabled: boolean;
    WrappedCommands: string[];
    IdleTimeoutMs: number;
    MaxTranscriptCharacters: number;
    TranscriptRetention: boolean;
  };
  Server: {
    LlamaCpp: ServerLlamaCppConfig;
  };
  OperationModeAllowedTools: OperationModeAllowedTools;
  Presets: SiftPreset[];
  WebSearch: WebSearchConfig;
  Paths?: {
    RuntimeRoot: string;
    Logs: string;
    EvalFixtures: string;
    EvalResults: string;
  };
  Effective?: {
    ConfigAuthoritative: boolean;
    RuntimeConfigReady: boolean;
    MissingRuntimeFields: string[];
    BudgetSource: string;
    NumCtx: number | null;
    InputCharactersPerContextToken: number;
    ObservedTelemetrySeen: boolean;
    ObservedTelemetryUpdatedAtUtc: string | null;
    MaxInputCharacters: number | null;
    ChunkThresholdCharacters: number | null;
  };
};
```

- [ ] **Step 2: Export dashboard-facing aliases from the shared type module**

Add these aliases near the existing config exports:

```ts
export type DashboardConfig = SiftConfig;
export type DashboardManagedLlamaPreset = ServerManagedLlamaPreset;
export type DashboardLlamaCppConfig = ServerLlamaCppConfig;
export type DashboardOperationModeAllowedTools = OperationModeAllowedTools;
export type DashboardPreset = SiftPreset;
```

- [ ] **Step 3: Run typecheck and confirm only downstream implementation errors remain**

Run:

```powershell
npm run typecheck
```

Expected:
- `SiftConfig` missing-field errors are gone.
- Remaining failures identify server/dashboard files still expecting old local shapes.

- [ ] **Step 4: Commit the shared type expansion**

```powershell
git add src/config/types.ts
git commit -m "feat: type the full shared config schema"
```

---

### Task 3: Make Typed Defaults The Only Defaults

**Files:**
- Modify: `src/config/defaults.ts`
- Modify: `src/status-server/config-store.ts`
- Test: `tests/config-schema-contract.test.ts`

- [ ] **Step 1: Add the live server-only fields to `getDefaultConfigObject()`**

In `src/config/defaults.ts`, import preset defaults:

```ts
import {
  getDefaultOperationModeAllowedTools,
  normalizePresets,
} from '../presets.js';
```

Add these fields to the returned object:

```ts
IncludeAgentsMd: true,
IncludeRepoFileListing: true,
OperationModeAllowedTools: getDefaultOperationModeAllowedTools(),
Presets: normalizePresets([]),
```

- [ ] **Step 2: Replace `config-store.ts:getDefaultConfig()` with the shared default**

In `src/status-server/config-store.ts`, import:

```ts
import { getDefaultConfigObject } from '../config/defaults.js';
import type { SiftConfig } from '../config/types.js';
```

Replace the current `getDefaultConfig()` implementation with:

```ts
export function getDefaultConfig(): SiftConfig {
  return getDefaultConfigObject();
}
```

- [ ] **Step 3: Delete duplicated config constants from `config-store.ts`**

Remove:
- `DEFAULT_LLAMA_MODEL`
- `DEFAULT_LLAMA_BASE_URL`
- `DEFAULT_LLAMA_MODEL_PATH`
- `DEFAULT_LLAMA_EXECUTABLE_PATH`
- `DEFAULT_LLAMA_BIND_HOST`
- `DEFAULT_LLAMA_PORT`
- `DEFAULT_LLAMA_GPU_LAYERS`
- `DEFAULT_LLAMA_BATCH_SIZE`
- `DEFAULT_LLAMA_UBATCH_SIZE`
- `DEFAULT_LLAMA_CACHE_RAM`
- `DEFAULT_LLAMA_KV_CACHE_QUANTIZATION`
- `DEFAULT_LLAMA_REASONING_BUDGET`
- `DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE`
- `DEFAULT_LLAMA_SLEEP_IDLE_SECONDS`
- `DEFAULT_MANAGED_LLAMA_PRESET`
- `DEFAULT_WEB_SEARCH_CONFIG`
- `WEB_SEARCH_PROVIDER_IDS`
- `MANAGED_LLAMA_SPECULATIVE_TYPES`

If other modules import these names from `config-store.ts`, update those imports to `src/config/constants.ts`, `src/config/defaults.ts`, or `src/web-search/types.ts`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- tests/config-schema-contract.test.ts tests/config-normalization.test.ts
```

Expected:
- Default-source equality assertions pass.
- Source-level `Dict` assertions may still fail until later tasks.

- [ ] **Step 5: Commit typed defaults**

```powershell
git add src/config/defaults.ts src/status-server/config-store.ts tests/config-schema-contract.test.ts
git commit -m "feat: use shared typed config defaults"
```

---

### Task 4: Move Config Normalization Into `src/config/normalization.ts`

**Files:**
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/config-store.ts`
- Test: `tests/config-normalization.test.ts`

- [ ] **Step 1: Move the typed normalizers**

Move these responsibilities from `src/status-server/config-store.ts` into `src/config/normalization.ts`:
- `mergeConfig`
- `normalizeConfig`
- `normalizeWebSearchConfig`
- managed llama preset normalization
- provider order normalization
- integer/number/string field coercion used by config normalization

Use these signatures:

```ts
export function mergeConfig(baseValue: unknown, patchValue: unknown): unknown
export function normalizeConfig(input: unknown): { config: SiftConfig; info: NormalizationInfo }
export function normalizeConfigObject(input: unknown): SiftConfig
export function normalizeWebSearchConfig(value: unknown): WebSearchConfig
export function normalizeManagedLlamaPresetArray(value: unknown, fallbackSource: unknown): ServerManagedLlamaPreset[]
```

Implementation rule:
- `unknown` is allowed only as the incoming JSON/raw object type.
- Every exported result is typed.
- Do not return `Record<string, unknown>` or `Dict` from config normalizers.

- [ ] **Step 2: Preserve existing `normalizeConfig` call sites**

`src/config/config-service.ts` already expects:

```ts
normalizeConfig(config).config
```

Keep that API intact in `src/config/normalization.ts`.

In `src/status-server/config-store.ts`, expose a compatibility-free typed wrapper for existing server imports:

```ts
export function normalizeConfig(input: unknown): SiftConfig {
  return normalizeConfigObject(input);
}
```

This is not legacy compatibility; it is the status-server public API continuing to expose a typed config function.

- [ ] **Step 3: Update imports**

In `src/status-server/config-store.ts`:

```ts
import {
  mergeConfig,
  normalizeConfigObject,
  normalizeManagedLlamaPresetArray,
  normalizeWebSearchConfig,
} from '../config/normalization.js';
```

Remove local definitions that now live in `src/config/normalization.ts`.

- [ ] **Step 4: Run focused normalization tests**

Run:

```powershell
npm test -- tests/config-normalization.test.ts tests/config-schema-contract.test.ts
```

Expected:
- WebSearch bounds tests still pass.
- Managed llama speculative type tests still pass.
- Source-level `Dict` assertions for `normalizeConfig` pass.

- [ ] **Step 5: Commit shared normalization**

```powershell
git add src/config/normalization.ts src/status-server/config-store.ts tests/config-normalization.test.ts
git commit -m "feat: share typed config normalization"
```

---

### Task 5: Type The Status Server Config Store Boundary

**Files:**
- Modify: `src/status-server/config-store.ts`
- Test: `tests/config-schema-contract.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/runtime-loadconfig.test.ts`

- [ ] **Step 1: Type row conversion functions**

Change signatures:

```ts
function normalizeConfigToRow(config: SiftConfig): AppConfigRow
function rowToConfig(row: AppConfigRow): SiftConfig
function parseWebSearchConfig(text: unknown): WebSearchConfig
function parseManagedLlamaPresetArray(text: unknown): ServerManagedLlamaPreset[]
```

Use typed locals:

```ts
const normalized = normalizeConfigObject(config);
const runtime = normalized.Runtime;
const thresholds = normalized.Thresholds;
const interactive = normalized.Interactive;
const serverLlama = normalized.Server.LlamaCpp;
```

- [ ] **Step 2: Type read/write functions**

Change signatures:

```ts
export function readConfig(configPath: string): SiftConfig
export function writeConfig(configPath: string, config: SiftConfig): void
```

When applying `RuntimeLaunchSnapshot`, assign through typed fields:

```ts
const runtime = config.Runtime;
runtime.LlamaCpp = snapshot.LlamaCpp;
```

- [ ] **Step 3: Type getter exports**

Either import typed getters from `src/config/getters.ts` or update local signatures:

```ts
export function getRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig
export function getActiveManagedLlamaPreset(config: SiftConfig): ServerManagedLlamaPreset
```

If `getActiveManagedLlamaPreset` must always return a value, normalize first and return the active preset or the first default preset.

- [ ] **Step 4: Type runtime launch snapshot input**

Change:

```ts
export function buildRuntimeLaunchSnapshot(config: SiftConfig): RuntimeLaunchSnapshot
```

Use typed `config.Runtime.LlamaCpp` and `getActiveManagedLlamaPreset(config)`.

- [ ] **Step 5: Remove `Dict` import from `config-store.ts`**

After all config-store functions are typed:

```ts
import type { Dict } from '../lib/types.js';
```

must be gone.

- [ ] **Step 6: Run focused persistence tests**

Run:

```powershell
npm test -- tests/config-schema-contract.test.ts tests/config.test.ts tests/runtime-loadconfig.test.ts
```

Expected:
- Config service round trips still pass.
- Dashboard-sent `ExecutablePath` and `ModelPath` still persist.
- `config-store does not define untyped config defaults or Dict signatures` passes.

- [ ] **Step 7: Commit typed config store boundary**

```powershell
git add src/status-server/config-store.ts tests/config-schema-contract.test.ts
git commit -m "feat: type status-server config store"
```

---

### Task 6: Update Status Server `/config` And Config Consumers

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify as required: `src/status-server/server-types.ts`
- Modify as required: `src/status-server/managed-llama.ts`
- Modify as required: `src/status-server/routes/chat.ts`
- Modify as required: `src/status-server/chat.ts`
- Modify as required: `src/status-server/chat-prompt-context.ts`
- Modify as required: `src/status-server/preset-runner.ts`
- Test: `tests/runtime-status-server.test.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Parse `/config` PUT body as `unknown`, normalize once**

In `src/status-server/routes/core.ts`, keep the raw body untyped until normalization:

```ts
const parsedBody = JSON.parse(await readBody(req) || '{}') as unknown;
const nextConfig = skipReady
  ? normalizeConfig(parsedBody)
  : normalizeConfig(mergeConfig(baseConfig, parsedBody));
writeConfig(getConfigPath(), nextConfig);
sendJson(res, 200, nextConfig);
```

Do not cast the parsed body to `Dict`.

- [ ] **Step 2: Type `ServerContext` config-facing methods**

In `src/status-server/server-types.ts`, replace config-returning `Dict` signatures with `SiftConfig`:

```ts
import type { SiftConfig } from '../config/types.js';

readConfig(): SiftConfig;
writeConfig(config: SiftConfig): void;
ensureManagedLlamaReady(options?: EnsureManagedLlamaOptions): Promise<SiftConfig>;
```

Keep non-config artifact payloads as their existing JSON/object types.

- [ ] **Step 3: Replace config `Dict` parameters with `SiftConfig`**

Update config-only parameters:

```ts
buildContextUsage(config: SiftConfig | null | undefined, session: ChatSession)
resolveActiveChatModel(config: SiftConfig | null | undefined, session: ChatSession)
buildChatSystemContent(config: SiftConfig, session: ChatSession, options)
buildChatPromptContext(config: SiftConfig, session: ChatSession, options)
resolveEffectiveAgentsMd(config: Pick<SiftConfig, 'IncludeAgentsMd'>, preset)
resolveEffectiveRepoFileListing(config: Pick<SiftConfig, 'IncludeRepoFileListing'>, preset)
```

Do not change unrelated `Dict` payloads in these files during this task.

- [ ] **Step 4: Use shared getters instead of local nested casts**

Where code reads:

```ts
const runtimeCfg = (currentConfig.Runtime as Dict | undefined) ?? {};
const runtimeLlamaCfg = (runtimeCfg.LlamaCpp as Dict | undefined) ?? {};
```

replace with:

```ts
const runtimeLlamaCfg = currentConfig.Runtime.LlamaCpp;
```

Where code reads:

```ts
(currentConfig.WebSearch as Dict | undefined)?.EnabledDefault === true
```

replace with:

```ts
currentConfig.WebSearch.EnabledDefault === true
```

- [ ] **Step 5: Run focused server tests**

Run:

```powershell
npm test -- tests/runtime-status-server.test.ts tests/status-server-chat.test.ts tests/config-schema-contract.test.ts
```

Expected:
- `/config` GET/PUT still round trips.
- Chat prompt/context tests still pass.
- No typecheck errors from status config consumers.

- [ ] **Step 6: Commit server config consumer typing**

```powershell
git add src/status-server/routes/core.ts src/status-server/server-types.ts src/status-server/managed-llama.ts src/status-server/routes/chat.ts src/status-server/chat.ts src/status-server/chat-prompt-context.ts src/status-server/preset-runner.ts
git commit -m "feat: type status-server config consumers"
```

---

### Task 7: Replace Dashboard Mirrored Config Types With Shared Aliases

**Files:**
- Modify: `dashboard/src/types.d.ts`
- Modify: `dashboard/tsconfig.json`
- Modify as required: `dashboard/src/api.ts`
- Modify as required: `dashboard/src/App.tsx`
- Modify as required: `dashboard/src/tabs/SettingsTab.tsx`
- Modify as required: `dashboard/src/managed-llama-presets.ts`
- Modify as required: `dashboard/src/settings-runtime.ts`
- Modify as required: `dashboard/src/dashboard-presets.ts`
- Test: `tests/settings-runtime.test.ts`
- Test: `tests/settings-sections.test.ts`
- Test as required: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Import shared config aliases in `dashboard/src/types.d.ts`**

At the top of `dashboard/src/types.d.ts`:

```ts
import type {
  DashboardConfig,
  DashboardLlamaCppConfig,
  DashboardManagedLlamaPreset,
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  ManagedLlamaKvCacheQuantization,
  ManagedLlamaSpeculativeType,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
} from '../../src/config/types';
```

- [ ] **Step 2: Delete duplicated dashboard config object definitions**

Remove local definitions for:
- `DashboardConfig`
- `DashboardLlamaCppConfig`
- `DashboardManagedLlamaPreset`
- `DashboardOperationModeAllowedTools`
- `DashboardPreset` if it mirrors `SiftPreset`
- local web-search config/provider settings if they mirror shared config types

Re-export aliases:

```ts
export type {
  DashboardConfig,
  DashboardLlamaCppConfig,
  DashboardManagedLlamaPreset,
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  ManagedLlamaKvCacheQuantization,
  ManagedLlamaSpeculativeType,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
};
```

- [ ] **Step 3: Allow dashboard typecheck to follow shared type-only imports**

In `dashboard/tsconfig.json`, update include:

```json
"include": [
  "src",
  "../src/config/**/*.ts",
  "../src/web-search/types.ts",
  "../src/presets.ts"
]
```

- [ ] **Step 4: Update dashboard code for stricter non-optional config fields**

If typecheck reports optional access made obsolete by the shared type, simplify:

```ts
const web = dashboardConfig.WebSearch;
const presets = dashboardConfig.Presets;
const activePresetId = dashboardConfig.Server.LlamaCpp.ActivePresetId;
```

Do not add fallback shims for missing fields; the server normalizer must supply the typed shape.

- [ ] **Step 5: Run dashboard-focused checks**

Run:

```powershell
npm run typecheck
npm test -- tests/settings-runtime.test.ts tests/settings-sections.test.ts dashboard/tests/tab-components.test.tsx
```

Expected:
- Dashboard typecheck passes through shared type imports.
- Settings UI tests still pass.

- [ ] **Step 6: Commit dashboard shared types**

```powershell
git add dashboard/src/types.d.ts dashboard/tsconfig.json dashboard/src/api.ts dashboard/src/App.tsx dashboard/src/tabs/SettingsTab.tsx dashboard/src/managed-llama-presets.ts dashboard/src/settings-runtime.ts dashboard/src/dashboard-presets.ts tests/settings-runtime.test.ts tests/settings-sections.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "feat: share config types with dashboard"
```

---

### Task 8: Add Final Guards Against Config Schema Drift

**Files:**
- Modify: `tests/config-schema-contract.test.ts`
- Modify: `tests/benchmark-spec-settings.test.ts` if package/script guard needs extension

- [ ] **Step 1: Add source guards for future drift**

Append to `tests/config-schema-contract.test.ts`:

```ts
test('typed default config is live and imported by the status server', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');
  assert.match(source, /getDefaultConfigObject/u);
  assert.doesNotMatch(source, /Version: ['"]0\.1\.0['"][\s\S]*Backend: ['"]llama\.cpp['"]/u);
});

test('dashboard does not mirror the config schema', () => {
  const source = fs.readFileSync('dashboard/src/types.d.ts', 'utf8');
  assert.doesNotMatch(source, /Server:\s*\{[\s\S]*LlamaCpp:\s*\{/u);
  assert.doesNotMatch(source, /WebSearch:\s*\{/u);
  assert.match(source, /export type DashboardConfig = SiftConfig;|export type \{[\s\S]*DashboardConfig[\s\S]*\}/u);
});

test('config-store keeps Dict out of the config boundary', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');
  const forbidden = [
    /: Dict\b/u,
    /as Dict\b/u,
    /Dict\[\]/u,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});
```

- [ ] **Step 2: Add a grep gate command to the plan execution notes**

Use this command during validation:

```powershell
rg -n "DashboardConfig = \\{|getDefaultConfigObject\\(|getDefaultConfig\\(\\): Dict|normalizeConfig\\(input: unknown\\): Dict|readConfig\\(configPath: string\\): Dict|writeConfig\\(configPath: string, config: Dict\\)|import type \\{ Dict \\} from '../lib/types.js'" src/config src/status-server/config-store.ts dashboard/src/types.d.ts tests
```

Expected:
- Only allowed hit for `getDefaultConfigObject(` is its definition in `src/config/defaults.ts` and import/use sites.
- No config-store `Dict` hits.
- No dashboard `DashboardConfig = {` hit.

- [ ] **Step 3: Run focused guard tests**

Run:

```powershell
npm test -- tests/config-schema-contract.test.ts
```

Expected:
- All guard tests pass.

- [ ] **Step 4: Commit drift guards**

```powershell
git add tests/config-schema-contract.test.ts tests/benchmark-spec-settings.test.ts
git commit -m "test: guard shared config schema drift"
```

---

### Task 9: Full Validation And Cleanup

**Files:**
- All files changed above.

- [ ] **Step 1: Run the final grep gates**

Run:

```powershell
rg -n "import type \\{ Dict \\} from '../lib/types.js'|: Dict\\b|as Dict\\b|Dict\\[\\]" src/status-server/config-store.ts
rg -n "export type DashboardConfig = \\{|Server:\\s*\\{|WebSearch:\\s*\\{" dashboard/src/types.d.ts
rg -n "getDefaultConfigObject" src tests scripts dashboard
```

Expected:
- First command: no output.
- Second command: no mirrored dashboard config object output.
- Third command: `src/config/defaults.ts` definition plus real import/use sites; not zero importers.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test -- tests/config-schema-contract.test.ts tests/config-normalization.test.ts tests/config.test.ts tests/runtime-loadconfig.test.ts tests/runtime-status-server.test.ts tests/status-server-chat.test.ts tests/settings-runtime.test.ts tests/settings-sections.test.ts dashboard/tests/tab-components.test.tsx
```

Expected:
- All selected tests pass.

- [ ] **Step 3: Run repository typecheck**

Run:

```powershell
npm run typecheck
```

Expected:
- Root, scripts, dashboard, and test TypeScript projects pass.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
npm test
```

Expected:
- Full suite passes.
- If a known dashboard timing test flakes, rerun the exact failing test and record whether failure is unrelated to config changes before stopping.

- [ ] **Step 5: Final commit**

```powershell
git status --short
git add src/config/types.ts src/config/defaults.ts src/config/normalization.ts src/config/getters.ts src/status-server/config-store.ts src/status-server/routes/core.ts src/status-server/server-types.ts src/status-server/managed-llama.ts src/status-server/routes/chat.ts src/status-server/chat.ts src/status-server/chat-prompt-context.ts src/status-server/preset-runner.ts dashboard/src/types.d.ts dashboard/tsconfig.json dashboard/src/api.ts dashboard/src/App.tsx dashboard/src/tabs/SettingsTab.tsx dashboard/src/managed-llama-presets.ts dashboard/src/settings-runtime.ts dashboard/src/dashboard-presets.ts tests/config-schema-contract.test.ts tests/config-normalization.test.ts tests/config.test.ts tests/runtime-loadconfig.test.ts tests/runtime-status-server.test.ts tests/status-server-chat.test.ts tests/settings-runtime.test.ts tests/settings-sections.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "feat: share typed config schema across server and dashboard"
```

Expected:
- Commit contains no unrelated files.

## Acceptance Criteria

- `src/config/types.ts` defines the full live config schema, including server/dashboard-only fields.
- `src/config/defaults.ts:getDefaultConfigObject()` is imported by live status-server code.
- `src/status-server/config-store.ts` has no `Dict` import, `Dict` return type, `Dict` parameter, `as Dict`, or local default schema.
- `readConfig`, `writeConfig`, `getDefaultConfig`, and status `/config` route use `SiftConfig`.
- `dashboard/src/types.d.ts` aliases `DashboardConfig` to shared `SiftConfig` and no longer mirrors the config object shape.
- Config normalization returns typed config objects and supplies all fields dashboard code expects.
- Focused tests, `npm run typecheck`, and `npm test` pass.

## SiftKit Policy Notes

- Initial discovery attempted `siftkit summary --file ARCHITECTURE-REVIEW.md ...` with a specific extraction prompt and 15-minute timeout.
- `siftkit` was unavailable: `ECONNREFUSED 127.0.0.1:4765`.
- Direct `rg`/file reads were used only after that failure.
