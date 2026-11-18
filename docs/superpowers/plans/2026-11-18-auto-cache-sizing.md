# Auto Cache Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model preset can size `CacheRam` and `CacheRecurrentRam` from the model's `config.json` for a chosen number of full contexts (`CacheAuto` + `CacheContexts`).

**Architecture:**
- `inspectModelDirectory` derives a `cacheGeometry`, or a reason string when it can't.
- A pure `resolveCacheTierSizes` in `src/inference-presets/cache-sizing.ts` turns geometry plus preset into MiB. Both the launch environment and the dashboard form use it.
- Two strict preset fields, added by a schema 91 → 92 upgrade, switch it on.

**Tech Stack:** TypeScript, Zod, node:test (server), vitest + React Testing Library (dashboard), better-sqlite3 schema upgrades.

**Spec:** `docs/superpowers/specs/2026-11-18-auto-cache-sizing-design.md`

**Rules:**
- No `any`, no type assertions, no `!`.
- Comments are 1–2 lines.
- Test commands come from the repo runner, `node .\src\test-runner\run-tests.ts <file>`; dashboard tests run through `npx vitest run <file>` in `dashboard/`.
- Do not commit; the user commits.

---

## File map

| File | Change |
|---|---|
| `packages/contracts/src/model-profile.ts` | `CacheGeometrySchema`, `ModelProfile.cacheGeometry` |
| `src/inference-presets/model-profile-inspector.ts` | derive geometry |
| `src/inference-presets/cache-sizing.ts` (new) | `resolveCacheTierSizes`, `resolveProfileCacheSizes` |
| `packages/contracts/src/config.ts` | `CacheAuto`, `CacheContexts`, field list, disk-cache rule |
| `src/config/constants.ts`, `src/config/defaults.ts`, `src/config/normalization.ts` | defaults and strict parsing |
| `src/inference-presets/preset-compatibility.ts` | field support entries |
| `src/state/schema-upgrades/model-preset-cache-auto.ts` (new), `src/state/runtime-db.ts` | 91 → 92 |
| `src/inference-presets/exl3-preset-adapter.ts` | launch env uses resolved sizes |
| `dashboard/src/settings-sections.ts`, `dashboard/src/settings-draft-editor.ts`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx` | form |
| tests | listed per task |

---

### Task 1: Model cache geometry

**Files:**
- Modify: `packages/contracts/src/model-profile.ts`, `src/inference-presets/model-profile-inspector.ts`
- Test: `tests/model-profile-inspector.test.ts`; profile fixtures in `tests/preset-model-relevance.test.ts`, `dashboard/tests/fixtures.ts`, `dashboard/tests/dashboard-model-presets-section.test.ts`

- [ ] **Step 1: Failing tests.** Add to `tests/model-profile-inspector.test.ts`, using its existing temp-dir and `config.json` writer pattern:

```ts
const HYBRID_CONFIG = {
  architectures: ['Qwen3NextForCausalLM'],
  text_config: {
    num_hidden_layers: 4, num_attention_heads: 16, num_key_value_heads: 2, head_dim: 256, hidden_size: 2048,
    layer_types: ['linear_attention', 'linear_attention', 'linear_attention', 'full_attention'],
    linear_num_key_heads: 16, linear_num_value_heads: 48, linear_key_head_dim: 128, linear_value_head_dim: 128,
    linear_conv_kernel_dim: 4, mtp_num_hidden_layers: 1,
  },
};

test('a hybrid model declares its KV and recurrent snapshot geometry', () => {
  const profile = inspectModelDirectory(writeModel(HYBRID_CONFIG));
  // 3 linear layers × (10240 × 4 × 2 + 48 × 128 × 128 × 2) bytes of fp16 state
  assert.deepEqual(profile.cacheGeometry, { attentionLayers: 1, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 4_964_352 });
});

test('a dense model derives head_dim and has no recurrent snapshots', () => {
  const profile = inspectModelDirectory(writeModel({ architectures: ['LlamaForCausalLM'], num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096 }));
  assert.deepEqual(profile.cacheGeometry, { attentionLayers: 32, kvTokenDim: 1024, mtpLayers: 0, recurrentSnapshotBytes: 0 });
});

