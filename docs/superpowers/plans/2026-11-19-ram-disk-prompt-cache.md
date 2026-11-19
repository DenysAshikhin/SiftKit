# RAM-disk prompt cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an exl3 model preset can keep its prompt cache on a SiftKit-managed RAM disk, so swapping between two models keeps both caches without SSD wear.

**Architecture:**
- **Preset fields.** Each preset gets `RamDiskCache` and `RamDiskCacheGiB`.
- **Launch environment.** The exl3 adapter points TabbyAPI's disk tier at `<DriveLetter>:\<preset id>` with the preset's budget. It sizes the RAM tiers as a 0.2-context staging area.
- **The RAM disk itself.**
  - A `RamDiskCache` class (the policy) runs between engine stop and start inside `ManagedTabbyRuntime.ensurePresetReady`. It creates, grows, recreates or removes the disk, and tidies the per-preset folders.
  - It works through a `RamDiskDriver` on the `ManagedEngineHost`. The real driver runs `aim_ll` through PowerShell, elevating with UAC when the server isn't elevated.
- **Coordinator.** `PresetRuntimeCoordinator` hands the runtime the current preset list before every load, and releases the disk at shutdown.

**Tech Stack:** TypeScript (Node 26, `node:test`), Zod 4 contracts in `packages/contracts`, React + Vitest dashboard, PowerShell 5.1, and Arsenal Image Mounter `aim_ll.exe`.

**Spec:** `docs/superpowers/specs/2026-11-19-ram-disk-prompt-cache-design.md`

**Repo rules that apply to every task:**
- TypeScript only.
- No `any`, type assertions, non-null `!`, or namespace imports.
- Parse IO with Zod.
- Comments are 1–2 lines.
- TDD: write the failing test first.
- Tests never touch a real RAM disk, a real UAC prompt, or a real engine; use the fakes in Task 4.
- Commits only when the user asks; the commit steps below are where to commit once that is approved.

**Commands:**
- Run one node test file: `node .\src\test-runner\run-tests.ts <name-fragment>`.
- Run a process test: `node .\src\test-runner\run-tests.ts --process <name-fragment>`.
- Dashboard tests: `npm --prefix dashboard test -- <file>`.
- Typecheck, which also runs lint: `npm run typecheck`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/contracts/src/config.ts` | Preset id rule, `RamDiskCache`/`RamDiskCacheGiB` fields, `Exl3RamDiskConfigSchema`, validation |
| `src/config/constants.ts`, `src/config/defaults.ts`, `src/config/normalization.ts` | Defaults and normalization of the new fields |
| `src/inference-presets/preset-compatibility.ts` | The new fields are `managed-only` |
| `src/state/schema-upgrades/model-preset-ram-disk.ts` (new), `src/state/runtime-db.ts` | Schema 94 → 95 |
| `src/inference-presets/cache-sizing.ts` | `RAM_DISK_STAGING_CONTEXTS`, `resolveDiskCacheContextBytes`, `requiredRamDiskBytes` |
| `src/inference-presets/exl3-preset-adapter.ts` | Launch environment for RAM-disk presets |
| `src/status-server/ram-disk-cache.ts` (new) | `RamDisk`, `RamDiskDriver`, `RamDiskCache` (policy) |
| `src/status-server/arsenal-ram-disk-driver.ts` (new) | Real driver: PowerShell scripts, elevation, UAC |
| `src/status-server/engine-process.ts` | `ManagedEngineHost.ramDisk` |
| `src/status-server/managed-inference-runtime.ts`, `src/status-server/managed-tabby.ts` | `replaceModelPresets`, `releaseRamDisk`, prepare/release around engine start |
| `src/status-server/preset-runtime-coordinator.ts` | Preset list before every load; release at shutdown |
| `tests/helpers/fake-ram-disk.ts` (new) | `FakeRamDiskDriver` |
| `dashboard/src/...` | Toggle, size field, help text |

---

### Task 1: Disk-cache sizing helpers

**Files:**
- Modify: `src/inference-presets/cache-sizing.ts`
- Test: `tests/cache-sizing.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/cache-sizing.test.ts`; also add `requiredRamDiskBytes, resolveDiskCacheContextBytes, RAM_DISK_STAGING_CONTEXTS` to its import from `../src/inference-presets/cache-sizing.ts`)

```ts
const QWEN_27B_GEOMETRY = { attentionLayers: 16, kvTokenDim: 1024, mtpLayers: 1, recurrentSnapshotBytes: 79_429_632 };

test('one full context on disk: KV pages for the whole context plus a snapshot every checkpoint interval', () => {
  assert.deepEqual(resolveDiskCacheContextBytes({ NumCtx: 200_000, KvCacheQuantization: 'f16', SpeculativeEnabled: true,
    DiskCacheCheckpointInterval: 2048 }, FLASH_NEXT_GEOMETRY), { kvBytes: 5_324_800_000, snapshotBytes: 5_838_077_952 });
  assert.deepEqual(resolveDiskCacheContextBytes({ NumCtx: 180_224, KvCacheQuantization: 'q8_0', SpeculativeEnabled: true,
    DiskCacheCheckpointInterval: 4096 }, QWEN_27B_GEOMETRY), { kvBytes: 6_666_846_208, snapshotBytes: 3_494_903_808 });
  assert.equal(resolveDiskCacheContextBytes({ NumCtx: 1000, KvCacheQuantization: 'f16', SpeculativeEnabled: false,
    DiskCacheCheckpointInterval: 2048 }, 'config.json has no head_dim'), 'config.json has no head_dim');
});

test('the RAM disk holds every RAM-disk budget, 1 GiB of overhead, and the 2% free-space floor, in whole MiB', () => {
  assert.equal(requiredRamDiskBytes([11, 11]), 25_200_427_008);
  assert.equal(requiredRamDiskBytes([10]), 12_052_332_544);
  assert.equal(RAM_DISK_STAGING_CONTEXTS, 0.2);
});
```

- [ ] **Step 2: Run them; they fail**

Run: `node .\src\test-runner\run-tests.ts cache-sizing`
Expected: FAIL. The new exports don't exist (`does not provide an export named 'requiredRamDiskBytes'`).

- [ ] **Step 3: Implement.** In `src/inference-presets/cache-sizing.ts`, replace the body of `resolveCacheTierSizes` and add the new exports. The final file:

```ts
import type { CacheGeometry, ModelRuntimePreset } from '@siftkit/contracts';
import { getExl3CacheModes, type Exl3KvLayout } from './preset-compatibility.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** exllamav3's default recurrent checkpoint spacing; architectures with wider spacing are over-provisioned. */
const RECURRENT_CHECKPOINT_TOKENS = 2048;
/** Full contexts the RAM tiers stage while the RAM disk holds the cache; the disk tier needs a RAM tier above 0. */
export const RAM_DISK_STAGING_CONTEXTS = 0.2;
/** NTFS metadata and exllamav3's per-model cache indexes on the RAM disk. */
const RAM_DISK_OVERHEAD_GIB = 1;
/** exllamav3 starts no disk write once free space falls below 2% of the file system. */
const RAM_DISK_FREE_FLOOR = 0.02;

export type CacheTierSizes = { cacheRamMiB: number; recurrentRamMiB: number };
export type DiskCacheContextBytes = { kvBytes: number; snapshotBytes: number };
type SizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'CacheContexts' | 'KvCacheQuantization' | 'SpeculativeEnabled'>;
type DiskSizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'KvCacheQuantization' | 'SpeculativeEnabled' | 'DiskCacheCheckpointInterval'>;

/** Bytes of one token in one attention layer; quantized pages add one fp16 scale per 32 values of K and of V. */
function kvBytesPerLayerToken(layout: Exl3KvLayout, kvTokenDim: number): number {
  return layout.bits === null ? 4 * kvTokenDim : (kvTokenDim * (layout.bits[0] + layout.bits[1])) / 8 + kvTokenDim / 8;
}

/** KV bytes of one token across the target and draft caches, or why it cannot be known. */
function kvTokenBytes(preset: Pick<ModelRuntimePreset, 'KvCacheQuantization' | 'SpeculativeEnabled'>, geometry: CacheGeometry): number | string {
  const modes = getExl3CacheModes(preset.KvCacheQuantization);
  let draftBytes = 0;
  if (preset.SpeculativeEnabled) {
    if (modes.draft === null) return `KvCacheQuantization ${preset.KvCacheQuantization} has no draft cache mode for speculative decoding`;
    draftBytes = geometry.mtpLayers * kvBytesPerLayerToken(modes.draft, geometry.kvTokenDim);
  }
  return geometry.attentionLayers * kvBytesPerLayerToken(modes.cache, geometry.kvTokenDim) + draftBytes;
}

/**
 * RAM-tier sizes holding CacheContexts full contexts: KV pages of the target and draft caches, and
 * recurrent snapshots. Yields why instead when the geometry is unknown or the draft cache has no mode.
 */
export function resolveCacheTierSizes(preset: SizingPreset, geometry: CacheGeometry | string): CacheTierSizes | string {
  if (typeof geometry === 'string') return geometry;
  const tokenBytes = kvTokenBytes(preset, geometry);
  if (typeof tokenBytes === 'string') return tokenBytes;
  const tokens = preset.CacheContexts * preset.NumCtx;
  const snapshots = Math.ceil(tokens / RECURRENT_CHECKPOINT_TOKENS);
  return {
    cacheRamMiB: Math.ceil((tokens * tokenBytes) / MIB),
    recurrentRamMiB: Math.ceil((snapshots * geometry.recurrentSnapshotBytes) / MIB),
  };
}

