# EXL3 Vision Preset Toggle + Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `VisionEnabled` preset field that controls whether the managed TabbyAPI process loads the EXL3 vision tower, and let images reach the model from `summary`, `repo-search`, `repo-agent` and dashboard chat.

**Architecture:** `VisionEnabled` joins the flat preset settings shape and becomes `TABBY_MODEL_VISION` in the EXL3 launch environment, which `managed-tabby.ts` already hashes into its restart signature. A single new module, `src/llm-protocol/image-attachments.ts`, owns data-URI validation, local-file reading, the `text` + `image_url` content-part builder, and the preset guard; every surface calls into it rather than reimplementing. Images persist inline as data URIs.

**Tech Stack:** TypeScript (strict, no casts, no `any`, no `!`), zod for every IO boundary, `node:test` + `node:assert/strict`, better-sqlite3 via `src/state/runtime-db.ts`, Preact/React for the dashboard.

**Reference spec:** [docs/superpowers/specs/2026-07-30-exl3-vision-preset-design.md](../specs/2026-07-30-exl3-vision-preset-design.md)

**Test command shape:** `npm run build:test && node .\dist\scripts\run-tests.js <suite-name>` where `<suite-name>` is the test file basename without `.test.ts`. Full suite: `npm test`. Typecheck: `npm run typecheck`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/inference-presets/exl3-model-capabilities.ts` | Reads a model directory's `config.json` and answers whether it has a vision tower. |
| `src/llm-protocol/image-attachments.ts` | Data-URI schema, local-file reader, user-content builder, preset guard, request-body parser. |
| `tests/image-attachments.test.ts` | Unit coverage for the module above. |
| `tests/exl3-vision-preflight.test.ts` | Adapter preflight against real fixture model directories. |
| `tests/image-input-surfaces.e2e.test.ts` | End-to-end: each surface puts an `image_url` part on the wire and rejects on preset mismatch. |

**Modified:** `packages/contracts/src/config.ts`, `src/config/{constants,defaults,normalization}.ts`, `src/inference-presets/{preset-compatibility,exl3-preset-adapter}.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/{transcript-manager,task-loop}.ts`, `src/repo-search/prompt-budget.ts`, `src/summary/{types.ts,planner/mode.ts}`, `src/status-server/{route-request-normalizers,chat-route-request-normalizers,chat}.ts`, `src/status-server/routes/core.ts`, `src/state/{runtime-db,chat-sessions}.ts`, `src/cli/{args,run-summary,run-repo-search,repo-agent-args,repo-agent-request}.ts`, `src/repo-agent/{run-schemas,worker}.ts`, `dashboard/src/{settings-draft-editor,settings-sections}.ts`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, `dashboard/src/tabs/ChatTab.tsx`, `tests/model-preset-adapters.test.ts`, `docs/exl3-performance-tuning-2026-07-21.md`.

---

## Task 1: `VisionEnabled` preset field

**Files:**
- Modify: `packages/contracts/src/config.ts:51-77`
- Modify: `src/config/constants.ts:41`
- Modify: `src/config/defaults.ts:40`
- Modify: `src/config/normalization.ts:68`, `:371`
- Test: `tests/config-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/config-normalization.test.ts`:

```typescript
test('VisionEnabled normalizes to a boolean and defaults to false', () => {
  const defaults = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!defaults) throw new Error('Default model preset is missing');
  assert.equal(defaults.VisionEnabled, false);

  const parsed = ModelRuntimePresetSchema.parse({ ...defaults, VisionEnabled: true });
  assert.equal(parsed.VisionEnabled, true);
});
```

Add `ModelRuntimePresetSchema` to the existing `@siftkit/contracts` import in that file if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js config-normalization`
Expected: FAIL — `Expected values to be strictly equal: undefined !== false`

- [ ] **Step 3: Add the field to the contract**

In `packages/contracts/src/config.ts`, inside `ManagedLlamaSettingsShape`, immediately after the `FlashAttention: z.boolean(),` entry on line 54:

```typescript
  VisionEnabled: z.boolean(),
```

In `ModelPresetFieldSchema` (line 67), add `'VisionEnabled'` to the enum immediately after `'FlashAttention'`:

```typescript
  'GpuLayers', 'Threads', 'NcpuMoe', 'FlashAttention', 'VisionEnabled', 'ParallelSlots', 'BatchSize', 'UBatchSize', 'CacheRam',
```

- [ ] **Step 4: Add the constant and default**

In `src/config/constants.ts`, after `SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION` (line 38):

```typescript
/** EXL3 only. Loading the vision tower costs ~890 MiB resident plus ~0.1 MiB per image token while encoding. */
export const SIFT_DEFAULT_VISION_ENABLED = false;
```

In `src/config/defaults.ts`, import the constant alongside the other `SIFT_DEFAULT_*` imports and add after `FlashAttention: true,` (line 40):

```typescript
    VisionEnabled: SIFT_DEFAULT_VISION_ENABLED,
```

- [ ] **Step 5: Add normalization**

In `src/config/normalization.ts`, after `FlashAttention: boolean;` (line 68):

```typescript
  VisionEnabled: boolean;
```

After the `FlashAttention` normalizer block (lines 371-373):

```typescript
    VisionEnabled: input.VisionEnabled === null || input.VisionEnabled === undefined
      ? Boolean(defaults.VisionEnabled)
      : Boolean(input.VisionEnabled),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js config-normalization`
Expected: PASS