test('cache geometry names why it cannot be derived', () => {
  assert.equal(inspectModelDirectory(writeModel({ architectures: ['Fake'] })).cacheGeometry, 'config.json has no num_hidden_layers');
  assert.equal(inspectModelDirectory(writeModel({ architectures: ['DeepseekV3ForCausalLM'], num_hidden_layers: 2, kv_lora_rank: 512 })).cacheGeometry,
    'MLA attention (kv_lora_rank) is not modelled');
  assert.equal(inspectModelDirectory(writeModel({ architectures: ['X'], num_hidden_layers: 1, layer_types: ['mamba'], num_key_value_heads: 1, head_dim: 64 })).cacheGeometry,
    "layer type 'mamba' is not modelled");
  const { linear_conv_kernel_dim: _dropped, ...noKernel } = HYBRID_CONFIG.text_config;
  assert.equal(inspectModelDirectory(writeModel({ architectures: ['Qwen3NextForCausalLM'], text_config: noKernel })).cacheGeometry,
    'config.json has no linear_conv_kernel_dim');
});
```

If the file has no `writeModel(config)` helper, add one: make a managed temp dir, write `config.json` with `JSON.stringify(config)`, and return the dir. Check the arithmetic: 3 × (10240·8 + 1,572,864) = 3 × 1,654,784 = 4,964,352.

- [ ] **Step 2: Run them; they fail.** `node .\src\test-runner\run-tests.ts tests\model-profile-inspector.test.ts`. Expect failures on `cacheGeometry` (undefined).

- [ ] **Step 3: Contract.** In `packages/contracts/src/model-profile.ts`:

```ts
/** What one cached token and one recurrent snapshot cost, as exllamav3 lays them out. */
export const CacheGeometrySchema = z.object({
  attentionLayers: z.number().int().nonnegative(), kvTokenDim: z.number().positive(),
  mtpLayers: z.number().int().nonnegative(), recurrentSnapshotBytes: z.number().int().nonnegative(),
}).strict();
export type CacheGeometry = z.infer<typeof CacheGeometrySchema>;
```

Add `cacheGeometry: z.union([CacheGeometrySchema, z.string()]),` to `ModelProfileSchema`, with the comment `/** The cache geometry, or why config.json does not yield one. */`.

- [ ] **Step 4: Inspector.** In `model-profile-inspector.ts`:
  - Extend `TextConfigSchema` with optional numbers `num_hidden_layers`, `num_attention_heads`, `num_key_value_heads`, `hidden_size`, `head_dim`, and the five `linear_*` keys.
  - Add the derivation below.
  - Set `cacheGeometry: readCacheGeometry(text),` in the returned profile.

```ts
const KNOWN_LAYER_TYPES = new Set(['full_attention', 'sliding_attention', 'linear_attention']);
const LinearDimsSchema = z.object({
  linear_num_key_heads: z.number(), linear_num_value_heads: z.number(), linear_key_head_dim: z.number(),
  linear_value_head_dim: z.number(), linear_conv_kernel_dim: z.number(),
});
type TextConfig = z.infer<typeof TextConfigSchema>;

/** Bytes of one gated-delta-net layer's fp16 checkpoint: conv state plus recurrent state (exllamav3 get_checkpoint_size). */
function linearLayerSnapshotBytes(dims: z.infer<typeof LinearDimsSchema>): number {
  const qkvDim = 2 * dims.linear_num_key_heads * dims.linear_key_head_dim + dims.linear_num_value_heads * dims.linear_value_head_dim;
  return qkvDim * dims.linear_conv_kernel_dim * 2 + dims.linear_num_value_heads * dims.linear_key_head_dim * dims.linear_value_head_dim * 2;
}

function readCacheGeometry(text: TextConfig): CacheGeometry | string {
  if (isPositive(text.kv_lora_rank)) return 'MLA attention (kv_lora_rank) is not modelled';
  const unknownType = text.layer_types?.find((type) => !KNOWN_LAYER_TYPES.has(type));
  if (unknownType !== undefined) return `layer type '${unknownType}' is not modelled`;
  const layers = text.layer_types?.length ?? text.num_hidden_layers;
  if (layers === undefined) return 'config.json has no num_hidden_layers';
  // Hugging Face configs omit num_key_value_heads for plain multi-head attention.
  const kvHeads = text.num_key_value_heads ?? text.num_attention_heads;
  if (kvHeads === undefined) return 'config.json has no num_key_value_heads';
  const headDim = text.head_dim ?? (text.hidden_size !== undefined && text.num_attention_heads !== undefined
    ? text.hidden_size / text.num_attention_heads : undefined);
  if (headDim === undefined) return 'config.json has no head_dim';
  const linearLayers = text.layer_types?.filter((type) => type === 'linear_attention').length ?? 0;
  let recurrentSnapshotBytes = 0;
  if (linearLayers > 0) {
    const dims = LinearDimsSchema.safeParse(text);
    if (!dims.success) return `config.json has no ${String(dims.error.issues[0]?.path[0])}`;
    recurrentSnapshotBytes = linearLayers * linearLayerSnapshotBytes(dims.data);
  }
  return {
    attentionLayers: layers - linearLayers, kvTokenDim: kvHeads * headDim,
    mtpLayers: text.mtp_num_hidden_layers ?? text.num_nextn_predict_layers ?? 0, recurrentSnapshotBytes,
  };
}
```

  Import `type CacheGeometry` from `@siftkit/contracts`.

- [ ] **Step 5: Profile fixtures.** Every `ModelProfile` literal must now carry `cacheGeometry`:
  - add `cacheGeometry: 'config.json has no num_hidden_layers',` to `GLM_PROFILE` in `dashboard/tests/fixtures.ts`;
  - add it to the profile literals in `tests/preset-model-relevance.test.ts`.

  Find the literals with `grep -rn "thinkingToggle:" tests dashboard/tests`. Update the `deepEqual` expectations in `tests/model-profile-inspector.test.ts` for their fixture configs.

- [ ] **Step 6: Run and pass.** Run the inspector test, `tests\preset-model-relevance.test.ts`, and `npm run typecheck`.

---

### Task 2: Sizing function

**Files:**
- Create: `src/inference-presets/cache-sizing.ts`
- Test: `tests/cache-sizing.test.ts` (new)

- [ ] **Step 1: Failing test** `tests/cache-sizing.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCacheTierSizes, resolveProfileCacheSizes } from '../src/inference-presets/cache-sizing.ts';
import { getDefaultConfigObject } from '../src/config/defaults.ts';