/** One full NumCtx context in the disk tier: its KV pages, and a recurrent snapshot every DiskCacheCheckpointInterval tokens. */
export function resolveDiskCacheContextBytes(preset: DiskSizingPreset, geometry: CacheGeometry | string): DiskCacheContextBytes | string {
  if (typeof geometry === 'string') return geometry;
  const tokenBytes = kvTokenBytes(preset, geometry);
  if (typeof tokenBytes === 'string') return tokenBytes;
  return {
    kvBytes: preset.NumCtx * tokenBytes,
    snapshotBytes: Math.ceil(preset.NumCtx / preset.DiskCacheCheckpointInterval) * geometry.recurrentSnapshotBytes,
  };
}

/** The RAM disk size for these per-preset budgets (GiB), rounded up to a whole MiB. */
export function requiredRamDiskBytes(budgetsGiB: readonly number[]): number {
  const payload = (budgetsGiB.reduce((sum, budget) => sum + budget, 0) + RAM_DISK_OVERHEAD_GIB) * GIB;
  return Math.ceil(payload / (1 - RAM_DISK_FREE_FLOOR) / MIB) * MIB;
}
```

- [ ] **Step 4: Run; all `cache-sizing` tests pass.**

Run: `node .\src\test-runner\run-tests.ts cache-sizing`
Expected: PASS. The existing tests are unchanged and still green.

- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/cache-sizing.ts tests/cache-sizing.test.ts
git commit -m "feat: size one full context in the disk tier and the RAM disk for preset budgets"
```

---

### Task 2: Contracts, defaults, normalization, and the preset id rule

**Files:**
- Modify: `packages/contracts/src/config.ts` (preset settings shape near line 63–70, `ModelPresetFieldSchema` near 90, `ModelRuntimePresetSchema` near 105, the `ServerModelPresetsConfigSchema` refinement near 120–163, `Exl3EngineConfigSchema` near 167, and the `SiftPresetSchema` id near 287)
- Modify: `src/config/constants.ts`, `src/config/defaults.ts` (preset defaults near line 90, the `Engines.Exl3` defaults near 156), `src/config/normalization.ts` (`normalizeExl3Engine` near 200, `resolveModelPresetSettings` near 497)
- Modify: `src/inference-presets/preset-compatibility.ts` (`PRESET_FIELD_SUPPORT`)
- Modify: `src/config/types.ts` (re-export `Exl3RamDiskConfig`)
- Test: `tests/ram-disk-config.test.ts` (new); update `tests/model-preset-adapters.test.ts` (its support table near line 422)

- [ ] **Step 1: Write the failing test** `tests/ram-disk-config.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { Exl3EngineConfigSchema, ServerModelPresetsConfigSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.ts';

function presets(...overrides: Array<Record<string, string | number | boolean | null>>) {
  const base = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  const list = overrides.map((override, index) => ({ ...base, id: `preset-${index + 1}`, ...override }));
  return { Presets: list, ActivePresetId: 'preset-1' };
}

function issues(value: ReturnType<typeof presets>): string[] {
  const result = ServerModelPresetsConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test('new model presets and the exl3 engine default to no RAM disk on drive S', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  assert.deepEqual([preset?.RamDiskCache, preset?.RamDiskCacheGiB], [false, 10]);
  assert.deepEqual(config.Server.Engines.Exl3.RamDisk, { ToolPath: null, DriveLetter: 'S' });
});

test('a RAM-disk preset is valid alone, but not with its own disk cache directory or a non-integer budget', () => {
  assert.deepEqual(issues(presets({ Backend: 'exl3', RamDiskCache: true, RamDiskCacheGiB: 11 })), []);
  assert.deepEqual(issues(presets({ Backend: 'exl3', RamDiskCache: true, DiskCacheDir: 'D:\\cache', CacheRam: 1024 })),
    ["Model preset 'preset-1': RamDiskCache and DiskCacheDir are two disk caches; turn one off."]);
  assert.ok(issues(presets({ Backend: 'exl3', RamDiskCache: true, RamDiskCacheGiB: 1.5 })).length > 0);
});

test('model preset ids are lowercase words joined by dashes, because an id names its RAM-disk folder', () => {
  assert.deepEqual(issues({ ...presets({}), Presets: presets({}).Presets.map((entry) => ({ ...entry, id: 'exl3-3-8-27b-5bpw' })),
    ActivePresetId: 'exl3-3-8-27b-5bpw' }), []);
  for (const bad of ['Bad Id', 'a:b', 'x\\y', '-lead', 'UPPER']) {
    assert.ok(issues({ Presets: presets({}).Presets.map((entry) => ({ ...entry, id: bad })), ActivePresetId: bad }).length > 0, bad);
  }
});

test('the exl3 RAM disk takes one drive letter and an optional aim_ll path', () => {
  const engine = getDefaultConfigObject().Server.Engines.Exl3;
  assert.equal(Exl3EngineConfigSchema.safeParse({ ...engine, RamDisk: { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'T' } }).success, true);
  for (const letter of ['', 'ST', 's', '1']) {
    assert.equal(Exl3EngineConfigSchema.safeParse({ ...engine, RamDisk: { ToolPath: null, DriveLetter: letter } }).success, false, letter);
  }
});
```

- [ ] **Step 2: Run it; it fails**

Run: `node .\src\test-runner\run-tests.ts ram-disk-config`
Expected: FAIL (`RamDiskCache` is undefined on the default preset).

- [ ] **Step 3: Implement the contracts** (`packages/contracts/src/config.ts`)

Add the id rule above `ModelPresetSettingsShape` and use it in both preset schemas:

```ts
/** Preset ids are lowercase words joined by dashes; a model preset's id also names its RAM-disk cache folder. */
export const PRESET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
```

- `SiftPresetSchema`: `id: z.string().trim().min(1).regex(PRESET_ID_PATTERN),`
- `ModelRuntimePresetSchema`: `id: z.string().regex(PRESET_ID_PATTERN),`

In `ModelPresetSettingsShape`, after `DiskCacheCheckpointInterval`:

```ts
  /** Keep the prompt cache on SiftKit's RAM disk; replaces CacheRam, CacheRecurrentRam, CacheAuto, and DiskCacheDir. */
  RamDiskCache: z.boolean(),
  /** This preset's folder budget on the RAM disk, in GiB. */
  RamDiskCacheGiB: z.number().int().positive(),
```

Add `'RamDiskCache', 'RamDiskCacheGiB'` to `ModelPresetFieldSchema` right after `'DiskCacheCheckpointInterval'`.

In the `ServerModelPresetsConfigSchema` refinement, add as the first statement inside `for (const [index, preset] of value.Presets.entries())`, before `if (preset.DiskCacheDir === null) continue;`:

```ts
    if (preset.RamDiskCache && preset.DiskCacheDir !== null) {
      context.addIssue({ code: 'custom', path: ['Presets', index, 'RamDiskCache'],
        message: `Model preset '${preset.id}': RamDiskCache and DiskCacheDir are two disk caches; turn one off.` });
    }
```

Add before `Exl3EngineConfigSchema`, and add `RamDisk: Exl3RamDiskConfigSchema,` as its last field:

```ts
export const Exl3RamDiskConfigSchema = z.object({
  /** aim_ll.exe of Arsenal Image Mounter; required once a preset turns RamDiskCache on. */
  ToolPath: z.string().min(1).nullable(),
  DriveLetter: z.string().regex(/^[A-Z]$/u),
}).strict();
export type Exl3RamDiskConfig = z.infer<typeof Exl3RamDiskConfigSchema>;
```

`src/config/types.ts`: re-export the type next to `Exl3EngineConfig`, following that file's pattern:

```ts
  Exl3RamDiskConfig as ContractExl3RamDiskConfig,
// ...
export type Exl3RamDiskConfig = ContractExl3RamDiskConfig;
```

- [ ] **Step 4: Defaults and normalization**

- `src/config/constants.ts`: `export const SIFT_DEFAULT_RAM_DISK_CACHE_GIB = 10;`
- `src/config/defaults.ts`, preset defaults after `DiskCacheCheckpointInterval`: `RamDiskCache: false, RamDiskCacheGiB: SIFT_DEFAULT_RAM_DISK_CACHE_GIB,`
- `src/config/defaults.ts`, `Engines.Exl3` after `Environment: {}`: `RamDisk: { ToolPath: null, DriveLetter: 'S' },`
- `src/config/normalization.ts`, `resolveModelPresetSettings`, after `DiskCacheCheckpointInterval` (schema 95 stores both fields, so a missing one is corrupt config, like `CacheAuto`):

```ts
    RamDiskCache: getUpgradedPresetField(ModelPresetSettingsSchema.shape.RamDiskCache, 'RamDiskCache', input.RamDiskCache, 'true or false'),
    RamDiskCacheGiB: getUpgradedPresetField(ModelPresetSettingsSchema.shape.RamDiskCacheGiB, 'RamDiskCacheGiB', input.RamDiskCacheGiB,
      'a whole number of GiB above 0'),
```

Update the comment above `getUpgradedPresetField` to: `// A schema upgrade gave every stored preset this field (SparseDraftHead in 91, CacheAuto/CacheContexts in 92, RamDiskCache/RamDiskCacheGiB in 95), so a missing or bad value is corrupt config.`

- `src/config/normalization.ts`, `normalizeExl3Engine`, last field, with `Exl3RamDiskConfigSchema` imported from `@siftkit/contracts`:

```ts
    RamDisk: getEngineRamDisk(input.RamDisk),
```