Run: `npm run build:test && node .\dist\scripts\run-tests.js config-schema-contract contracts-config config`
Expected: PASS — these assert the full preset shape and will fail loudly if any fixture is missing the new key. Add `VisionEnabled: false` to any fixture the run reports as incomplete.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/config.ts src/config/constants.ts src/config/defaults.ts src/config/normalization.ts tests/config-normalization.test.ts
git commit -m "feat: add the VisionEnabled preset field"
```

---

## Task 2: Field availability per backend

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:68-132`
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/model-preset-adapters.test.ts`:

```typescript
test('VisionEnabled is EXL3-managed only', () => {
  const llama = createModelPreset({ Backend: 'llama' });
  assert.deepEqual(getPresetFieldAvailability(llama, 'VisionEnabled'), {
    enabled: false,
    reason: 'Not supported by llama.cpp',
  });

  const managed = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: false });
  assert.deepEqual(getPresetFieldAvailability(managed, 'VisionEnabled'), {
    enabled: true,
    reason: null,
  });

  const external = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: true });
  assert.deepEqual(getPresetFieldAvailability(external, 'VisionEnabled'), {
    enabled: false,
    reason: 'Requires SiftKit-managed TabbyAPI',
  });

  // The llama early-return must not have been widened into a blanket allow.
  assert.deepEqual(getPresetFieldAvailability(llama, 'GpuLayers'), { enabled: true, reason: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js model-preset-adapters`
Expected: FAIL — the llama case returns `{ enabled: true, reason: null }`

- [ ] **Step 3: Implement**

In `src/inference-presets/preset-compatibility.ts`, replace the llama early return (line 72) and extend the managed-only group (lines 75-84):

```typescript
  if (preset.Backend === 'llama') {
    return field === 'VisionEnabled'
      ? { enabled: false, reason: 'Not supported by llama.cpp' }
      : { enabled: true, reason: null };
  }

  if (field === 'UBatchSize') return { enabled: true, reason: null };
  if (
    field === 'ParallelSlots'
    || field === 'VisionEnabled'
    || field === 'SpeculativeEnabled'
    || field === 'SpeculativeType'
    || field === 'SpeculativeDraftMax'
  ) {
    return preset.ExternalServerEnabled
      ? { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' }
      : { enabled: true, reason: null };
  }
```

The `switch (field)` below is exhaustive over `ModelPresetField`; `'VisionEnabled'` is already handled above, so no `case` is needed and TypeScript stays satisfied.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\scripts\run-tests.js model-preset-adapters`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/preset-compatibility.ts tests/model-preset-adapters.test.ts
git commit -m "feat: gate VisionEnabled to managed EXL3 presets"
```

---

## Task 3: `TABBY_MODEL_VISION` in the launch environment

**Files:**
- Modify: `src/inference-presets/exl3-preset-adapter.ts:20-38`, `:71-83`
- Modify: `tests/model-preset-adapters.test.ts:46-58`, `:80-91`

- [ ] **Step 1: Update both `deepEqual` fixtures (they are the failing test)**

Both assertions compare the entire launch environment, so adding the key to the adapter without updating them fails the suite. Update them first so the test fails for the right reason.

`tests/model-preset-adapters.test.ts:46` — change the preset built at line 24 to include `VisionEnabled: true`, and add to the expected object after `TABBY_MODEL_CHUNK_SIZE`:

```typescript
    TABBY_MODEL_VISION: 'true',
```

`tests/model-preset-adapters.test.ts:80` — leave that preset's default (`false`) and add to the expected object after `TABBY_MODEL_CHUNK_SIZE`:

```typescript
    TABBY_MODEL_VISION: 'false',
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js model-preset-adapters`
Expected: FAIL — both `deepEqual` calls report a missing `TABBY_MODEL_VISION` key

- [ ] **Step 3: Implement**

In `src/inference-presets/exl3-preset-adapter.ts`, add to `Exl3LaunchEnvironmentSchema` after `TABBY_MODEL_CHUNK_SIZE` (line 27):

```typescript
  /**
   * Loads the EXL3 vision tower. Measured cost: ~890 MiB resident (the tower ships BF16 and is
   * not quantized by exl3) plus ~0.1 MiB per image token while encoding.
   */
  TABBY_MODEL_VISION: z.enum(['true', 'false']),
```

In `buildLaunchEnvironment`, after the `TABBY_MODEL_CHUNK_SIZE` entry (line 78):

```typescript
      TABBY_MODEL_VISION: preset.VisionEnabled ? 'true' : 'false',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\scripts\run-tests.js model-preset-adapters`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/exl3-preset-adapter.ts tests/model-preset-adapters.test.ts
git commit -m "feat: emit TABBY_MODEL_VISION from the EXL3 launch environment"
```

---

## Task 4: Vision-tower preflight

**Files:**
- Create: `src/inference-presets/exl3-model-capabilities.ts`
- Modify: `src/inference-presets/exl3-preset-adapter.ts:44-50`
- Test: `tests/exl3-vision-preflight.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/exl3-vision-preflight.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntimePresetSchema, type ModelRuntimePreset } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { Exl3PresetAdapter } from '../src/inference-presets/exl3-preset-adapter.js';

function createModelRoot(configJson: string | null): { root: string; modelPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'siftkit-exl3-'));
  const modelPath = join(root, 'model-dir');
  mkdirSync(modelPath);
  if (configJson !== null) {
    writeFileSync(join(modelPath, 'config.json'), configJson, 'utf8');
  }
  return { root, modelPath };
}

function createPreset(overrides: Partial<ModelRuntimePreset>): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, Backend: 'exl3', ...overrides });
}

test('VisionEnabled requires a vision_config in the model config', () => {
  const withTower = createModelRoot('{"vision_config":{"depth":27},"text_config":{}}');
  const withoutTower = createModelRoot('{"text_config":{}}');
  const noConfig = createModelRoot(null);
  try {
    const ok = new Exl3PresetAdapter(withTower.root);
    ok.validatePreset(createPreset({ ModelPath: withTower.modelPath, VisionEnabled: true }));

    const missingTower = new Exl3PresetAdapter(withoutTower.root);
    assert.throws(
      () => missingTower.validatePreset(createPreset({ ModelPath: withoutTower.modelPath, VisionEnabled: true })),
      /VisionEnabled=true but .* has no vision_config/u,
    );

    const missingConfig = new Exl3PresetAdapter(noConfig.root);
    assert.throws(
      () => missingConfig.validatePreset(createPreset({ ModelPath: noConfig.modelPath, VisionEnabled: true })),
      /VisionEnabled=true but .* has no vision_config/u,
    );

    // VisionEnabled=false must not read the filesystem at all.
    missingConfig.validatePreset(createPreset({ ModelPath: noConfig.modelPath, VisionEnabled: false }));
  } finally {
    rmSync(withTower.root, { recursive: true, force: true });
    rmSync(withoutTower.root, { recursive: true, force: true });
    rmSync(noConfig.root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js exl3-vision-preflight`
Expected: FAIL — `Missing expected exception`, because nothing checks the tower yet

- [ ] **Step 3: Create the capability reader**

Create `src/inference-presets/exl3-model-capabilities.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod';
import { parseJsonValueText } from '../lib/json.js';

const ModelConfigSchema = z.object({ vision_config: z.unknown() });

/** Reads an EXL3 model directory's `config.json` to answer capability questions about it. */
export class Exl3ModelCapabilities {
  hasVisionTower(modelDirectory: string): boolean {
    const configPath = win32.join(modelDirectory, 'config.json');
    let text: string;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch {
      return false;
    }
    const parsed = ModelConfigSchema.safeParse(parseJsonValueText(text));
    if (!parsed.success) return false;
    const visionConfig = parsed.data.vision_config;
    return typeof visionConfig === 'object' && visionConfig !== null;
  }
}
```

- [ ] **Step 4: Wire the preflight into the adapter**

In `src/inference-presets/exl3-preset-adapter.ts`, add the import:

```typescript
import { Exl3ModelCapabilities } from './exl3-model-capabilities.js';
```

Add a field to the class and extend `validatePreset`:

```typescript
export class Exl3PresetAdapter {
  private readonly capabilities = new Exl3ModelCapabilities();

  constructor(private readonly modelRoot: string) {}

  validatePreset(preset: ModelRuntimePreset): void {
    if (preset.Backend !== 'exl3') {
      throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot use the EXL3 adapter`);
    }
    this.getRelativeModelPath(preset);
    this.getCacheModes(preset);
    this.assertVisionTowerAvailable(preset);
  }

  private assertVisionTowerAvailable(preset: ModelRuntimePreset): void {
    if (!preset.VisionEnabled) return;
    const modelDirectory = win32.resolve(this.modelRoot, this.getRelativeModelPath(preset));
    if (!this.capabilities.hasVisionTower(modelDirectory)) {
      throw new Error(
        `preset=${preset.id} backend=exl3 VisionEnabled=true but ${modelDirectory} has no vision_config`,
      );
    }
  }