const FLASH_NEXT = { attentionLayers: 12, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 59_572_224 };
const base = { NumCtx: 200_000, CacheContexts: 1.5, KvCacheQuantization: 'f16', SpeculativeEnabled: true } as const;

test('Flash-Next at 1.5 contexts sizes both RAM tiers from its geometry', () => {
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, base), { cacheRamMiB: 7618, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, SpeculativeEnabled: false }), { cacheRamMiB: 7032, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, KvCacheQuantization: 'q8_0/q4_0' }), { cacheRamMiB: 3168, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, CacheContexts: 2.2 }), { cacheRamMiB: 11_172, recurrentRamMiB: 12_215 });
});

test('a dense model needs no recurrent RAM and sizes round up to a whole MiB', () => {
  const dense = { attentionLayers: 2, kvTokenDim: 64, mtpLayers: 0, recurrentSnapshotBytes: 0 };
  assert.deepEqual(resolveCacheTierSizes(dense, { ...base, NumCtx: 1000, CacheContexts: 1.1 }), { cacheRamMiB: 1, recurrentRamMiB: 0 });
});

test('a profile without geometry yields its reason, and none yields a not-profiled reason', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (preset === undefined) throw new Error('default config has a preset');
  assert.equal(resolveProfileCacheSizes(preset, null), 'the model has not been profiled');
  assert.equal(typeof resolveProfileCacheSizes(preset, null), 'string');
});
```

These golden values were computed independently in Node for 300,000 and 440,000 tokens: KV/token 26,624 / 24,576 / 11,072 B; 147 and 215 snapshots.

- [ ] **Step 2: Run; it fails** (module missing).

- [ ] **Step 3: Implement** `src/inference-presets/cache-sizing.ts`:

```ts
import type { CacheGeometry, ModelProfile, ModelRuntimePreset } from '@siftkit/contracts';
import { getExl3CacheModes } from './preset-compatibility.ts';

const MIB = 1024 * 1024;
/** exllamav3's default recurrent checkpoint spacing; architectures with wider spacing are over-provisioned. */
const RECURRENT_CHECKPOINT_TOKENS = 2048;

export type CacheTierSizes = { cacheRamMiB: number; recurrentRamMiB: number };
type SizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'CacheContexts' | 'KvCacheQuantization' | 'SpeculativeEnabled'>;

function kvBits(mode: string): readonly [number, number] | null {
  if (mode === 'FP16') return null;
  if (mode === 'Q8') return [8, 8];
  if (mode === 'Q4') return [4, 4];
  const match = /^(\d+),(\d+)$/u.exec(mode);
  if (match === null) throw new Error(`Unknown exllamav3 cache mode '${mode}'`);
  return [Number(match[1]), Number(match[2])];
}

/** Bytes of one token in one attention layer; quantized pages add one fp16 scale per 32 values of K and of V. */
function kvBytesPerLayerToken(mode: string, kvTokenDim: number): number {
  const bits = kvBits(mode);
  return bits === null ? 4 * kvTokenDim : (kvTokenDim * (bits[0] + bits[1])) / 8 + kvTokenDim / 8;
}