and add below `getEngineEnvironment`:

```ts
// Schema 95 stores RamDisk on every engine config, so a missing or bad value is corrupt config.
function getEngineRamDisk(value: JsonValue): Exl3RamDiskConfig {
  const parsed = Exl3RamDiskConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Server.Engines.Exl3.RamDisk: ${parsed.error.message}`);
  return parsed.data;
}
```

- `src/inference-presets/preset-compatibility.ts`, `PRESET_FIELD_SUPPORT`, after `DiskCacheCheckpointInterval`: `RamDiskCache: 'managed-only', RamDiskCacheGiB: 'managed-only',`
- `tests/model-preset-adapters.test.ts`, the expected support table (near line 429), the same two entries: `RamDiskCache: MANAGED_ONLY, RamDiskCacheGiB: MANAGED_ONLY,`

- [ ] **Step 5: Run the new and the touched tests**

Run: `node .\src\test-runner\run-tests.ts ram-disk-config model-preset-adapters presets config`
Expected: PASS. Then run `npm run typecheck`. Every object literal that builds a full `ModelRuntimePreset` or `Exl3EngineConfig` by hand now fails to compile (for example `tests/managed-tabby.test.ts:52` builds the engine config). Add `RamDisk: { ToolPath: null, DriveLetter: 'S' }` to each engine literal; the compiler lists them all. Preset literals spread the defaults, so they need nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/config.ts src/config tests/ram-disk-config.test.ts tests/model-preset-adapters.test.ts src/inference-presets/preset-compatibility.ts
git commit -m "feat: RamDiskCache preset fields, the exl3 RamDisk engine setting, and the preset id rule"
```

---

### Task 3: Schema 94 → 95

**Files:**
- Create: `src/state/schema-upgrades/model-preset-ram-disk.ts`
- Modify: `src/state/runtime-db.ts` (`CURRENT_SCHEMA_VERSION = 95`, and the step `{ from: 94, apply: upgradeModelPresetRamDisk }`)
- Test: `tests/runtime-db-schema-ram-disk.test.ts` (new)

- [ ] **Step 1: Write the failing test** (it follows `tests/runtime-db-schema-cache-auto.test.ts`)

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

/** The default config as a schema-94 file stored it: presets without the RAM-disk fields, an engine without RamDisk. */
function seedSchema94(edit: (presets: Array<Record<string, string | number | boolean | null>>) => void = () => {}): string {
  const dbPath = path.join(createManagedTempDir('siftkit-ram-disk-schema-'), 'runtime.sqlite');
  const config = getDefaultServerConfig();
  writeConfig(dbPath, config);
  closeAllRuntimeDatabases();
  const presets = config.Server.ModelPresets.Presets.map(({ RamDiskCache: _on, RamDiskCacheGiB: _gib, ...preset }) => ({ ...preset }));
  edit(presets);
  const { RamDisk: _ramDisk, ...engine } = config.Server.Engines.Exl3;
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE app_config SET server_model_presets_json = ?, server_exl3_json = ? WHERE id = 1')
      .run(JSON.stringify(presets), JSON.stringify(engine));
    database.exec('UPDATE runtime_schema SET version = 94 WHERE id = 1');
  });
  return dbPath;
}

test('the 94 to 95 upgrade turns the RAM disk off on every stored preset and gives the engine its RamDisk setting', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema94();

  assert.equal(getSchemaVersion(getRuntimeDatabase(dbPath)), CURRENT_SCHEMA_VERSION);
  const config = readConfig(dbPath);
  assert.deepEqual(config.Server.ModelPresets.Presets.map((preset) => [preset.RamDiskCache, preset.RamDiskCacheGiB]),
    config.Server.ModelPresets.Presets.map(() => [false, 10]));
  assert.deepEqual(config.Server.Engines.Exl3.RamDisk, { ToolPath: null, DriveLetter: 'S' });
});

test('the 94 to 95 upgrade fails loudly on a stored preset id that cannot name a folder, and leaves the file at 94', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema94((presets) => {
    const first = presets[0];
    if (first) first.id = 'Bad:Id';
  });

  assert.throws(() => getRuntimeDatabase(dbPath), /Model preset id 'Bad:Id' must be lowercase words joined by dashes/u);
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 94);
});
```

Also add a test for chat session snapshots. Copy the seeding pattern of `tests/runtime-db-schema-chat-session-preset-snapshots.test.ts` into this file and assert that `model_preset_json` gains `"RamDiskCache":false,"RamDiskCacheGiB":10` while every value it already stores is kept.

- [ ] **Step 2: Run it; it fails**

Run: `node .\src\test-runner\run-tests.ts runtime-db-schema-ram-disk`
Expected: FAIL. Schema 94 is current, so the RAM-disk fields are missing and normalization throws `Invalid RamDiskCache`.

- [ ] **Step 3: Implement** `src/state/schema-upgrades/model-preset-ram-disk.ts`

```ts
import { PRESET_ID_PATTERN } from '@siftkit/contracts';
import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingStoredPresetFields, withMissingFields } from './stored-model-presets.ts';

const ADDED_FIELDS = { RamDiskCache: false, RamDiskCacheGiB: 10 };
const ConfigRowsSchema = z.array(z.object({ id: z.number().int(), server_model_presets_json: z.string(), server_exl3_json: z.string() }));
const SnapshotRowsSchema = z.array(z.object({ id: z.string(), model_preset_json: z.string().nullable() }));
// Pins only what this step needs: preset ids, and objects to extend.
const StoredIdsSchema = z.array(z.object({ id: z.string() }).passthrough());
const StoredObjectSchema = z.record(z.string(), JsonValueSchema);

/** Schema 94 -> 95: presets and session snapshots gain RamDiskCache/RamDiskCacheGiB, and the exl3 engine gains RamDisk. */
export function upgradeModelPresetRamDisk(database: RuntimeDatabase): void {
  const rows = ConfigRowsSchema.parse(database.prepare('SELECT id, server_model_presets_json, server_exl3_json FROM app_config').all());
  const updateEngine = database.prepare('UPDATE app_config SET server_exl3_json = ? WHERE id = ?');
  for (const row of rows) {
    const ids = StoredIdsSchema.safeParse(parseJsonValueText(row.server_model_presets_json));
    if (!ids.success) throw new Error(`Stored model presets are unreadable: ${ids.error.message}`);
    const bad = ids.data.find((preset) => !PRESET_ID_PATTERN.test(preset.id));
    if (bad !== undefined) throw new Error(`Model preset id '${bad.id}' must be lowercase words joined by dashes; rename it before upgrading.`);
    const engine = StoredObjectSchema.safeParse(parseJsonValueText(row.server_exl3_json));
    if (!engine.success) throw new Error(`Stored exl3 engine config is unreadable: ${engine.error.message}`);
    updateEngine.run(JSON.stringify(withMissingFields(engine.data, { RamDisk: { ToolPath: null, DriveLetter: 'S' } })), row.id);
  }
  addMissingStoredPresetFields(database, ADDED_FIELDS);
  const snapshots = SnapshotRowsSchema.parse(database.prepare('SELECT id, model_preset_json FROM chat_sessions').all());
  const updateSnapshot = database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?');
  for (const snapshot of snapshots) {
    if (snapshot.model_preset_json === null) continue;
    const parsed = StoredObjectSchema.safeParse(parseJsonValueText(snapshot.model_preset_json));
    if (!parsed.success) throw new Error(`Chat session ${snapshot.id} model preset snapshot is unreadable: ${parsed.error.message}`);
    updateSnapshot.run(JSON.stringify(withMissingFields(parsed.data, ADDED_FIELDS)), snapshot.id);
  }
}
```

In `src/state/runtime-db.ts`: set `CURRENT_SCHEMA_VERSION = 95`, import `upgradeModelPresetRamDisk`, and append `{ from: 94, apply: upgradeModelPresetRamDisk },` to `SCHEMA_UPGRADES`.

- [ ] **Step 4: Run.** `node .\src\test-runner\run-tests.ts runtime-db-schema` → PASS (all schema tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/state tests/runtime-db-schema-ram-disk.test.ts
git commit -m "feat: schema 95 adds the RAM-disk preset fields and engine setting"
```

---

### Task 4: `RamDiskCache` policy and the fake driver

**Files:**
- Create: `src/status-server/ram-disk-cache.ts`
- Create: `tests/helpers/fake-ram-disk.ts`
- Test: `tests/ram-disk-cache.test.ts` (new)