```

Keep the remaining private methods unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js exl3-vision-preflight model-preset-adapters`
Expected: PASS — the existing adapter tests use `VisionEnabled: false` except the one updated in Task 3. That one uses `ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B'`, which does not exist, so change it back to `VisionEnabled: false` and `TABBY_MODEL_VISION: 'false'`; the `'true'` value is covered by the fixture-backed test above and by Task 3's second fixture. If the run reports it, make that edit now.

- [ ] **Step 6: Commit**

```bash
git add src/inference-presets/exl3-model-capabilities.ts src/inference-presets/exl3-preset-adapter.ts tests/exl3-vision-preflight.test.ts tests/model-preset-adapters.test.ts
git commit -m "feat: reject VisionEnabled on models without a vision tower"
```

---

## Task 5: Dashboard preset control

**Files:**
- Modify: `dashboard/src/settings-draft-editor.ts:71-78`
- Modify: `dashboard/src/settings-sections.ts:124`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:283-289`
- Test: `tests/dashboard-managed-presets.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-managed-presets.test.ts` (match the file's existing import style for the draft reducer and its action type):

```typescript
test('set-model-boolean toggles VisionEnabled on the target preset', () => {
  const draft = createDraft();
  const presetId = draft.Server.ModelPresets.Presets[0]?.id;
  if (!presetId) throw new Error('Draft has no model preset');
  const next = applyDashboardSettingsDraftAction(draft, {
    type: 'set-model-boolean',
    presetId,
    field: 'VisionEnabled',
    value: true,
  });
  assert.equal(next.Server.ModelPresets.Presets[0]?.VisionEnabled, true);
});
```

The action carries `presetId` (see `settings-draft-editor.ts:117`). Reuse the draft-construction
helper that `tests/dashboard-managed-presets.test.ts` already defines instead of adding a new one;
`createDraft()` above is a stand-in for whatever that file names it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js dashboard-managed-presets`
Expected: FAIL — `'VisionEnabled'` is not assignable to `ModelBooleanField`

- [ ] **Step 3: Extend the boolean field union**

In `dashboard/src/settings-draft-editor.ts`, add to `ModelBooleanField` after `'FlashAttention'`:

```typescript
  | 'VisionEnabled'
```

- [ ] **Step 4: Add the section metadata**

In `dashboard/src/settings-sections.ts`, after the `Flash attention` entry (line 124):

```typescript
      { label: 'Vision (EXL3)', layout: 'quarter', helpText: 'Loads the EXL3 vision tower so the model can accept images. Costs about 890 MiB of VRAM while loaded, plus roughly 0.1 MiB per image token during encoding. Requires a model with a vision tower.' },
```

- [ ] **Step 5: Render the control**