/** RAM-tier sizes holding CacheContexts full contexts: KV pages of target and draft caches, and recurrent snapshots. */
export function resolveCacheTierSizes(geometry: CacheGeometry, preset: SizingPreset): CacheTierSizes {
  const modes = getExl3CacheModes(preset.KvCacheQuantization);
  const draftBytes = preset.SpeculativeEnabled && modes.draft !== null
    ? geometry.mtpLayers * kvBytesPerLayerToken(modes.draft, geometry.kvTokenDim) : 0;
  const tokenBytes = geometry.attentionLayers * kvBytesPerLayerToken(modes.cache, geometry.kvTokenDim) + draftBytes;
  const tokens = preset.CacheContexts * preset.NumCtx;
  const snapshots = Math.ceil(tokens / RECURRENT_CHECKPOINT_TOKENS);
  return {
    cacheRamMiB: Math.ceil((tokens * tokenBytes) / MIB),
    recurrentRamMiB: Math.ceil((snapshots * geometry.recurrentSnapshotBytes) / MIB),
  };
}

/** The sizes for a profiled model, or why they cannot be computed. */
export function resolveProfileCacheSizes(preset: SizingPreset, profile: ModelProfile | null): CacheTierSizes | string {
  if (profile === null) return 'the model has not been profiled';
  return typeof profile.cacheGeometry === 'string' ? profile.cacheGeometry : resolveCacheTierSizes(profile.cacheGeometry, preset);
}
```

This needs `CacheContexts` on the preset type, which arrives in Task 3. Do Task 3, Steps 3–4, before running typecheck here. The node test runs without typecheck.

- [ ] **Step 4: Run; it passes.**

---

### Task 3: Preset fields, defaults, upgrade

**Files:**
- Modify: `packages/contracts/src/config.ts`, `src/config/constants.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`, `src/inference-presets/preset-compatibility.ts`, `src/state/runtime-db.ts`
- Create: `src/state/schema-upgrades/model-preset-cache-auto.ts`
- Test:
  - `tests/runtime-db-schema-cache-auto.test.ts` (new) and `tests/config-normalization.test.ts`;
  - every partial-preset test literal that carries `SparseDraftHead: 0`, plus `dashboard/tests/fixtures.ts`.

- [ ] **Step 1: Failing tests.**
  - Create `tests/runtime-db-schema-cache-auto.test.ts` by copying `tests/runtime-db-schema-sparse-draft-head.test.ts` and changing it as follows:
    - `schema91Presets()` strips `CacheAuto` and `CacheContexts`, and the seed sets `version = 91`.
    - Test 1: after open, every preset has `CacheAuto === false` and `CacheContexts === 1.1`.
    - Test 2: presets stored with `CacheAuto: true, CacheContexts: 1.5` keep both.
    - Test 3: unreadable presets throw `/Stored model presets are unreadable/` and the file stays at 91.
  - In `tests/config-normalization.test.ts`, next to the SparseDraftHead cases, add three assertions:
    - a preset missing `CacheAuto` throws `/Invalid CacheAuto/`;
    - a preset with `CacheContexts: 0` throws `/Invalid CacheContexts/`;
    - a preset with `CacheContexts: 1.5` keeps 1.5.
  - In the contracts or config-update tests that cover the disk-cache rule, add two cases:
    - `CacheAuto: true, CacheRam: 0` with `DiskCacheDir` set passes `ServerModelPresetsConfigSchema`;
    - `CacheAuto: false, CacheRam: 0` still fails.

  Find the existing case with `grep -rn "writes through the RAM tier" tests`.

- [ ] **Step 2: Run them; they fail.**

- [ ] **Step 3: Contract.** In `ModelPresetSettingsShape`, after `CacheRecurrentRam: z.number(),`:

```ts
  /** Size CacheRam and CacheRecurrentRam from the model for CacheContexts full contexts; the manual values are kept but unused. */
  CacheAuto: z.boolean(),
  /** Full NumCtx contexts the RAM tiers hold while CacheAuto is on. */
  CacheContexts: z.number().positive(),