- [ ] **Step 1: Write the fake driver** `tests/helpers/fake-ram-disk.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';

import type { RamDisk, RamDiskDriver } from '../../src/status-server/ram-disk-cache.ts';
import { createManagedTempDir } from './temp-dirs.ts';

/** A RAM disk whose root is a temp directory; it records every call and can fail one operation on demand. */
export class FakeRamDiskDriver implements RamDiskDriver {
  readonly calls: string[] = [];
  disk: RamDisk | null = null;
  failNext: 'create' | 'grow' | 'remove' | null = null;
  private readonly base = createManagedTempDir('siftkit-fake-ram-disk-');
  private serial = 0;

  /** A disk left by an earlier server: `ownerPid` null leaves no marker. */
  plantLeftover(letter: string, sizeBytes: number, ownerPid: number | null): RamDisk {
    this.disk = this.mount(letter, sizeBytes);
    if (ownerPid !== null) fs.writeFileSync(path.join(this.disk.root, 'siftkit-owner.json'), JSON.stringify({ pid: ownerPid }));
    return this.disk;
  }

  async find(): Promise<RamDisk | null> {
    this.calls.push('find');
    return this.disk;
  }

  async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    this.calls.push(`create ${letter} ${String(sizeBytes)}`);
    this.failIf('create', toolPath);
    this.disk = this.mount(letter, sizeBytes);
    return this.disk;
  }

  async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    this.calls.push(`grow ${disk.letter} ${String(sizeBytes)}`);
    this.failIf('grow', toolPath);
    this.disk = { ...disk, sizeBytes };
    return this.disk;
  }

  async remove(toolPath: string, disk: RamDisk): Promise<void> {
    this.calls.push(`remove ${disk.letter}`);
    this.failIf('remove', toolPath);
    fs.rmSync(disk.root, { recursive: true, force: true });
    this.disk = null;
  }

  removeDetached(_toolPath: string, disk: RamDisk): void {
    this.calls.push(`remove-detached ${disk.letter}`);
  }

  private mount(letter: string, sizeBytes: number): RamDisk {
    this.serial += 1;
    const root = path.join(this.base, `${letter}-${String(this.serial)}`);
    fs.mkdirSync(root);
    return { letter, root, sizeBytes };
  }

  private failIf(operation: 'create' | 'grow' | 'remove', toolPath: string): void {
    if (this.failNext !== operation) return;
    this.failNext = null;
    throw new Error(`${operation} failed (${toolPath}): The operation was canceled by the user.`);
  }
}
```

- [ ] **Step 2: Write the failing tests** `tests/ram-disk-cache.test.ts`

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { ModelRuntimePreset } from '../src/config/types.ts';
import { requiredRamDiskBytes } from '../src/inference-presets/cache-sizing.ts';
import { RamDiskCache } from '../src/status-server/ram-disk-cache.ts';
import { serverLogger } from '../src/status-server/server-logger.ts';
import { FakeRamDiskDriver } from './helpers/fake-ram-disk.ts';

const CONFIG = { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'S' };
const GIB = 1024 ** 3;

function preset(id: string, ramDisk: boolean, gib = 10): ModelRuntimePreset {
  const base = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  return { ...base, id, Backend: 'exl3', RamDiskCache: ramDisk, RamDiskCacheGiB: gib };
}

const NEXT = preset('flash-next', true, 11);
const BIG = preset('qwen-27b', true, 11);
const PLAIN = preset('plain', false);

test('the first RAM-disk load creates the disk for every RAM-disk budget, marks it, and makes the preset folder', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG, PLAIN], NEXT);
  assert.deepEqual(driver.calls, ['find', `create S ${String(requiredRamDiskBytes([11, 11]))}`]);
  const root = driver.disk?.root ?? '';
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'siftkit-owner.json'), 'utf8')).pid, process.pid);
  assert.ok(fs.statSync(path.join(root, 'flash-next')).isDirectory());
});

test('switching between RAM-disk presets keeps the disk and both folders', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  const root = driver.disk?.root ?? '';
  fs.writeFileSync(path.join(root, 'flash-next', 'page.bin'), 'x');
  await cache.prepare(CONFIG, [NEXT, BIG], BIG);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  assert.deepEqual(driver.calls.filter((call) => !call.startsWith('find')), [`create S ${String(requiredRamDiskBytes([11, 11]))}`]);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'page.bin')), 'the first preset kept its cache');
  assert.ok(fs.existsSync(path.join(root, 'qwen-27b')));
});

test('a raised budget grows the disk in place; a failed grow recreates it empty and warns', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.prepare(CONFIG, [preset('flash-next', true, 20)], NEXT);
  assert.equal(driver.calls.at(-1), `grow S ${String(requiredRamDiskBytes([20]))}`);
  driver.failNext = 'grow';
  await cache.prepare(CONFIG, [preset('flash-next', true, 30)], NEXT);
  assert.deepEqual(driver.calls.slice(-3), [`grow S ${String(requiredRamDiskBytes([30]))}`, 'remove S', `create S ${String(requiredRamDiskBytes([30]))}`]);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_recreated']);
});

test('a failed create or a declined UAC prompt fails the load with the reason', async () => {
  const driver = new FakeRamDiskDriver();
  driver.failNext = 'create';
  await assert.rejects(new RamDiskCache(driver).prepare(CONFIG, [NEXT], NEXT), /create failed .*canceled by the user/u);
});

test('a RAM-disk preset needs the aim_ll path', async () => {
  await assert.rejects(new RamDiskCache(new FakeRamDiskDriver()).prepare({ ToolPath: null, DriveLetter: 'S' }, [NEXT], NEXT),
    /RAM disk cache needs Server\.Engines\.Exl3\.RamDisk\.ToolPath \(aim_ll\.exe\)/u);
});

test('folders of presets no longer on the RAM disk are deleted, and a folder over its lowered budget is wiped with a warning', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  const root = driver.disk?.root ?? '';
  fs.mkdirSync(path.join(root, 'qwen-27b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'System Volume Information'));
  const big = fs.openSync(path.join(root, 'flash-next', 'pages.bin'), 'w');
  fs.ftruncateSync(big, 2 * GIB);
  fs.closeSync(big);
  await cache.prepare(CONFIG, [preset('flash-next', true, 1), preset('qwen-27b', false)], NEXT);
  assert.equal(fs.existsSync(path.join(root, 'qwen-27b')), false, 'a preset switched off loses its folder');
  assert.ok(fs.existsSync(path.join(root, 'System Volume Information')), 'folders that are no preset id are not ours');
  assert.deepEqual(fs.readdirSync(path.join(root, 'flash-next')), [], 'over budget: wiped and remade empty');
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_folder_wiped']);
});

test('release removes the disk, and a leftover is removed at the first check while a live owner disk is never touched', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.release(CONFIG);
  assert.equal(driver.disk, null);

  const leftover = new FakeRamDiskDriver();
  leftover.plantLeftover('S', GIB, null);
  await new RamDiskCache(leftover).release(CONFIG);
  assert.deepEqual(leftover.calls, ['find', 'remove S']);

  const foreign = new FakeRamDiskDriver();
  foreign.plantLeftover('S', GIB, process.ppid);
  const other = new RamDiskCache(foreign);
  await other.release(CONFIG);
  assert.deepEqual(foreign.calls, ['find'], 'a disk of a live SiftKit process is left alone');
  await assert.rejects(other.prepare(CONFIG, [NEXT], NEXT), new RegExp(`RAM disk S: belongs to SiftKit process ${String(process.ppid)}`, 'u'));
});

test('the process-exit path starts the removal without waiting', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  cache.releaseForProcessExitSync(CONFIG);
  assert.equal(driver.calls.at(-1), 'remove-detached S');
});
```

- [ ] **Step 3: Run them; they fail**

Run: `node .\src\test-runner\run-tests.ts ram-disk-cache`
Expected: FAIL (`Cannot find module ... ram-disk-cache.ts`).

- [ ] **Step 4: Implement** `src/status-server/ram-disk-cache.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';

import { PRESET_ID_PATTERN } from '@siftkit/contracts';
import type { Exl3RamDiskConfig, ModelRuntimePreset } from '../config/types.ts';
import { requiredRamDiskBytes } from '../inference-presets/cache-sizing.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import { serverLogger } from './server-logger.ts';

const GIB = 1024 ** 3;
const OWNER_FILE = 'siftkit-owner.json';
const OwnerSchema = z.object({ pid: z.number().int().positive() });

/** SiftKit's mounted RAM disk: its letter, the directory it is mounted at, and its size. */
export type RamDisk = { readonly letter: string; readonly root: string; readonly sizeBytes: number };