In `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, immediately after the `Flash attention` field block (ends line 289):

```tsx
          <SettingsSectionField sectionId="model-presets" label="Vision (EXL3)">
            {renderCompatibilityControl(preset, 'VisionEnabled', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.VisionEnabled} onChange={(event) => modelPresetActions.setBoolean('VisionEnabled', event.target.checked)} />
                <span>{preset.VisionEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run build:test && node .\dist\scripts\run-tests.js dashboard-managed-presets`
Expected: PASS

Run: `npm run typecheck:dashboard-test`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/settings-draft-editor.ts dashboard/src/settings-sections.ts dashboard/src/tabs/settings/ModelPresetsSection.tsx tests/dashboard-managed-presets.test.ts
git commit -m "feat: expose the EXL3 vision toggle in the preset editor"
```

---

## Task 6: Image attachment module

**Files:**
- Create: `src/llm-protocol/image-attachments.ts`
- Modify: `src/config/constants.ts`
- Test: `tests/image-attachments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/image-attachments.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntimePresetSchema, type ModelRuntimePreset } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import {
  ImageAttachmentReader,
  assertPresetAcceptsImages,
  buildUserContent,
  parseImageDataUrls,
} from '../src/llm-protocol/image-attachments.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function createPreset(overrides: Partial<ModelRuntimePreset>): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, ...overrides });
}

test('ImageAttachmentReader encodes a local png as a data URI', () => {
  const root = mkdtempSync(join(tmpdir(), 'siftkit-img-'));
  const imagePath = join(root, 'shot.png');
  writeFileSync(imagePath, PNG_BYTES);
  try {
    const url = new ImageAttachmentReader().read(imagePath);
    assert.equal(url, `data:image/png;base64,${PNG_BYTES.toString('base64')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ImageAttachmentReader rejects unsupported extensions and missing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'siftkit-img-'));
  const bmpPath = join(root, 'shot.bmp');
  writeFileSync(bmpPath, PNG_BYTES);
  try {
    const reader = new ImageAttachmentReader();
    assert.throws(() => reader.read(bmpPath), /unsupported image extension \.bmp/u);
    assert.throws(() => reader.read(join(root, 'absent.png')), /cannot read image/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildUserContent returns a plain string without images and parts with them', () => {
  assert.equal(buildUserContent('hello', []), 'hello');
  assert.deepEqual(buildUserContent('hello', ['data:image/png;base64,AAAA']), [
    { type: 'text', text: 'hello' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});

test('parseImageDataUrls accepts valid arrays and rejects anything else', () => {
  assert.deepEqual(parseImageDataUrls(undefined), []);
  assert.deepEqual(parseImageDataUrls(['data:image/jpeg;base64,AAAA']), ['data:image/jpeg;base64,AAAA']);
  assert.throws(() => parseImageDataUrls(['https://example.com/a.png']), /not a supported image data URI/u);
  assert.throws(() => parseImageDataUrls('data:image/png;base64,AAAA'), /images must be an array/u);
});

test('assertPresetAcceptsImages requires an EXL3 preset with VisionEnabled', () => {
  assertPresetAcceptsImages(createPreset({ Backend: 'llama' }), 0);
  assert.throws(
    () => assertPresetAcceptsImages(createPreset({ Backend: 'llama' }), 1),
    /backend=llama cannot accept image input/u,
  );
  assert.throws(
    () => assertPresetAcceptsImages(createPreset({ Backend: 'exl3', VisionEnabled: false }), 1),
    /VisionEnabled=false cannot accept image input/u,
  );
  assertPresetAcceptsImages(createPreset({ Backend: 'exl3', VisionEnabled: true }), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-attachments`
Expected: FAIL — `Cannot find module '../src/llm-protocol/image-attachments.js'`

- [ ] **Step 3: Add the constants**

In `src/config/constants.ts`, after `SIFT_DEFAULT_VISION_ENABLED`:

```typescript
export const SIFT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Image tokens cannot be derived from a data URI without decoding the image, so the prompt
 * budget uses a flat per-image estimate. The engine's reported prompt token count is the
 * source of truth once the request completes.
 */
export const SIFT_IMAGE_TOKEN_ESTIMATE = 2048;
```

- [ ] **Step 4: Write the module**

Create `src/llm-protocol/image-attachments.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { ModelRuntimePreset } from '@siftkit/contracts';
import { SIFT_MAX_IMAGE_BYTES } from '../config/constants.js';
import type { LlamaCppContentPart } from './types.js';

const IMAGE_MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
} as const;

/** TabbyAPI's `common/image_util.py` accepts exactly this shape (or an http URL, which SiftKit never emits). */
export const ImageDataUrlSchema = z.string()
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u, 'not a supported image data URI');

const ImageDataUrlArraySchema = z.array(ImageDataUrlSchema);

/** Reads local image files and encodes them as data URIs for the OpenAI-compatible wire format. */
export class ImageAttachmentReader {
  read(path: string): string {
    const extension = extname(path).toLowerCase();
    const mime = Object.entries(IMAGE_MIME_BY_EXTENSION)
      .find(([candidate]) => candidate === extension)?.[1];
    if (mime === undefined) {
      throw new Error(
        `unsupported image extension ${extension || '(none)'} for ${path}; expected one of ${Object.keys(IMAGE_MIME_BY_EXTENSION).join(', ')}`,
      );
    }
    let bytes: Buffer;
    try {
      const stats = statSync(path);
      if (stats.size > SIFT_MAX_IMAGE_BYTES) {
        throw new Error(`image ${path} is ${stats.size} bytes, over the ${SIFT_MAX_IMAGE_BYTES} byte limit`);
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('image ')) throw error;
      throw new Error(`cannot read image ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }

  readAll(paths: readonly string[]): string[] {
    return paths.map((path) => this.read(path));
  }
}

/** Parses an `images` field off a request body. Throws rather than dropping malformed entries. */
export function parseImageDataUrls(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('images must be an array of image data URIs');
  }
  const parsed = ImageDataUrlArraySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`images rejected: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.data;
}

export function buildUserContent(
  text: string,
  images: readonly string[],
): string | LlamaCppContentPart[] {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

export function assertPresetAcceptsImages(preset: ModelRuntimePreset, imageCount: number): void {
  if (imageCount === 0) return;
  if (preset.Backend !== 'exl3') {
    throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot accept image input`);
  }
  if (!preset.VisionEnabled) {
    throw new Error(`preset=${preset.id} VisionEnabled=false cannot accept image input`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-attachments`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/llm-protocol/image-attachments.ts src/config/constants.ts tests/image-attachments.test.ts
git commit -m "feat: add the shared image attachment module"
```

---

## Task 7: Carry images on the initial task-loop turn

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:65-75`
- Modify: `src/repo-search/engine/transcript-manager.ts:14-24`
- Modify: `src/repo-search/engine/task-loop.ts:220-226`
- Modify: `src/repo-search/prompt-budget.ts:148`
- Test: `tests/engine-transcript-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-transcript-manager.test.ts` (match its existing import of `TranscriptManager`):

```typescript
test('TranscriptManager attaches images to the initial user turn', () => {
  const manager = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'describe this',
    initialUserImages: ['data:image/png;base64,AAAA'],
  });
  assert.deepEqual(manager.getMessages()[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  });
});

test('TranscriptManager keeps a plain string when there are no images', () => {
  const manager = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'plain',
    initialUserImages: [],
  });
  assert.deepEqual(manager.getMessages()[1], { role: 'user', content: 'plain' });
});
```

Both cases pass `historyMessages: []`, so the user turn is index 1 in both.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js engine-transcript-manager`
Expected: FAIL — `initialUserImages` is not a known property

- [ ] **Step 3: Widen the message content type**

In `src/repo-search/planner-protocol.ts`, add the import and widen `content` (line 67):

```typescript
import type { LlamaCppContentPart } from '../llm-protocol/types.js';
```

```typescript
export type ChatMessage = {
  role: LlamaCppChatRole;
  content?: string | LlamaCppContentPart[];
  reasoning_content?: string;
```

Both existing readers already narrow with `typeof message.content === 'string'` (`prompt-budget.ts:148`, `planner-protocol.ts:763`) and `planner-protocol.ts:412` passes the value straight through to the wire type, which already accepts parts. No other change is needed there.

- [ ] **Step 4: Accept images in the transcript manager**

In `src/repo-search/engine/transcript-manager.ts`:

```typescript
import { buildUserContent } from '../../llm-protocol/image-attachments.js';
```

```typescript
  constructor(options: {
    systemPromptContent: string;
    historyMessages: ChatMessage[];
    initialUserContent: string;
    initialUserImages: readonly string[];
  }) {
    this.messages = [
      { role: 'system', content: options.systemPromptContent },
      ...options.historyMessages,
      { role: 'user', content: buildUserContent(options.initialUserContent, options.initialUserImages) },
    ];
  }
```

- [ ] **Step 5: Thread the option through the task loop**

In `src/repo-search/engine/task-loop.ts`, add `initialUserImages?: readonly string[]` to the loop's options type next to `historyMessages`, then pass it at line 220:

```typescript
    this.transcript = new TranscriptManager({
      systemPromptContent,
      historyMessages: options.historyMessages || [],
      initialUserContent: this.loopKind === 'chat'
        ? task.question
        : buildTaskInitialUserPrompt(task.question),
      initialUserImages: options.initialUserImages || [],
    });
```

- [ ] **Step 6: Budget the image tokens**

In `src/repo-search/prompt-budget.ts`, replace the string-only branch at line 148:

```typescript
  const content = typeof message.content === 'string'
    ? message.content.replace(/\s+/gu, ' ').trim()
    : Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ').replace(/\s+/gu, ' ').trim()
      : '';
```

Then add the per-image allowance where that function returns its token estimate, importing `SIFT_IMAGE_TOKEN_ESTIMATE` from `../config/constants.js`:

```typescript
  const imageCount = Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'image_url').length
    : 0;
```

and add `imageCount * SIFT_IMAGE_TOKEN_ESTIMATE` to the returned estimate.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js engine-transcript-manager repo-search-loop.core repo-search-chat-loop prompt-budget`
Expected: PASS. Every existing `new TranscriptManager({...})` call site must now pass `initialUserImages`; the typecheck will name any that do not.

Run: `npm run typecheck:test`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/repo-search/planner-protocol.ts src/repo-search/engine/transcript-manager.ts src/repo-search/engine/task-loop.ts src/repo-search/prompt-budget.ts tests/engine-transcript-manager.test.ts
git commit -m "feat: carry image parts on the initial task-loop turn"
```

---

## Task 8: `summary` surface

**Files:**
- Modify: `src/summary/types.ts:57-75`
- Modify: `src/status-server/route-request-normalizers.ts:121-145`
- Modify: `src/summary/planner/mode.ts:1427-1433`
- Modify: `src/cli/args.ts:31-66`, `:106+`
- Modify: `src/cli/run-summary.ts:15-58`
- Test: `tests/image-input-surfaces.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/image-input-surfaces.e2e.test.ts` with the summary case (later tasks append to this file):

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummaryRequest } from '../src/status-server/route-request-normalizers.js';

test('parseSummaryRequest accepts images and allows an images-only request', () => {
  const parsed = parseSummaryRequest({
    question: 'what is on screen?',
    inputText: '',
    repoRoot: 'C:\\repo',
    images: ['data:image/png;base64,AAAA'],
  });
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.images, ['data:image/png;base64,AAAA']);
});

test('parseSummaryRequest still rejects an empty request with no images', () => {
  assert.equal(parseSummaryRequest({ question: 'q', inputText: '', repoRoot: 'C:\\repo' }), null);
});

test('parseSummaryRequest rejects a malformed image entry', () => {
  assert.throws(
    () => parseSummaryRequest({
      question: 'q',
      inputText: 'x',
      repoRoot: 'C:\\repo',
      images: ['https://example.com/a.png'],
    }),
    /not a supported image data URI/u,
  );
});
```

The planner's own turn shape is asserted in Step 6.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces`
Expected: FAIL — `parsed?.images` is `undefined`

- [ ] **Step 3: Add `images` to the request types**

In `src/summary/types.ts`, add to `SummaryRequest` after `inputText: string;`:

```typescript
  images?: string[];
```

In `src/status-server/route-request-normalizers.ts`, add to `SummaryRouteRequest` after `question: string;`:

```typescript
  images: string[];
```

- [ ] **Step 4: Parse and relax the empty-input guard**

In `parseSummaryRequest` (line 121), import `parseImageDataUrls` from `../llm-protocol/image-attachments.js` and change the guard plus the returned object:

```typescript
  const images = parseImageDataUrls(reader.value('images'));
  if (!question || (!inputText.trim() && images.length === 0) || !repoRoot) {
    return null;
  }
```

```typescript
    question,
    images,
    inputText,
```

- [ ] **Step 5: Thread `images` to the planner**

Find where the route hands `SummaryRouteRequest` to the summary runner and pass `images` alongside `inputText` down to the options object consumed at `src/summary/planner/mode.ts:1427`. Add `images: readonly string[]` to that options type, then change the initial user message:

```typescript
    {
      role: 'user',
      content: buildUserContent(
        buildPlannerInputSection({
          question: options.question,
          inputText: options.inputText,
        }),
        options.images,
      ),
    },
```

with `import { buildUserContent } from '../../llm-protocol/image-attachments.js';` at the top.

- [ ] **Step 6: Add the planner-turn assertion**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
test('the summary planner puts an image part on the initial user turn', () => {
  const content = buildUserContent('question and input', ['data:image/png;base64,AAAA']);
  assert.deepEqual(content, [
    { type: 'text', text: 'question and input' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});
```

with `import { buildUserContent } from '../src/llm-protocol/image-attachments.js';`.

- [ ] **Step 7: Add the CLI flag**

In `src/cli/args.ts`, add to `ParsedArgs`:

```typescript
  images?: string[];
```

In `parseArguments`, add a repeatable-flag branch alongside the existing value-flag handling:

```typescript
      if (token === '--image') {
        const value = tokens[++index];
        if (value === undefined) {
          throw new Error('Missing value for option: --image');
        }
        parsed.images = [...(parsed.images ?? []), value];
        continue;
      }
```

In `src/cli/run-summary.ts`, read the files and relax the input guard:

```typescript
  const images = new ImageAttachmentReader().readAll(parsed.images ?? []);
  if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim() && images.length === 0) {
    throw new Error('stdin, --text, --file or --image required');
  }
```

and add `images,` to the `SummaryRequest` literal, with
`import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';` at the top.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces summary-request-runner summary-core-runner cli-help`
Expected: PASS. `cli-help` asserts help text; update the summary usage string to mention `--image <path>` if that suite reports a mismatch.

- [ ] **Step 9: Commit**

```bash
git add src/summary/types.ts src/summary/planner/mode.ts src/status-server/route-request-normalizers.ts src/cli/args.ts src/cli/run-summary.ts tests/image-input-surfaces.e2e.test.ts
git commit -m "feat: accept --image on siftkit summary"
```

---

## Task 9: `repo-search` surface

**Files:**
- Modify: `src/cli/args.ts:81-104`
- Modify: `src/cli/run-repo-search.ts:28-52`
- Modify: `src/status-server/routes/core.ts:133`, `:149`
- Test: `tests/image-input-surfaces.e2e.test.ts`, `tests/repo-search-agent-execute.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
import { validateRepoSearchTokens } from '../src/cli/args.js';

test('repo-search accepts a repeatable --image flag', () => {
  validateRepoSearchTokens(['--prompt', 'find it', '--image', 'a.png', '--image', 'b.png']);
  assert.throws(
    () => validateRepoSearchTokens(['--prompt', 'find it', '--image']),
    /Missing value for repo-search option: --image/u,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces`
Expected: FAIL — `Unknown option for repo-search: --image`

- [ ] **Step 3: Allow the flag**

In `src/cli/args.ts`, extend the value-flag set in `validateRepoSearchTokens` (line 82):

```typescript
  const flagsWithValues = new Set(['--prompt', '-prompt', '--model', '--log-file', '--image']);
```

- [ ] **Step 4: Send the images**

In `src/cli/run-repo-search.ts`, after the prompt guard:

```typescript
  const images = new ImageAttachmentReader().readAll(parsed.images ?? []);
```

and add `images,` to the `client.requestRepoSearch({...})` literal, with
`import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';`.

- [ ] **Step 5: Parse on the server**

In `src/status-server/routes/core.ts`, add `images: string[];` to the repo-search request type at line 133, parse it with `parseImageDataUrls(reader.value('images'))` next to the existing `prompt` read at line 149, and pass it into the engine call as `initialUserImages`. The engine forwards it to `runTaskLoop`, which Task 7 already wired into `TranscriptManager`.

- [ ] **Step 6: Assert the wire shape end to end**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
import http from 'node:http';
import os from 'node:os';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';

test('repo-search puts the image part on the first user message it sends', async () => {
  const capturedBodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"action":"finish","output":"done"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address && typeof address === 'object' ? address.port : 0);
  try {
    await runTaskLoop(
      { id: 'img', question: 'what is this?', signals: [] },
      {
        repoRoot: os.tmpdir(),
        systemContext: createEmptyPresetSystemContext(),
        model: 'mock',
        baseUrl: `http://127.0.0.1:${port}`,
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        loopKind: 'chat',
        plannerToolDefinitions: [],
        initialUserImages: ['data:image/png;base64,AAAA'],
        mockCommandResults: {},
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const first = asObject(parseJsonValueText(capturedBodies[0] ?? '{}'));
  assert.equal(JSON.stringify(first).includes('"image_url"'), true);
  assert.equal(JSON.stringify(first).includes('data:image/png;base64,AAAA'), true);
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces repo-search-chat-execute repo-search-agent-execute`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/cli/args.ts src/cli/run-repo-search.ts src/status-server/routes/core.ts tests/image-input-surfaces.e2e.test.ts
git commit -m "feat: accept --image on siftkit repo-search"
```

---

## Task 10: `repo-agent` surface

**Files:**
- Modify: `src/cli/repo-agent-args.ts:7-14`, `:55+`
- Modify: `src/cli/repo-agent-request.ts:12`
- Modify: `src/repo-agent/run-schemas.ts`
- Modify: `src/repo-agent/worker.ts`
- Test: `tests/image-input-surfaces.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
import { parseRepoAgentInvocation } from '../src/cli/repo-agent-args.js';

test('repo-agent collects repeatable --image values', () => {
  const invocation = parseRepoAgentInvocation(['fix the layout', '--image', 'a.png', '--image', 'b.png']);
  assert.equal(invocation.kind, 'start');
  assert.deepEqual(invocation.kind === 'start' ? invocation.images : [], ['a.png', 'b.png']);
});

test('repo-agent defaults images to an empty array', () => {
  const invocation = parseRepoAgentInvocation(['fix the layout']);
  assert.deepEqual(invocation.kind === 'start' ? invocation.images : null, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces`
Expected: FAIL — `invocation.images` does not exist on the start invocation

- [ ] **Step 3: Extend the invocation schema**

In `src/cli/repo-agent-args.ts`, add to `RepoAgentStartInvocationSchema` after `logFile`:

```typescript
  images: z.array(z.string().min(1)).default([]),
```

In `parseRepoAgentInvocation`, collect the flag using the existing `readOptionValue` helper, accumulating into a local `const images: string[] = []` and passing `images` into the parsed start invocation.

- [ ] **Step 4: Forward through the request and run record**

In `src/cli/repo-agent-request.ts`, read the local files and add the encoded URIs next to `prompt`:

```typescript
    prompt: input.task,
    images: new ImageAttachmentReader().readAll(input.images),
```

with `import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';`.

In `src/repo-agent/run-schemas.ts`, add `images: z.array(z.string()).default([])` to the run-record schema so the value survives persistence, and in `src/repo-agent/worker.ts` pass it into the task-loop options as `initialUserImages`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces repo-agent-args repo-agent-run-store`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/repo-agent-args.ts src/cli/repo-agent-request.ts src/repo-agent/run-schemas.ts src/repo-agent/worker.ts tests/image-input-surfaces.e2e.test.ts
git commit -m "feat: accept --image on siftkit repo-agent"
```

---

## Task 11: Chat message persistence

**Files:**
- Modify: `src/state/runtime-db.ts:362-372`
- Modify: `src/state/chat-sessions.ts:18-20`, `:92-131`, `:200-235`, `:485-545`
- Modify: `src/status-server/chat.ts:228-267`, `:428-441`
- Test: `tests/chat-sessions-db.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-sessions-db.test.ts`, using its existing `withTempRepo` helper and the
`saveChatSession` / `readChatSessionFromPath` / `getChatSessionPath` imports already at the top:

```typescript
test('chat messages round-trip their image data URIs', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-images';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Image Session',
      modelPresetId: 'preset-a',
      model: 'model-a',
      contextWindowTokens: 4096,
      thinkingEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      condensedSummary: '',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [{
        id: 'user-1',
        role: 'user',
        kind: 'user_text',
        content: 'what is this?',
        images: ['data:image/png;base64,AAAA'],
        inputTokensEstimate: 4,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        promptCacheTokens: null,
        promptEvalTokens: null,
        createdAtUtc: new Date().toISOString(),
        sourceRunId: null,
      }],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.deepEqual(loaded?.messages?.[0]?.images, ['data:image/png;base64,AAAA']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js chat-sessions-db`
Expected: FAIL — `images` is not a property of the persisted message

- [ ] **Step 3: Add the migration**

In `src/state/runtime-db.ts`, add to the `chat_messages` migration list (after the `grounding_status` entry on line 371):

```typescript
    { name: 'images', sql: 'ALTER TABLE chat_messages ADD COLUMN images TEXT;' },
```

- [ ] **Step 4: Persist and read the column**

In `src/state/chat-sessions.ts`:

- Add `images?: string[];` to the `PersistedChatMessage` type (near `content` on line 20). It is
  optional so the many existing `messages.push({...})` sites and test fixtures stay valid; every
  reader uses `message.images ?? []`.
- Add `images: z.string().nullable(),` to `MessageRowSchema`.
- In the row→message mapping (around line 208), add:

```typescript
    images: row.images === null ? [] : parseImageDataUrls(parseJsonValueText(row.images)),
```

with `import { parseImageDataUrls } from '../llm-protocol/image-attachments.js';` and
`import { parseJsonValueText } from '../lib/json.js';`.

- In the INSERT column list and its bound values, add `images` bound to
  `JSON.stringify(message.images ?? [])`.

- [ ] **Step 5: Attach images to the persisted user turn**

In `src/status-server/chat.ts`, the user message pushed at line 428 gains:

```typescript
    images: options.images ?? [],
```

The other `messages.push({...})` calls in that function are assistant/tool turns and need no change —
`images` is optional and every reader defaults it.

- [ ] **Step 6: Replay images into history**

In `buildChatHistoryMessages` (line 228), first fix the empty-content skip at line 253 so an
images-only turn is not dropped from history:

```typescript
    const content = trimText(message.content);
    const messageImages = message.images ?? [];
    if (!content && messageImages.length === 0) {
      continue;
    }
```

Then replace the plain push at line 256:

```typescript
    history.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'user'
        ? buildUserContent(content, messageImages)
        : content,
      ...(message.role === 'assistant' && pendingThinking ? { reasoning_content: pendingThinking } : {}),
    });
```

with `import { buildUserContent } from '../llm-protocol/image-attachments.js';`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js chat-sessions-db chat-status-metrics chat-repo-operation-runner`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/state/runtime-db.ts src/state/chat-sessions.ts src/status-server/chat.ts tests/chat-sessions-db.test.ts
git commit -m "feat: persist and replay chat image attachments"
```

---

## Task 12: Chat route and dashboard attachment UI

**Files:**
- Modify: `src/status-server/chat-route-request-normalizers.ts:18-21`, `:57-66`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `tests/image-input-surfaces.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
import { parseChatMessageRequest } from '../src/status-server/chat-route-request-normalizers.js';

test('chat message requests carry validated images', () => {
  const parsed = parseChatMessageRequest({
    content: 'what is this?',
    images: ['data:image/webp;base64,AAAA'],
  });
  assert.deepEqual(parsed?.images, ['data:image/webp;base64,AAAA']);
});

test('chat message requests accept an image with empty text', () => {
  const parsed = parseChatMessageRequest({ content: '', images: ['data:image/png;base64,AAAA'] });
  assert.notEqual(parsed, null);
});

test('chat message requests reject a non-image URL', () => {
  assert.throws(
    () => parseChatMessageRequest({ content: 'x', images: ['file:///c:/a.png'] }),
    /not a supported image data URI/u,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces`
Expected: FAIL — `parsed?.images` is `undefined`

- [ ] **Step 3: Parse images on the chat route**

In `src/status-server/chat-route-request-normalizers.ts`:

```typescript
export type ChatMessageRequest = {
  content: string;
  images: string[];
  assistantContent: string | undefined;
};
```

```typescript
export function parseChatMessageRequest(body: JsonObject): ChatMessageRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content') ?? '';
  const images = parseImageDataUrls(reader.value('images'));
  if (!content && images.length === 0) {
    return null;
  }
  return {
    content,
    images,
    assistantContent: reader.optionalString('assistantContent'),
  };
}
```

with `import { parseImageDataUrls } from '../llm-protocol/image-attachments.js';`.

In `src/status-server/routes/chat.ts`, forward `request.images` into the persisted user message (Task 11 step 5) and into the task-loop call as `initialUserImages`.

- [ ] **Step 4: Add the attachment control**

In `dashboard/src/tabs/ChatTab.tsx`, add local state and a file input beside the composer's send control:

```tsx
const [pendingImages, setPendingImages] = useState<string[]>([]);

async function readImageFiles(files: FileList | null): Promise<string[]> {
  if (!files) return [];
  const results: string[] = [];
  for (const file of Array.from(files)) {
    results.push(await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`cannot read ${file.name}`));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    }));
  }
  return results;
}
```

```tsx
<input
  type="file"
  accept="image/png,image/jpeg,image/webp,image/gif"
  multiple
  onChange={(event) => { void readImageFiles(event.currentTarget.files).then((urls) => setPendingImages([...pendingImages, ...urls])); }}
/>
{pendingImages.length > 0 ? <span>{pendingImages.length} image(s) attached</span> : null}
```

Include `images: pendingImages` in the send request body, and clear it with `setPendingImages([])` in the same place the composer text is cleared after a successful send.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces contracts-chat`
Expected: PASS

Run: `npm run typecheck:dashboard-test`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/status-server/chat-route-request-normalizers.ts src/status-server/routes/chat.ts dashboard/src/tabs/ChatTab.tsx tests/image-input-surfaces.e2e.test.ts
git commit -m "feat: attach images to dashboard chat turns"
```

---

## Task 13: Enforce the preset guard on every surface

**Files:**
- Modify: `src/status-server/route-request-normalizers.ts` consumers in `src/status-server/routes/core.ts` and `routes/chat.ts`
- Modify: `src/summary/planner/mode.ts` entry point
- Test: `tests/image-input-surfaces.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-input-surfaces.e2e.test.ts`:

```typescript
import { ModelRuntimePresetSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { assertPresetAcceptsImages } from '../src/llm-protocol/image-attachments.js';

test('every surface refuses images when the active preset cannot take them', () => {
  const base = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  const visionOff = ModelRuntimePresetSchema.parse({ ...base, Backend: 'exl3', VisionEnabled: false });
  assert.throws(
    () => assertPresetAcceptsImages(visionOff, 1),
    /VisionEnabled=false cannot accept image input/u,
  );
});
```

Then add one test per surface proving the guard is actually reached, not merely available. Each
follows the same shape: build the surface's request with one image, point it at a config whose
active preset is the `visionOff` preset above, invoke that surface's entry point, and assert it
rejects. For summary:

```typescript
test('the summary runner refuses an image when the preset has no vision', async () => {
  await assert.rejects(
    () => runSummaryRequest({
      repoRoot: 'C:\\repo',
      question: 'what is this?',
      inputText: '',
      images: ['data:image/png;base64,AAAA'],
      format: 'text',
      config: mockSiftConfig({ Server: { ModelPresets: { Presets: [visionOff], ActivePresetId: visionOff.id } } }),
    }),
    /VisionEnabled=false cannot accept image input/u,
  );
});
```

Repeat for repo-search (`runRepoSearch` with `initialUserImages`), repo-agent (the worker start
path) and chat (the send handler), each using the entry point its own existing test file already
drives — `tests/summary-request-runner.test.ts`, `tests/repo-search-agent-execute.test.ts` and
`tests/chat-repo-operation-runner.test.ts` show the exact call signature and config fixture for
each. Import `mockSiftConfig` from `./helpers/mock-config.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces`
Expected: FAIL — the per-surface handlers accept the image and never throw

- [ ] **Step 3: Call the guard at each boundary**

In each of the four request paths, immediately after the active preset is resolved and before any inference request is built:

```typescript
assertPresetAcceptsImages(activePreset, images.length);
```

The four sites are the summary runner entry, the repo-search route handler in `routes/core.ts`, the repo-agent worker start path, and the chat send handler in `routes/chat.ts`. Each already resolves the active preset for its own request; reuse that value rather than re-resolving it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\scripts\run-tests.js image-input-surfaces summary-request-runner repo-search-agent-execute chat-repo-operation-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/core.ts src/status-server/routes/chat.ts src/summary/planner/mode.ts src/repo-agent/worker.ts tests/image-input-surfaces.e2e.test.ts
git commit -m "feat: reject image input when the preset has no vision"
```

---

## Task 14: Document the cost and run the full suite

**Files:**
- Modify: `docs/exl3-performance-tuning-2026-07-21.md`

- [ ] **Step 1: Add the tuning note**

Append a section next to the existing `EXL3_QC_ATTN` rationale:

```markdown
## `TABBY_MODEL_VISION` — vision tower

Set from the preset field `VisionEnabled`. Measured on an RTX 4090 against
`D:\personal\models\elx3\3.6_27b_4.7bpw` (Qwen3.5-27B VL):

- **890.1 MiB resident** while loaded. The tower ships BF16 and exl3 does not quantize it, so
  the model's 4.7bpw setting does not apply to it.
- **~0.1 MiB per image token** transient during encode: 31 MiB at 640×480, 89 MiB at 720p,
  207 MiB at 1080p, 366 MiB at 1440p, 828 MiB at 4K. Nothing remains allocated afterwards —
  embeddings return on the CPU.
- Image tokens consume the preallocated KV cache at the normal rate. With 16 full-attention
  layers, 4 KV heads and head_dim 256 at `cache_mode: 8,8` that is **34 KiB per token**, so a
  1080p screenshot is 2040 tokens ≈ 68 MiB of cache and 2040 tokens of context.
- The model's `preprocessor_config.json` allows up to 16,777,216 pixels per image — 16,384 image
  tokens and roughly 1.6 GiB of transient VRAM. Nothing in SiftKit or TabbyAPI clamps this;
  exllamav3 reads the cap from the model directory.
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add docs/exl3-performance-tuning-2026-07-21.md
git commit -m "docs: record the EXL3 vision tower VRAM cost"
```

---

## Manual verification

After the suite is green, confirm the real engine behaviour:

1. Set `VisionEnabled` on the EXL3 preset in the dashboard. The status server restarts TabbyAPI
   because `TABBY_MODEL_VISION` changed the process signature.
2. `nvidia-smi --query-gpu=memory.used --format=csv` before and after should differ by roughly
   890 MiB plus the usual allocator slack.
3. `siftkit summary --image <screenshot.png> --question "describe this screenshot"` should return
   a description rather than an error.
4. Toggle `VisionEnabled` off and repeat step 3 — the command must fail with
   `VisionEnabled=false cannot accept image input`, not silently ignore the image.