```

  Add `'CacheAuto', 'CacheContexts',` after `'CacheRecurrentRam',` in `ModelPresetFieldSchema`. In the disk-cache block, change `if (preset.CacheRam <= 0)` to `if (!preset.CacheAuto && preset.CacheRam <= 0)`.

- [ ] **Step 4: Defaults and normalization.**
  - `constants.ts`, after `SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM`:

    ```ts
    /** New presets size their RAM tiers from the model. */
    export const SIFT_DEFAULT_CACHE_AUTO = true;
    /** One conversation plus headroom; two alternating conversations want 1.5. */
    export const SIFT_DEFAULT_CACHE_CONTEXTS = 1.1;
    ```

  - `defaults.ts`: import both and add `CacheAuto: SIFT_DEFAULT_CACHE_AUTO, CacheContexts: SIFT_DEFAULT_CACHE_CONTEXTS,` after `CacheRecurrentRam`.
  - `normalization.ts`, beside `getSparseDraftHead`:

    ```ts
    // Stored presets gain CacheAuto and CacheContexts in the 91 -> 92 upgrade, so a missing or bad value is corrupt config.
    function getCacheAuto(value: JsonValue): boolean {
      const parsed = ModelPresetSettingsSchema.shape.CacheAuto.safeParse(value);
      if (!parsed.success) throw new Error(`Invalid CacheAuto '${String(value)}'; expected true or false.`);
      return parsed.data;
    }

    function getCacheContexts(value: JsonValue): number {
      const parsed = ModelPresetSettingsSchema.shape.CacheContexts.safeParse(value);
      if (!parsed.success) throw new Error(`Invalid CacheContexts '${String(value)}'; expected a number above 0 (full contexts kept in RAM).`);
      return parsed.data;
    }
    ```

    and in `resolveModelPresetSettings`, after `CacheRecurrentRam`: `CacheAuto: getCacheAuto(input.CacheAuto), CacheContexts: getCacheContexts(input.CacheContexts),`.
  - `preset-compatibility.ts` `PRESET_FIELD_SUPPORT`: `CacheAuto: 'managed-only', CacheContexts: 'managed-only',`.

- [ ] **Step 5: Upgrade.** Create `src/state/schema-upgrades/model-preset-cache-auto.ts` as a copy of `model-preset-sparse-draft-head.ts` with these changes:
  - the doc comment: `/** Schema 91 -> 92: model presets gain CacheAuto and CacheContexts; stored presets keep their manual MiB sizes. */`;
  - the comment: `// Pins only what this step needs from schema-91 model presets: a list of objects.`;
  - the function `upgradeModelPresetCacheAuto`;
  - the map: `('CacheAuto' in preset ? preset : { ...preset, CacheAuto: false, CacheContexts: 1.1 })`.

  In `runtime-db.ts`:
  - import it;
  - set `CURRENT_SCHEMA_VERSION = 92`;
  - add `{ from: 91, apply: upgradeModelPresetCacheAuto },`.

  In `tests/runtime-db-schema-sparse-draft-head.test.ts`, `schema90Presets()` must also strip the two new fields, because a schema-90 file never had them.

- [ ] **Step 6: Fixtures.** Partial presets now need the two strict fields:

```bash
grep -rl "SparseDraftHead: 0" tests dashboard/tests | xargs sed -i 's/SparseDraftHead: 0\([,}]\)/SparseDraftHead: 0, CacheAuto: false, CacheContexts: 1.1\1/g'
```

  Then check each hit:
  - `git diff --stat`;
  - `git diff | grep "^+" | grep -v "CacheAuto: false, CacheContexts: 1.1"`, which must show no other change;
  - `config-update-endpoint.e2e.test.ts` and `model-preset-adapters.test.ts` compare whole presets; adjust them by hand if a full-object literal fails.

  Check for CRLF drift on every touched file (see the CRLF note below).

- [ ] **Step 7: Run and pass:**
  - the new upgrade test, `config-normalization`, the sparse-draft-head upgrade test, and `config-update-endpoint.e2e`;
  - then `npm run typecheck`.

---

### Task 4: Launch environment

**Files:**
- Modify: `src/inference-presets/exl3-preset-adapter.ts`, `tests/helpers/managed-engine-fixtures.ts`
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Failing tests** in `tests/model-preset-adapters.test.ts`:
  - `createModelPreset` defaults to the default config (now Auto on). Set `CacheAuto: false` in its base, so the existing manual-value tests keep their meaning.
  - Add:

```ts
test('EXL3 adapter sizes the RAM tiers from the model when CacheAuto is on', () => {
  const modelRoot = createManagedTempDir('siftkit-cache-auto-');
  const modelPath = path.join(modelRoot, 'flash-next');
  fs.mkdirSync(modelPath);
  fs.writeFileSync(path.join(modelPath, 'config.json'), JSON.stringify(FLASH_NEXT_CONFIG));
  const preset = createModelPreset({ ModelPath: modelPath, CacheAuto: true, CacheContexts: 1.5, NumCtx: 200_000,
    KvCacheQuantization: 'f16', SpeculativeEnabled: true, CacheRam: 1, CacheRecurrentRam: 1 });
  const environment = new Exl3PresetAdapter(modelRoot).buildLaunchEnvironment(preset);
  assert.equal(environment.TABBY_MEMORY_SYSMEM_KV_CACHE, '7618');
  assert.equal(environment.TABBY_MEMORY_SYSMEM_RECURRENT_CACHE, '8352');
});

test('EXL3 adapter refuses CacheAuto for a model whose cache geometry is unknown', () => {
  const modelRoot = createManagedTempDir('siftkit-cache-auto-');
  const modelPath = path.join(modelRoot, 'fake');
  fs.mkdirSync(modelPath);
  fs.writeFileSync(path.join(modelPath, 'config.json'), JSON.stringify({ architectures: ['Fake'] }));
  assert.throws(() => new Exl3PresetAdapter(modelRoot).buildLaunchEnvironment(createModelPreset({ ModelPath: modelPath, CacheAuto: true })),
    /CacheAuto cannot size .*fake: config.json has no num_hidden_layers/u);
});
```

  `FLASH_NEXT_CONFIG` is the real model's text config:
  - 48 layers: `layer_types` repeats `['linear_attention','linear_attention','linear_attention','full_attention']` 12 times;
  - `num_key_value_heads: 2`, `head_dim: 256`, `num_attention_heads: 16`;
  - linear dims 16/48/128/128/4;
  - `mtp_num_hidden_layers: 1`.

  Snapshot = 36 × 1,654,784 = 59,572,224, matching Task 2.