/** Finds, creates, grows, and removes SiftKit's RAM disk; every call but `find` may need elevation. */
export interface RamDiskDriver {
  find(): Promise<RamDisk | null>;
  create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk>;
  grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk>;
  remove(toolPath: string, disk: RamDisk): Promise<void>;
  /** Starts the removal and returns at once, for the synchronous process-exit path. */
  removeDetached(toolPath: string, disk: RamDisk): void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(disk: RamDisk): number | null {
  const file = path.join(disk.root, OWNER_FILE);
  if (!fs.existsSync(file)) return null;
  const parsed = OwnerSchema.safeParse(parseJsonValueText(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data.pid : null;
}

function directoryBytes(directory: string): number {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
}

function requireToolPath(config: Exl3RamDiskConfig): string {
  if (config.ToolPath === null) throw new Error('RAM disk cache needs Server.Engines.Exl3.RamDisk.ToolPath (aim_ll.exe).');
  return config.ToolPath;
}

/** Keeps SiftKit's RAM disk sized for every RAM-disk preset; runs only while no engine uses the disk. */
export class RamDiskCache {
  private disk: RamDisk | null = null;
  /** A disk another live SiftKit process owns; never removed or resized. */
  private foreign: { disk: RamDisk; pid: number } | null = null;
  private checked = false;
  private readonly driver: RamDiskDriver;

  constructor(driver: RamDiskDriver) {
    this.driver = driver;
  }

  /** Readies the disk and `preset`'s folder before an engine that caches on it launches. */
  async prepare(config: Exl3RamDiskConfig, presets: readonly ModelRuntimePreset[], preset: ModelRuntimePreset): Promise<void> {
    const toolPath = requireToolPath(config);
    await this.checkLeftover(toolPath);
    if (this.foreign !== null) throw new Error(`RAM disk ${this.foreign.disk.letter}: belongs to SiftKit process ${String(this.foreign.pid)}.`);
    const ramDiskPresets = presets.filter((entry) => entry.RamDiskCache);
    const required = requiredRamDiskBytes(ramDiskPresets.map((entry) => entry.RamDiskCacheGiB));
    let disk = this.disk;
    if (disk !== null && disk.letter !== config.DriveLetter) {
      await this.driver.remove(toolPath, disk);
      disk = null;
    }
    if (disk === null) disk = await this.create(toolPath, config.DriveLetter, required);
    else if (disk.sizeBytes < required) disk = await this.grow(toolPath, disk, required);
    this.disk = disk;
    this.tidyFolders(disk, ramDiskPresets);
    fs.mkdirSync(path.join(disk.root, preset.id), { recursive: true });
  }

  /** Removes SiftKit's disk, if any, once no engine caches on it; a leftover found at the first check goes too. */
  async release(config: Exl3RamDiskConfig): Promise<void> {
    if (!this.checked) {
      const found = await this.driver.find();
      this.checked = true;
      if (found === null || this.isForeign(found)) return;
      this.disk = found;
    }
    const disk = this.disk;
    if (disk === null) return;
    await this.driver.remove(requireToolPath(config), disk);
    this.disk = null;
  }

  releaseForProcessExitSync(config: Exl3RamDiskConfig): void {
    if (this.disk === null || config.ToolPath === null) return;
    this.driver.removeDetached(config.ToolPath, this.disk);
    this.disk = null;
  }

  private async checkLeftover(toolPath: string): Promise<void> {
    if (this.checked) return;
    const found = await this.driver.find();
    this.checked = true;
    if (found === null || this.isForeign(found)) return;
    serverLogger.warning({ scope: 'exl3', id: found.letter, event: 'ram_disk_leftover_removed', fields: '',
      alert: `Removed a leftover SiftKit RAM disk ${found.letter}: from an earlier server.` });
    await this.driver.remove(toolPath, found);
  }

  private isForeign(found: RamDisk): boolean {
    const owner = readOwner(found);
    if (owner === null || owner === process.pid || !isAlive(owner)) return false;
    this.foreign = { disk: found, pid: owner };
    return true;
  }

  private async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    const disk = await this.driver.create(toolPath, letter, sizeBytes);
    fs.writeFileSync(path.join(disk.root, OWNER_FILE), JSON.stringify({ pid: process.pid }));
    return disk;
  }

  private async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    try {
      return await this.driver.grow(toolPath, disk, sizeBytes);
    } catch (error) {
      serverLogger.warning({ scope: 'exl3', id: disk.letter, event: 'ram_disk_recreated', fields: '',
        alert: `Could not grow RAM disk ${disk.letter}: (${error instanceof Error ? error.message : String(error)}); recreated it empty.` });
      await this.driver.remove(toolPath, disk);
      return this.create(toolPath, disk.letter, sizeBytes);
    }
  }

  /** Only folders named like preset ids are SiftKit's; NTFS keeps its own (System Volume Information) at the root. */
  private tidyFolders(disk: RamDisk, ramDiskPresets: readonly ModelRuntimePreset[]): void {
    const budgets = new Map(ramDiskPresets.map((entry) => [entry.id, entry.RamDiskCacheGiB * GIB]));
    for (const entry of fs.readdirSync(disk.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PRESET_ID_PATTERN.test(entry.name)) continue;
      const folder = path.join(disk.root, entry.name);
      const budget = budgets.get(entry.name);
      if (budget === undefined) {
        fs.rmSync(folder, { recursive: true, force: true });
      } else if (directoryBytes(folder) > budget) {
        serverLogger.warning({ scope: 'exl3', id: entry.name, event: 'ram_disk_folder_wiped', fields: '',
          alert: `RAM disk cache of preset '${entry.name}' exceeded its lowered budget; wiped it.` });
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }
  }
}
```

The `checkLeftover`/`release` pair implements the spec rule: a leftover is removed at the first check. In `prepare`, the following `create` then makes a fresh disk.

- [ ] **Step 5: Run.** `node .\src\test-runner\run-tests.ts ram-disk-cache` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/ram-disk-cache.ts tests/helpers/fake-ram-disk.ts tests/ram-disk-cache.test.ts
git commit -m "feat: RAM disk policy keeps one grow-only disk for every RAM-disk preset"
```

---

### Task 5: Launch environment for RAM-disk presets

**Files:**
- Modify: `src/inference-presets/exl3-preset-adapter.ts` (`buildLaunchEnvironment` near line 165, `getCacheTierSizes` near 210)
- Modify: `src/status-server/managed-tabby.ts` (its two `buildLaunchEnvironment` calls, lines 135 and 443)
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/model-preset-adapters.test.ts`)

```ts
test('a RAM-disk preset caches in its own folder on the RAM disk, with 0.2-context staging tiers and its manual fields ignored', () => {
  const { modelRoot, modelPath } = writeModelDirectory('flash-next', FLASH_NEXT_CONFIG);
  const preset = createModelPreset({ id: 'flash-next', ModelPath: modelPath, NumCtx: 200_000, KvCacheQuantization: 'f16',
    SpeculativeEnabled: true, RamDiskCache: true, RamDiskCacheGiB: 11, DiskCacheCheckpointInterval: 2048,
    CacheRam: 1, CacheRecurrentRam: 1, CacheAuto: false });
  const environment = new Exl3PresetAdapter(modelRoot).buildLaunchEnvironment(preset, 'T');
  assert.equal(environment.TABBY_MEMORY_DISK_CACHE_DIR, 'T:\\flash-next');
  assert.equal(environment.TABBY_MEMORY_DISK_CACHE_SIZE, '11264');
  assert.equal(environment.TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL, '2048');
  assert.equal(environment.TABBY_MEMORY_SYSMEM_KV_CACHE, '1016');
  assert.equal(environment.TABBY_MEMORY_SYSMEM_RECURRENT_CACHE, '1137');
});
```

Update every existing `adapter.buildLaunchEnvironment(x)` / `new Exl3PresetAdapter(r).buildLaunchEnvironment(x)` call in this file to pass `'S'` as the second argument.

- [ ] **Step 2: Run; it fails** — `node .\src\test-runner\run-tests.ts model-preset-adapters` → FAIL. `TABBY_MEMORY_DISK_CACHE_DIR` is undefined, and the existing calls fail to compile until Step 3.

- [ ] **Step 3: Implement** in `exl3-preset-adapter.ts`:

Change the signature to `buildLaunchEnvironment(preset: ModelRuntimePreset, ramDiskLetter: string): Exl3LaunchEnvironment`. Replace the `DiskCacheDir` spread with:

```ts
      ...this.getDiskCacheEnvironment(preset, ramDiskLetter),
```

Then add:

```ts
  /** TabbyAPI's disk tier: the preset's folder on SiftKit's RAM disk, its own DiskCacheDir, or none. */
  private getDiskCacheEnvironment(preset: ModelRuntimePreset, ramDiskLetter: string): Record<string, string> {
    // Tabby reads disk_cache_size in MB and multiplies by 1024², so MiB passes through unchanged.
    const tier = (directory: string, sizeMiB: number) => ({
      TABBY_MEMORY_DISK_CACHE_DIR: directory,
      TABBY_MEMORY_DISK_CACHE_SIZE: String(sizeMiB),
      TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: String(preset.DiskCacheCheckpointInterval),
    });
    if (preset.RamDiskCache) return tier(win32.join(`${ramDiskLetter}:\\`, preset.id), preset.RamDiskCacheGiB * 1024);
    return preset.DiskCacheDir === null ? {} : tier(win32.resolve(preset.DiskCacheDir), preset.DiskCacheSizeMiB);
  }
```

In `getCacheTierSizes`, the first line becomes:

```ts
    if (preset.RamDiskCache) return this.autoSizeCacheTiers({ ...preset, CacheContexts: RAM_DISK_STAGING_CONTEXTS });
    if (!preset.CacheAuto) return { cacheRamMiB: preset.CacheRam, recurrentRamMiB: preset.CacheRecurrentRam };
    return this.autoSizeCacheTiers(preset);
```

Move the existing geometry-reading body into `private autoSizeCacheTiers(preset: ModelRuntimePreset): CacheTierSizes`, keeping its `CacheAuto cannot size` error. Import `RAM_DISK_STAGING_CONTEXTS` from `./cache-sizing.ts`.

In `managed-tabby.ts`, pass the engine's letter at both calls: `this.adapter.buildLaunchEnvironment(preset, this.engine.RamDisk.DriveLetter)`.

- [ ] **Step 4: Run.** `node .\src\test-runner\run-tests.ts model-preset-adapters managed-tabby` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/exl3-preset-adapter.ts src/status-server/managed-tabby.ts tests/model-preset-adapters.test.ts
git commit -m "feat: a RAM-disk preset launches TabbyAPI with its RAM-disk folder and staging tiers"
```

---

### Task 6: The runtime prepares and releases the RAM disk around engine starts

**Files:**
- Modify: `src/status-server/engine-process.ts` (`ManagedEngineHost` gains `readonly ramDisk: RamDiskDriver;`)
- Modify: `src/status-server/managed-inference-runtime.ts` (abstract `replaceModelPresets` and `releaseRamDisk`)
- Modify: `src/status-server/managed-tabby.ts`
- Modify: `tests/helpers/tabby-fake.ts` (`writeFakeEngineHost` gives each host a `FakeRamDiskDriver` and returns it), `tests/helpers/in-process-tabby.ts` (`NEVER_LAUNCHING_ENGINE_HOST.ramDisk` throws on every call), `tests/fixtures/managed-engine-readiness-processes.test.ts` (add `ramDisk: new FakeRamDiskDriver()`)
- Test: `tests/managed-tabby.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/managed-tabby.test.ts`). In `createManagedTabbyFixture`, set `RamDisk: { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'S' }` on the engine config and return `ramDisk: fakeTabby.ramDisk`.

```ts
const RAM_DISK = { RamDiskCache: true, RamDiskCacheGiB: 11, CacheAuto: false, CacheRam: 512 } as const;

test('a RAM-disk preset readies the disk before its engine launches and caches in its folder', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-ram-disk');
    const preset = { ...fixture.exl3Preset, ...RAM_DISK, id: 'next' };
    fixture.runtime.replaceModelPresets([preset]);
    await fixture.runtime.ensurePresetReady(preset);
    assert.deepEqual(fixture.ramDisk.calls, ['find', `create S ${String(requiredRamDiskBytes([11]))}`]);
    assert.equal(launchEngineVariables(fixture.launcher.lastLaunch).TABBY_MEMORY_DISK_CACHE_DIR, 'S:\\next');
  });
});

test('switching to a preset without the RAM disk removes it once the old engine stopped; shutdown releases it', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-ram-disk-off');
    const ramDiskPreset = { ...fixture.exl3Preset, ...RAM_DISK, id: 'next' };
    const plain = { ...fixture.exl3Preset, id: 'plain', NumCtx: 20_000 };
    fixture.runtime.replaceModelPresets([ramDiskPreset, plain]);
    await fixture.runtime.ensurePresetReady(ramDiskPreset);
    await fixture.runtime.ensurePresetReady(plain);
    assert.equal(fixture.ramDisk.calls.at(-1), 'remove S');
    assert.deepEqual(fixture.launcher.events.slice(-2), ['unload', 'terminate'], 'the RAM-disk engine drained its cache first');
    await fixture.runtime.ensurePresetReady(ramDiskPreset);
    await fixture.runtime.stopProcess();
    await fixture.runtime.releaseRamDisk();
    assert.equal(fixture.ramDisk.disk, null);
  });
});

test('a RAM-disk preset the runtime was not given fails loudly', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-ram-disk-unlisted');
    await assert.rejects(fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...RAM_DISK, id: 'next' }),
      /Model preset 'next' is not in the runtime's preset list/u);
  });
});
```

Notes:
- `fixture.launcher.lastLaunch` is the `FakeTabbyLauncher`'s last `EngineLaunchSpec`. If it has no such property, add `lastLaunch: EngineLaunchSpec | undefined` set in `launch()`.
- `fixture.launcher.events` already records `'unload'` and `'terminate'`.

- [ ] **Step 2: Run; they fail** — `node .\src\test-runner\run-tests.ts managed-tabby` → FAIL (`replaceModelPresets is not a function`).

- [ ] **Step 3: Implement**

`managed-inference-runtime.ts`, next to `replaceEngineConfig`:

```ts
  /** The configured model presets; a RAM-disk preset sizes the shared disk from all of them. */
  abstract replaceModelPresets(presets: readonly ModelRuntimePreset[]): void;
  /** Removes the RAM disk once no engine caches on it; the server's shutdown calls it after stopProcess. */
  abstract releaseRamDisk(): Promise<void>;
```

`managed-tabby.ts`:
- Fields: `private readonly ramDisk: RamDiskCache;` (constructed in the constructor as `new RamDiskCache(host.ramDisk)`) and `private modelPresets: readonly ModelRuntimePreset[] = [];`.
- Methods:

```ts
  replaceModelPresets(presets: readonly ModelRuntimePreset[]): void {
    this.modelPresets = structuredClone(presets);
  }

  releaseRamDisk(): Promise<void> {
    return this.ramDisk.release(this.engine.RamDisk);
  }

  /** Before a managed launch: ready the RAM disk for a preset that caches on it, otherwise remove it. */
  private async prepareRamDisk(preset: ModelRuntimePreset): Promise<void> {
    if (!preset.RamDiskCache) return this.ramDisk.release(this.engine.RamDisk);
    if (!this.modelPresets.some((entry) => entry.id === preset.id)) {
      throw new Error(`Model preset '${preset.id}' is not in the runtime's preset list; replaceModelPresets must run before ensurePresetReady.`);
    }
    return this.ramDisk.prepare(this.engine.RamDisk, this.modelPresets, preset);
  }