- [ ] **Step 2: Run; they fail.**

- [ ] **Step 3: Implement.** In the adapter, import `resolveProfileCacheSizes` and `type CacheTierSizes`, then add:

```ts
  /** The preset's manual RAM-tier sizes, or with CacheAuto the sizes the model's geometry needs. */
  private getCacheTierSizes(preset: ModelRuntimePreset): CacheTierSizes {
    if (!preset.CacheAuto) return { cacheRamMiB: preset.CacheRam, recurrentRamMiB: preset.CacheRecurrentRam };
    const modelDirectory = win32.resolve(this.modelRoot, this.getRelativeModelPath(preset));
    const sizes = resolveProfileCacheSizes(preset, inspectModelDirectory(modelDirectory));
    if (typeof sizes === 'string') throw new Error(`preset=${preset.id} backend=exl3 CacheAuto cannot size ${modelDirectory}: ${sizes}`);
    return sizes;
  }
```

  In `buildLaunchEnvironment`:
  - add `const cacheSizes = this.getCacheTierSizes(preset);`;
  - use `String(cacheSizes.cacheRamMiB)` and `String(cacheSizes.recurrentRamMiB)` for the two env vars.

- [ ] **Step 4: Fake engine fixtures.** Default presets are now Auto, so the fake model needs geometry. In both `config.json` writes in `tests/helpers/managed-engine-fixtures.ts`, use:

```ts
JSON.stringify({ architectures: ['FakeForCausalLM'], num_hidden_layers: 2, num_attention_heads: 4, num_key_value_heads: 2, hidden_size: 256 })
```

  `tests/managed-tabby.test.ts:240` expects `String(fixture.exl3Preset.CacheRam)`. Read how `exl3Preset` is built there:
  - if it comes from defaults, set `CacheAuto: false` in that fixture preset, so the test keeps asserting manual pass-through;
  - otherwise leave it.

  Also check `tests/exl3-vision-preflight.test.ts` `createModelPreset` and set `CacheAuto: false` there.

- [ ] **Step 5: Run and pass:** `model-preset-adapters`, `managed-tabby`, `exl3-vision-preflight`, `model-profile-inspector`, then typecheck.

---

### Task 5: Dashboard form

**Files:**
- Modify: `dashboard/src/settings-sections.ts`, `dashboard/src/settings-draft-editor.ts`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Test: `dashboard/tests/cache-auto-preset-control.test.tsx` (new), `dashboard/tests/dashboard-model-presets-section.test.ts`, `tests/settings-sections.test.ts`

- [ ] **Step 1: Failing test** `dashboard/tests/cache-auto-preset-control.test.tsx`, following `sparse-draft-head-preset-control.test.tsx`:

```tsx
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { CACHE_AUTO_LABEL, CACHE_CONTEXTS_LABEL } from '../src/settings-sections.ts';
import { GLM_PROFILE, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

const FLASH_NEXT_PROFILE = { ...GLM_PROFILE, recurrent: true,
  cacheGeometry: { attentionLayers: 12, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 59_572_224 } };
const AUTO_PRESET = { ...MANAGED_PRESET, CacheAuto: true, CacheContexts: 1.5, NumCtx: 200_000, KvCacheQuantization: 'f16' as const, SpeculativeEnabled: true };
const identified = { state: 'identified' as const, presetId: MANAGED_PRESET.id, profile: FLASH_NEXT_PROFILE };

test('with Auto on, the RAM inputs are disabled and show the computed sizes', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, MODEL_PRESET_ACTIONS, null, identified)} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>('CacheRam').disabled, true);
  assert.equal(screen.getByLabelText<HTMLInputElement>('CacheRam').value, '7618');
  assert.equal(screen.getByLabelText<HTMLInputElement>('CacheRecurrentRam').value, '8352');
  assert.ok(screen.getByText('≈ 7.4 GiB'));
  assert.ok(screen.getByText('≈ 8.2 GiB'));
});

test('with Auto on and no geometry, the form shows why it cannot size', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, MODEL_PRESET_ACTIONS, null,
    { ...identified, profile: { ...FLASH_NEXT_PROFILE, cacheGeometry: 'config.json has no head_dim' } })} />);
  assert.equal(screen.getAllByText('Cannot auto-size: config.json has no head_dim').length, 2);
});

test('with Auto off, the RAM inputs edit the manual values and the contexts input is hidden', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...AUTO_PRESET, CacheAuto: false, CacheRam: 2048 })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>('CacheRam').disabled, false);
  assert.equal(screen.getByLabelText<HTMLInputElement>('CacheRam').value, '2048');
  assert.equal(screen.queryByLabelText(CACHE_CONTEXTS_LABEL), null);
});

test('the Auto checkbox and contexts input write the preset fields', () => {
  const booleans: Array<[string, boolean]> = [];
  const floats: Array<[string, number]> = [];
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, { ...MODEL_PRESET_ACTIONS,
    setBoolean: (field, value) => booleans.push([field, value]), setFloat: (field, value) => floats.push([field, value]) })} />);
  fireEvent.click(screen.getByLabelText(CACHE_AUTO_LABEL));
  fireEvent.change(screen.getByLabelText(CACHE_CONTEXTS_LABEL), { target: { value: '2.2' } });
  assert.deepEqual(booleans, [['CacheAuto', false]]);
  assert.deepEqual(floats, [['CacheContexts', 2.2]]);
});
```

  `modelPresetsSectionProps` gains an optional fourth parameter, `modelProfileStatus: ModelProfileStatus = { state: 'no-path' }`. `MANAGED_PRESET` in `dashboard/tests/fixtures.ts` gets the fields from Task 3, Step 6. In `tests/settings-sections.test.ts`, add `CACHE_AUTO_LABEL` and `CACHE_CONTEXTS_LABEL` after `'CacheRecurrentRam'` in the expected label list.

- [ ] **Step 2: Run; it fails.** `cd dashboard; npx vitest run tests/cache-auto-preset-control.test.tsx`.

- [ ] **Step 3: Help text.** In `settings-sections.ts`:
  - export `CACHE_AUTO_LABEL = 'Auto-size caches'` and `CACHE_CONTEXTS_LABEL = 'Full contexts in RAM'`;
  - after the `CacheRecurrentRam` entry, add:

```ts
      { label: CACHE_AUTO_LABEL, layout: 'quarter', helpText: 'Sizes CacheRam and CacheRecurrentRam from the model\'s config.json so the RAM tiers hold "Full contexts in RAM" contexts of NumCtx tokens. The manual values are kept for when this is off.' },
      { label: CACHE_CONTEXTS_LABEL, layout: 'quarter', helpText: 'Recommended: 1.1 for a single conversation. 1.5 when two alternate (e.g. orchestrator and worker): only the idle conversation\'s KV moves to RAM, but its last snapshot must outlast every per-request snapshot the active one makes.' },
```

  Append ` Disabled while Auto-size caches is on.` to the CacheRam and CacheRecurrentRam help texts.

- [ ] **Step 4: Draft editor.** In `settings-draft-editor.ts`, add `| 'CacheContexts'` to `ModelFloatField`. `CacheAuto` is a boolean, so `ModelBooleanField` covers it already.

- [ ] **Step 5: Form.** In `ModelPresetsSection.tsx`:
  - import `resolveProfileCacheSizes` from `'../../../../src/inference-presets/cache-sizing.ts'`, and the two labels;
  - compute once:

```tsx
  const autoCacheSizes = preset.CacheAuto ? resolveProfileCacheSizes(preset, profile) : null;
```

  Replace the CacheRam and CacheRecurrentRam controls with:

```tsx
          <ModelPresetControl preset={preset} profile={profile} field="CacheAuto" label={CACHE_AUTO_LABEL}>
            <label className="settings-live-toggle-control">
              <input type="checkbox" aria-label={CACHE_AUTO_LABEL} checked={preset.CacheAuto}
                onChange={(event) => modelPresetActions.setBoolean('CacheAuto', event.target.checked)} />
              <span>{preset.CacheAuto ? 'Auto' : 'Manual'}</span>
            </label>
          </ModelPresetControl>
          {preset.CacheAuto ? (
            <ModelPresetControl preset={preset} profile={profile} field="CacheContexts" label={CACHE_CONTEXTS_LABEL}>
              <input type="number" min={0.1} step={0.1} aria-label={CACHE_CONTEXTS_LABEL} value={preset.CacheContexts}
                onChange={(event) => modelPresetActions.setFloat('CacheContexts', parseFloatInput(event.target.value, preset.CacheContexts))} />
            </ModelPresetControl>
          ) : null}
          <CacheRamControl preset={preset} profile={profile} field="CacheRam" sizes={autoCacheSizes} modelPresetActions={modelPresetActions} />
          <CacheRamControl preset={preset} profile={profile} field="CacheRecurrentRam" sizes={autoCacheSizes} modelPresetActions={modelPresetActions} />
```

  and add the component beside `PresetIntegerControl`:

```tsx
/** A RAM tier in MiB: the manual value, or with Auto on the computed size (or why there is none). */
function CacheRamControl({ preset, profile, field, sizes, modelPresetActions }: {
  preset: DashboardModelRuntimePreset;
  profile: ModelProfile | null;
  field: 'CacheRam' | 'CacheRecurrentRam';
  sizes: CacheTierSizes | string | null;
  modelPresetActions: ModelPresetSettingsActions;
}) {
  const computed = sizes === null || typeof sizes === 'string' ? null : (field === 'CacheRam' ? sizes.cacheRamMiB : sizes.recurrentRamMiB);
  return (
    <ModelPresetControl preset={preset} profile={profile} field={field} label={field}>
      <input type="number" min={0} aria-label={field} disabled={sizes !== null} value={computed ?? preset[field]}
        onChange={(event) => modelPresetActions.setInteger(field, parseIntegerInput(event.target.value, preset[field]))} />
      {typeof sizes === 'string' ? <span className="field-note">Cannot auto-size: {sizes}</span> : null}
      {computed === null ? null : <span className="field-note">≈ {(computed / 1024).toFixed(1)} GiB</span>}
    </ModelPresetControl>
  );
}
```

  Import `type CacheTierSizes` from the cache-sizing module. If `field-note` is not an existing class, run `grep -rn "className=\"[a-z-]*note" dashboard/src` and reuse the class that styles small hint text.

- [ ] **Step 6: Existing test.** `dashboard/tests/dashboard-model-presets-section.test.ts` renders the default config (now Auto on):
  - in its `renderPreset`, set `preset.CacheAuto = false` so the `CacheRam` and `CacheRecurrentRam` "not disabled" assertions keep testing the managed manual path;
  - add one assertion that with `CacheAuto = true` both render `disabled`.

- [ ] **Step 7: Run and pass:**
  - the new test, `dashboard-model-presets-section`, `sparse-draft-head-preset-control`, and `tests\settings-sections.test.ts`;
  - `npm run typecheck`.

---

### Task 6: Verification and live check

- [ ] **Step 1: Suites.** Run each through `siftkit summary --question "pass/fail, failing tests with file:line"`:
  - `npm run typecheck`;
  - `npm run lint`;
  - `node .\src\test-runner\run-tests.ts` (default suite);
  - `cd dashboard; npx vitest run`.

  Every failure must be explained or fixed. The pre-existing ones are chat-overflow (hang) and "removed backend references".

- [ ] **Step 2: CRLF check.** Run `git diff --stat` and `git ls-files --eol` on the changed files. No file may change line endings against HEAD.

- [ ] **Step 3: Live.**
  1. Restart the stable status server so it runs the new code and applies 91 → 92. Stop task `ba84kp9ng`, then run `npm run start:status:stable` in the background.
  2. Confirm `runtime_schema.version = 92` and the active preset reads `CacheAuto: false, CacheContexts: 1.1`.
  3. In the dashboard, set preset `exl3-3-8-next-3-5bpw-f16` to Auto at 1.5 and save. The form must show CacheRam 7618 (≈ 7.4 GiB) and CacheRecurrentRam 8352 (≈ 8.2 GiB).
  4. Restart the engine through SiftKit. Read the newest `inference_runs` log chunks and confirm two things: the launch env carries `TABBY_MEMORY_SYSMEM_KV_CACHE=7618` and `TABBY_MEMORY_SYSMEM_RECURRENT_CACHE=8352`; and the engine's CPU page cache line reports about 7.4 GiB of slots, with the recurrent cache at about 8.2 GiB.
  5. Send one chat request and confirm it generates.

- [ ] **Step 4: Clean up.** Delete the files in `C:/tmp/rsx/scratch` created by this work. Report the changed files, the validation results, and the risks.

**CRLF note:** after Bash edits, a file whose HEAD version is LF must stay LF. Compare `git diff --stat` line counts; a whole-file diff means line endings flipped. Fix with `sed -i 's/\r$//' <file>`.