```

- In `ensurePresetReady`, inside `if (this.getProcessState() !== 'ready') {`, before `startProcess`: `if (managed) await this.prepareRamDisk(preset);`. The running engine has already stopped there, so the disk is never resized under it.
- In `flushDiskCache`, the guard becomes `if (preset === null || (preset.DiskCacheDir === null && !preset.RamDiskCache) || baseUrl === null || this.getModelState() !== 'ready') return;`.
- In `stopForProcessExitSync`, add as the first line: `this.ramDisk.releaseForProcessExitSync(this.engine.RamDisk);`.

- [ ] **Step 4: Run.** `node .\src\test-runner\run-tests.ts managed-tabby preset-runtime-coordinator model-request-queue model-residency-actions` → PASS. The existing tests use presets without `RamDiskCache`; their first launch now calls `find` on the fake, which returns null.

- [ ] **Step 5: Commit**

```bash
git add src/status-server tests/helpers tests/fixtures/managed-engine-readiness-processes.test.ts tests/managed-tabby.test.ts
git commit -m "feat: the managed engine readies or removes the RAM disk around each launch"
```

---

### Task 7: The coordinator passes the preset list and releases at shutdown

**Files:**
- Modify: `src/status-server/preset-runtime-coordinator.ts` (the 5 `ensurePresetReady` calls at lines 73, 171, 263, 384 and 407, and `shutdown` near line 297)
- Test: `tests/preset-runtime-coordinator.test.ts`

- [ ] **Step 1: Write the failing test.** Find the fake runtime that `tests/preset-runtime-coordinator.test.ts` already passes to `PresetRuntimeCoordinator`. Make it record `replaceModelPresets` and `releaseRamDisk` calls in its event log, then add:

```ts
test('every load hands the runtime the configured presets first, and shutdown releases the RAM disk after the engine stops', async () => {
  // Build the coordinator exactly as the neighbouring tests do (their config file and recording runtime).
  await coordinator.initialize();
  await coordinator.shutdown();
  assert.deepEqual(runtime.events.filter((event) => ['presets', 'ensure', 'stop', 'release'].includes(event.split(' ')[0] ?? '')),
    ['presets', `ensure ${activeId}`, 'stop', 'release']);
});
```

Follow the existing setup in that file for `coordinator`, `runtime` and `activeId`. The assertion is the contract: presets before every ensure, and release after stop.

- [ ] **Step 2: Run; it fails** — `node .\src\test-runner\run-tests.ts preset-runtime-coordinator` → FAIL. There is no `presets` event, and the fake does not implement the new abstract members until it is updated.

- [ ] **Step 3: Implement.** Add the private helper and route all 5 calls through it (`runtime.ensurePresetReady(x)` becomes `this.readyRuntime(x)`):

```ts
  /** Every load sees the presets as configured now, so a RAM-disk preset sizes the shared disk from all of them. */
  private async readyRuntime(preset: ModelRuntimePreset): Promise<void> {
    this.runtime.replaceModelPresets(readConfig(this.configPath).Server.ModelPresets.Presets);
    await this.runtime.ensurePresetReady(preset);
  }
```

In `shutdown`, after `await runtime.stopProcess();`:

```ts
    // An unelevated server shows a UAC prompt here; a declined one leaves the disk to the next start.
    try {
      await runtime.releaseRamDisk();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Could not remove the RAM disk: ${error instanceof Error ? error.message : String(error)}\n`);
    }
```

- [ ] **Step 4: Run.** `node .\src\test-runner\run-tests.ts preset-runtime-coordinator managed-tabby` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/preset-runtime-coordinator.ts tests/preset-runtime-coordinator.test.ts
git commit -m "feat: loads see the configured presets and shutdown releases the RAM disk"
```

---

### Task 8: The real Arsenal driver with UAC elevation

**Files:**
- Create: `src/status-server/arsenal-ram-disk-driver.ts`
- Modify: `src/status-server/engine-process.ts` (`createSystemManagedEngineHost` adds `ramDisk: new ArsenalRamDiskDriver(new SystemPowerShellRunner())`)
- Test: `tests/arsenal-ram-disk-driver.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ArsenalRamDiskDriver, type PowerShellRunner } from '../src/status-server/arsenal-ram-disk-driver.ts';

/** Records each script and answers with a scripted result; never starts PowerShell. */
class RecordingRunner implements PowerShellRunner {
  readonly runs: Array<{ script: string; job: Record<string, string | number>; admin: boolean }> = [];
  readonly started: string[] = [];
  private readonly results: string[];
  constructor(results: string[]) {
    this.results = results;
  }
  async run(script: string, job: Record<string, string | number>, admin: boolean): Promise<string> {
    this.runs.push({ script, job, admin });
    return this.results.shift() ?? 'null';
  }
  start(script: string): void {
    this.started.push(script);
  }
}

test('find reads the SiftKitCache volume on an Arsenal disk without elevation', async () => {
  const runner = new RecordingRunner(['{"letter":"S","sizeBytes":25200427008}']);
  assert.deepEqual(await new ArsenalRamDiskDriver(runner).find(), { letter: 'S', root: 'S:\\', sizeBytes: 25_200_427_008 });
  assert.equal(runner.runs[0]?.admin, false);
  assert.match(runner.runs[0]?.script ?? '', /VolumeName='SiftKitCache'/u);
  assert.match(runner.runs[0]?.script ?? '', /-like 'Arsenal Virtual\*'/u);
});

test('create, grow, and remove run aim_ll as administrator with the tool, letter, and size as job values', async () => {
  const runner = new RecordingRunner(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
  const driver = new ArsenalRamDiskDriver(runner);
  const disk = await driver.create('C:\\aim\\aim_ll.exe', 'S', 1024);
  await driver.grow('C:\\aim\\aim_ll.exe', disk, 2048);
  await driver.remove('C:\\aim\\aim_ll.exe', disk);
  assert.deepEqual(runner.runs.map((entry) => [entry.admin, entry.job]), [
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S', sizeBytes: 1024 }],
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S', sizeBytes: 2048 }],
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S', sizeBytes: 0 }],
  ]);
  assert.match(runner.runs[0]?.script ?? '', /-a -t file -o awe -s \$\(\$job\.sizeBytes\)/u);
  assert.match(runner.runs[0]?.script ?? '', /\/v:SiftKitCache/u);
  assert.match(runner.runs[1]?.script ?? '', /-e -s/u);
  assert.match(runner.runs[1]?.script ?? '', /Resize-Partition/u);
  assert.match(runner.runs[2]?.script ?? '', /'-d'/u);
});

test('a script error, or a declined UAC prompt, fails the operation with its message', async () => {
  const driver = new ArsenalRamDiskDriver(new RecordingRunner(['{"error":"The operation was canceled by the user."}']));
  await assert.rejects(driver.create('C:\\aim\\aim_ll.exe', 'S', 1024), /RAM disk create failed: The operation was canceled by the user\./u);
});
```

- [ ] **Step 2: Run; it fails** — `node .\src\test-runner\run-tests.ts arsenal-ram-disk-driver` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/status-server/arsenal-ram-disk-driver.ts`

```ts
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseJsonValueText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import type { RamDisk, RamDiskDriver } from './ram-disk-cache.ts';

const execFileAsync = promisify(execFile);
type Job = Record<string, string | number>;

/** Runs a PowerShell script with a job file; `admin` scripts run elevated, through UAC when this process is not. */
export interface PowerShellRunner {
  /** Returns what the script wrote to its result file. */
  run(script: string, job: Job, admin: boolean): Promise<string>;
  /** Starts an admin script without waiting, for the process-exit path. */
  start(script: string, job: Job): void;
}

const FoundSchema = z.object({ letter: z.string().regex(/^[A-Z]$/u), sizeBytes: z.number().int().positive() }).nullable();
const DoneSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ error: z.string() })]);

// Every script reads its job, writes JSON to $job.resultPath, and reports a thrown error as {"error": ...}.
const PRELUDE = String.raw`param([string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -Raw -Encoding utf8 $JobPath | ConvertFrom-Json
function Write-Result($value) { ConvertTo-Json -Compress -InputObject $value | Set-Content -Encoding utf8 $job.resultPath }
# aim_ll writes progress to stderr, so it runs through Start-Process with both streams to files (as smol-helper does).
function Invoke-Aim([string[]]$arguments) {
  $log = [IO.Path]::GetTempFileName()
  try {
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $process = Start-Process -FilePath $job.tool -ArgumentList $quoted -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $process.ExitCode
  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $log, "$log.err" }
}
try {
`;
const POSTLUDE = String.raw`
} catch { Write-Result @{ error = $_.Exception.Message } }
`;

const FIND = String.raw`
  $volume = Get-CimInstance Win32_LogicalDisk -Filter "VolumeName='SiftKitCache'" | Select-Object -First 1
  $found = $null
  if ($volume) {
    $partition = Get-CimAssociatedInstance -InputObject $volume -ResultClassName Win32_DiskPartition | Select-Object -First 1
    $drive = if ($partition) { Get-CimAssociatedInstance -InputObject $partition -ResultClassName Win32_DiskDrive | Select-Object -First 1 }
    if ($drive -and $drive.Model -like 'Arsenal Virtual*') { $found = @{ letter = $volume.DeviceID.Substring(0, 1); sizeBytes = [int64]$drive.Size } }
  }
  Write-Result $found
`;

const CREATE = String.raw`
  $root = "$($job.letter):\"
  if (Test-Path $root) { throw "Drive $($job.letter): is already in use." }
  $code = Invoke-Aim @('-a', '-t', 'file', '-o', 'awe', '-s', "$($job.sizeBytes)", '-m', "$($job.letter):", '-p', '/fs:ntfs /q /y /v:SiftKitCache')
  if ($code -ne 0) { throw "aim_ll -a exited $code." }
  for ($try = 0; $try -lt 40 -and -not (Test-Path $root); $try++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path $root)) { throw "The RAM disk $($job.letter): did not appear." }
  Write-Result @{ ok = $true }
`;

const GROW = String.raw`
  $code = Invoke-Aim @('-e', '-s', "$($job.sizeBytes)", '-m', "$($job.letter):")
  if ($code -ne 0) { throw "aim_ll -e exited $code." }
  Update-HostStorageCache
  Resize-Partition -DriveLetter $job.letter -Size (Get-PartitionSupportedSize -DriveLetter $job.letter).SizeMax
  Write-Result @{ ok = $true }
`;

const REMOVE = String.raw`
  $code = Invoke-Aim @('-d', '-m', "$($job.letter):")
  if ($code -ne 0 -and (Test-Path "$($job.letter):\")) { $code = Invoke-Aim @('-D', '-m', "$($job.letter):") }
  if (Test-Path "$($job.letter):\") { throw "Could not remove the RAM disk $($job.letter): (aim_ll exit $code)." }
  Write-Result @{ ok = $true }
`;

const script = (body: string): string => `${PRELUDE}${body}${POSTLUDE}`;

/** SiftKit's RAM disk through Arsenal Image Mounter's aim_ll; the disk is NTFS, labelled SiftKitCache. */
export class ArsenalRamDiskDriver implements RamDiskDriver {
  private readonly runner: PowerShellRunner;

  constructor(runner: PowerShellRunner) {
    this.runner = runner;
  }

  async find(): Promise<RamDisk | null> {
    const found = FoundSchema.parse(parseJsonValueText(await this.runner.run(script(FIND), {}, false)));
    return found === null ? null : { letter: found.letter, root: `${found.letter}:\\`, sizeBytes: found.sizeBytes };
  }

  async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    await this.admin('create', CREATE, { tool: toolPath, letter, sizeBytes });
    return { letter, root: `${letter}:\\`, sizeBytes };
  }

  async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    await this.admin('grow', GROW, { tool: toolPath, letter: disk.letter, sizeBytes });
    return { ...disk, sizeBytes };
  }

  async remove(toolPath: string, disk: RamDisk): Promise<void> {
    await this.admin('remove', REMOVE, { tool: toolPath, letter: disk.letter, sizeBytes: 0 });
  }

  removeDetached(toolPath: string, disk: RamDisk): void {
    this.runner.start(script(REMOVE), { tool: toolPath, letter: disk.letter, sizeBytes: 0 });
  }

  private async admin(operation: string, body: string, job: Job): Promise<void> {
    const done = DoneSchema.parse(parseJsonValueText(await this.runner.run(script(body), job, true)));
    if ('error' in done) throw new Error(`RAM disk ${operation} failed: ${done.error}`);
  }
}

/** Writes the script and its job to the temp directory and runs it, elevated through UAC when it must be. */
export class SystemPowerShellRunner implements PowerShellRunner {
  private elevated: boolean | null = null;

  async run(script: string, job: Job, admin: boolean): Promise<string> {
    const files = this.write(script, job);
    try {
      const elevate = admin && !await this.isElevated();
      // A declined UAC prompt makes Start-Process throw, so the outer PowerShell exits non-zero.
      const args = elevate
        ? ['-NoProfile', '-Command', `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${files.script}" -JobPath "${files.job}"'; exit $p.ExitCode`]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', files.script, '-JobPath', files.job];
      try {
        await execFileAsync('powershell.exe', args, { windowsHide: true });
      } catch (error) {
        if (!fs.existsSync(files.result)) throw new Error(`The RAM disk script did not run: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!fs.existsSync(files.result)) throw new Error('The RAM disk script wrote no result.');
      return fs.readFileSync(files.result, 'utf8').replace(/^\uFEFF/u, '');
    } finally {
      for (const file of [files.script, files.job, files.result]) fs.rmSync(file, { force: true });
    }
  }

  start(script: string, job: Job): void {
    const files = this.write(script, job);
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${files.script}" -JobPath "${files.job}"'`],
    { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  private write(script: string, job: Job): { script: string; job: string; result: string } {
    const base = path.join(os.tmpdir(), `siftkit-ram-disk-${randomUUID()}`);
    const files = { script: `${base}.ps1`, job: `${base}.json`, result: `${base}.result.json` };
    fs.writeFileSync(files.script, script, 'utf8');
    fs.writeFileSync(files.job, JSON.stringify({ ...job, resultPath: files.result }), 'utf8');
    return files;
  }

  private async isElevated(): Promise<boolean> {
    if (this.elevated === null) {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { windowsHide: true });
      this.elevated = stdout.trim() === 'True';
    }
    return this.elevated;
  }
}
```

`SystemPowerShellRunner` touches the real system and is covered by the live check (Task 10), not by node tests. The driver's script text and its result handling are unit-tested above.

`engine-process.ts`: import both classes and add `ramDisk: new ArsenalRamDiskDriver(new SystemPowerShellRunner()),` to `createSystemManagedEngineHost`.

- [ ] **Step 4: Run.** `node .\src\test-runner\run-tests.ts arsenal-ram-disk-driver` → PASS. Then run `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/arsenal-ram-disk-driver.ts src/status-server/engine-process.ts tests/arsenal-ram-disk-driver.test.ts
git commit -m "feat: Arsenal Image Mounter RAM disk driver with UAC elevation"
```

---

### Task 9: Dashboard toggle, size field, and help text

**Files:**
- Modify: `dashboard/src/settings-sections.ts` (labels), `dashboard/src/settings-draft-editor.ts` (`ModelIntegerField` gains `'RamDiskCacheGiB'`), `dashboard/src/tabs/settings/ModelPresetsSection.tsx` (cache controls near lines 244–266)
- Test: `dashboard/tests/ram-disk-preset-control.test.tsx` (new)

- [ ] **Step 1: Write the failing tests**

```tsx
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { CACHE_AUTO_LABEL, RAM_DISK_CACHE_LABEL, RAM_DISK_SIZE_LABEL } from '../src/settings-sections.ts';
import type { ModelProfileStatus } from '../src/settings-flow.ts';
import { FLASH_NEXT_GEOMETRY, GLM_PROFILE, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

const PROFILE = { ...GLM_PROFILE, recurrent: true, mla: false, cacheGeometry: FLASH_NEXT_GEOMETRY };
const RAM_DISK_PRESET = { ...MANAGED_PRESET, RamDiskCache: true, RamDiskCacheGiB: 11, NumCtx: 200_000, KvCacheQuantization: 'f16' as const,
  SpeculativeEnabled: true, DiskCacheCheckpointInterval: 2048 };
const identified: ModelProfileStatus = { state: 'identified', presetId: MANAGED_PRESET.id, profile: PROFILE };

test('with the RAM disk on, its size field replaces every other cache control and states the size of one full context', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps(RAM_DISK_PRESET, MODEL_PRESET_ACTIONS, null, identified)} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(RAM_DISK_SIZE_LABEL).value, '11');
  for (const hidden of [CACHE_AUTO_LABEL, 'CacheRam', 'CacheRecurrentRam']) assert.equal(screen.queryByLabelText(hidden), null, hidden);
  assert.equal(screen.queryByText('Disk cache directory'), null);
  assert.ok(screen.getByText('≈ 10.4 GiB per full 200k context: 5.0 GiB KV + 5.4 GiB of snapshots every 2048 tokens. '
    + 'All RAM-disk presets share one RAM disk, sized to their total.'));
});

test('without a profile the help asks for one; turning the RAM disk off brings the cache controls back', () => {
  const booleans: Array<[string, boolean]> = [];
  const { rerender } = render(<ModelPresetsSection {...modelPresetsSectionProps(RAM_DISK_PRESET, { ...MODEL_PRESET_ACTIONS,
    setBoolean: (field, value) => booleans.push([field, value]) })} />);
  assert.ok(screen.getByText('Profile the model to see its size per full context.'));
  fireEvent.click(screen.getByLabelText(RAM_DISK_CACHE_LABEL));
  assert.deepEqual(booleans, [['RamDiskCache', false]]);
  rerender(<ModelPresetsSection {...modelPresetsSectionProps({ ...RAM_DISK_PRESET, RamDiskCache: false })} />);
  assert.equal(screen.queryByLabelText(RAM_DISK_SIZE_LABEL), null);
  assert.ok(screen.getByLabelText('CacheRam'));
});
```

- [ ] **Step 2: Run; they fail** — `npm --prefix dashboard test -- ram-disk-preset-control` → FAIL (the labels are not exported).

- [ ] **Step 3: Implement**

`dashboard/src/settings-sections.ts`:

```ts
export const RAM_DISK_CACHE_LABEL = 'RAM disk cache';
export const RAM_DISK_SIZE_LABEL = 'RAM disk size (GB)';
```

`dashboard/src/settings-draft-editor.ts`: add `| 'RamDiskCacheGiB'` to `ModelIntegerField`. `ModelBooleanField` derives from the contract, so `RamDiskCache` is already settable.

`ModelPresetsSection.tsx`: import `resolveDiskCacheContextBytes` beside `resolveCacheTierSizes`, plus the two labels. Add above `ModelPresetsSection`:

```tsx
const GIB = 1024 ** 3;

/** The size of one full context in the disk tier, from the profiled geometry. */
function describeRamDiskContext(preset: DashboardModelRuntimePreset, profile: ModelProfile | null): string {
  if (profile === null) return 'Profile the model to see its size per full context.';
  const bytes = resolveDiskCacheContextBytes(preset, profile.cacheGeometry);
  if (typeof bytes === 'string') return `Cannot size: ${bytes}`;
  const gib = (value: number) => (value / GIB).toFixed(1);
  const snapshots = bytes.snapshotBytes === 0 ? '' : ` + ${gib(bytes.snapshotBytes)} GiB of snapshots every ${String(preset.DiskCacheCheckpointInterval)} tokens`;
  return `≈ ${gib(bytes.kvBytes + bytes.snapshotBytes)} GiB per full ${(preset.NumCtx / 1000).toFixed(0)}k context: `
    + `${gib(bytes.kvBytes)} GiB KV${snapshots}. All RAM-disk presets share one RAM disk, sized to their total.`;
}
```

In the memory group, insert this before the `CacheAuto` control. Then wrap the existing `CacheAuto`, `CacheContexts`, the two `CacheRamControl`s, `DiskCacheDir` and `DiskCacheSizeMiB` controls in `{preset.RamDiskCache ? null : (<>...</>)}`. `DiskCacheCheckpointInterval` stays outside the wrapper.

```tsx
          <ModelPresetControl preset={preset} profile={profile} field="RamDiskCache" label={RAM_DISK_CACHE_LABEL}>
            <label className="settings-live-toggle-control">
              <input type="checkbox" aria-label={RAM_DISK_CACHE_LABEL} checked={preset.RamDiskCache}
                onChange={(event) => modelPresetActions.setBoolean('RamDiskCache', event.target.checked)} />
              <span>{preset.RamDiskCache ? 'On' : 'Off'}</span>
            </label>
          </ModelPresetControl>
          {preset.RamDiskCache ? (
            <ModelPresetControl preset={preset} profile={profile} field="RamDiskCacheGiB" label={RAM_DISK_SIZE_LABEL}>
              <input type="number" min={1} aria-label={RAM_DISK_SIZE_LABEL} value={preset.RamDiskCacheGiB}
                onChange={(event) => modelPresetActions.setInteger('RamDiskCacheGiB', parseIntegerInput(event.target.value, preset.RamDiskCacheGiB))} />
              <span className="hint">{describeRamDiskContext(preset, profile)}</span>
            </ModelPresetControl>
          ) : null}
```

- [ ] **Step 4: Run.** `npm --prefix dashboard test` → PASS (the new tests and every existing one, including `cache-auto-preset-control`). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src dashboard/tests/ram-disk-preset-control.test.tsx
git commit -m "feat: dashboard RAM disk toggle, size field, and per-context size"
```

---

### Task 10: Full verification, live check, and calibration

This task runs on the real machine and is done by the primary agent with the user present. UAC prompts need someone to approve them.

- [ ] **Step 1: Full suites.** Run the node suite, the process suite and the dashboard suite, each through `siftkit summary`, then run `npm run typecheck`. Expected: 0 failures.
- [ ] **Step 2: Configure.**
  - Set `Server.Engines.Exl3.RamDisk.ToolPath` to `C:\Users\denys\Documents\GitHub\jellyfin\smol-helper\aim\aim_ll.exe` and `DriveLetter` to `S`.
  - Set both presets (`exl3-3-8-next-3-5bpw-f16`, `exl3-3-8-27b-5bpw`) to `RamDiskCache: true` with `RamDiskCacheGiB` at the spec estimate rounded up: 11 and 10.
  - Restart the stable server unelevated.
- [ ] **Step 3: Disk lifecycle.**
  - Activating Flash-Next shows one UAC prompt. Then `S:` exists with the label `SiftKitCache`, `S:\siftkit-owner.json` holds the server pid, and `S:\exl3-3-8-next-3-5bpw-f16` exists.
  - The TabbyAPI log reports the disk cache directory.
  - Raise one budget by 1 GiB and switch presets. Check whether growing worked (no `ram_disk_recreated` warning, and the disk size grew) and record the result in the spec's Risks.
- [ ] **Step 4: Calibration (the spec's "Calibration on this machine").**
  - Fill Flash-Next to about `NumCtx` minus the response reserve with one prompt. Swap to the 27B and fill it the same way. Swap back to Flash-Next, re-send its prompt plus one turn, then do the same for the 27B.
  - Each time, read TabbyAPI's cache line ("+N more on disk", "% from disk") and the prompt-eval token count.
  - Record each preset folder's size after its full-context run (`Get-ChildItem S:\<id> -Recurse | Measure-Object Length -Sum`).
  - If a prompt does not survive, raise that preset's budget and repeat. Before raising further, check whether the 0.2 staging contexts or the snapshot spacing is the limit.
  - Set both presets to the smallest values that survive two full rounds, plus 10% headroom.
  - Write a "Calibration results" section into the spec with the measured folder sizes against the estimate, the final budgets, and the survival evidence (log lines).
- [ ] **Step 5: Shutdown.** Stop the stable server and approve the UAC prompt; `S:` is gone. Start it again with `S:` planted by an earlier crash (kill the server process): the first engine start removes it with the warning `ram_disk_leftover_removed`.
- [ ] **Step 6: Clean up** any scratch files, then report results, changed files and remaining risks.
