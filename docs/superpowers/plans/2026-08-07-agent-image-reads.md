# Agent Image Reads, Image Admission, and Chat Image Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make images a first-class input everywhere in SiftKit — an images-only chat turn executes, the repo-search/plan endpoints stop dropping attachments, the agent's `read` tool can look at a repository image, every image is size- and dimension-admitted before it reaches the model, and the dashboard renders images inline with a collapsed annotation.

**Architecture:** One shared admission path (`src/llm-protocol/image-admission.ts`) validates bytes, reads dimensions, and downscales to a per-preset token ceiling; every entry point (CLI `--image`, HTTP data URLs, agent `read`, browser paste) goes through it. The agent `read` tool dispatches on file extension and returns a text result plus an `imageDataUrl`, which the engine appends as a `role: 'user'` message immediately after the tool result. That synthetic message is persisted as a first-class row so chat replay reconstructs it in position, and a new `VisionImageRetention` preset field ages old images out of context.

**Tech Stack:** TypeScript (ESM, `node:test` + `node:assert/strict`), zod (via `src/lib/zod.js`), better-sqlite3, `@napi-rs/image` (new runtime dependency), React (dashboard), ESLint.

**Source spec:** `docs/superpowers/specs/2026-08-07-agent-image-reads-design.md`

---

## Pre-flight findings (already verified — do not re-verify)

Spec §9 risk 1 asked whether `preprocessor_config.json` sits beside the weights. **Verified 2026-08-07 on this machine: it does not exist.** The only exl3 model directory is `C:\exl3_work\Laguna-S-2.1-4.0bpw`, which contains `args.json` and safetensors only — it is a text-only model, so no vision preprocessor config is expected. There is no vision model installed locally to confirm against.

Consequence for Task 5: implement `resolveImageTokenBudget` exactly as designed — read `preprocessor_config.json` from the preset's `ModelPath`, fall back loudly when absent — and test it against a **fixture** config written into a temp directory. On the current machine the fallback branch is what will run at runtime; that is expected, not a bug.

`@napi-rs/image` is **not** currently installed (`node_modules/@napi-rs/image` absent). Task 3 adds it.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/llm-protocol/image-admission.ts` | Dimension reading, target-dimension math, server-side downscale, and the single `admitImageBuffer` / `admitImageDataUrl` entry points. |
| `src/llm-protocol/image-token-budget.ts` | `resolveImageTokenBudget(preset)` — derives max pixels from the preset's `preprocessor_config.json`, caches per preset, logs its source. |
| `src/repo-search/engine/image-read.ts` | The `read` image branch: `planImageRead` + `buildImageReadExecution`. Keeps `repo-tools.ts` from growing another 100 lines. |
| `src/image-retention-policy.ts` | `ImageRetentionPolicy` — ages images out of a message array, mirroring `src/thinking-retention-policy.ts`. |
| `src/status-server/routes/chat-image-caption.ts` | The on-demand caption endpoint. |
| `dashboard/src/lib/downscale-image.ts` | Browser-side `createImageBitmap` + `OffscreenCanvas` downscale. |
| `dashboard/src/components/PendingImageStrip.tsx` | Composer thumbnail strip with per-image removal. |
| `dashboard/src/components/MessageImages.tsx` | Inline image rendering + collapsed annotation + caption fetch. |
| `tests/image-admission.test.ts` | Admission unit tests. |
| `tests/image-token-budget.test.ts` | Token-budget derivation tests. |
| `tests/image-read-tool.test.ts` | `read`-returns-image tests. |
| `tests/image-retention.test.ts` | Retention + replay tests. |
| `tests/helpers/image-fixtures.ts` | Shared PNG/JPEG/WebP/GIF fixture builders for the tests above. |

**Modified files** (each named at its task)

`src/config/constants.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/chat.ts`, `src/llm-protocol/image-attachments.ts`, `src/repo-search/execute.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/repo-tools.ts`, `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/engine/transcript-manager.ts`, `src/repo-search/engine.ts`, `src/repo-search/prompts.ts`, `src/state/runtime-db.ts`, `src/state/chat-sessions.ts`, `src/status-server/chat.ts`, `src/status-server/chat-repo-operation-runner.ts`, `src/status-server/chat-route-request-normalizers.ts`, `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-session-operation-endpoint.ts`, `src/status-server/route-table.ts`, `dashboard/src/api.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, `dashboard/src/styles.css`, `tests/repo-search.test.ts`, `tests/image-attachments.test.ts`.

---

## Phase A — Shared admission core (Tasks 1–6)

### Task 1: Byte limit moves into `ImageDataUrlSchema`

Today `SIFT_MAX_IMAGE_BYTES` is enforced only in `ImageAttachmentReader.read`. Every HTTP route that goes through `parseImageDataUrls` is unguarded.

**Files:**
- Modify: `src/llm-protocol/image-attachments.ts:26-34`
- Test: `tests/image-attachments.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-attachments.test.ts`:

```ts
test('ImageDataUrlSchema rejects a data URL whose payload exceeds SIFT_MAX_IMAGE_BYTES', () => {
  // 4 base64 chars encode 3 bytes, so this payload decodes to just over the limit.
  const base64Length = Math.ceil((SIFT_MAX_IMAGE_BYTES + 1) / 3) * 4;
  const oversized = `data:image/png;base64,${'A'.repeat(base64Length)}`;
  const result = ImageDataUrlSchema.safeParse(oversized);
  assert.equal(result.success, false);
});

test('ImageDataUrlSchema accepts a data URL at or under SIFT_MAX_IMAGE_BYTES', () => {
  assert.equal(ImageDataUrlSchema.safeParse(VALID_PNG_URI).success, true);
});

test('parseImageDataUrls rejects an oversized entry rather than dropping it', () => {
  const base64Length = Math.ceil((SIFT_MAX_IMAGE_BYTES + 1) / 3) * 4;
  const oversized = `data:image/png;base64,${'A'.repeat(base64Length)}`;
  assert.throws(() => parseImageDataUrls([VALID_PNG_URI, oversized]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the three new tests FAIL — the oversized URL currently parses successfully.

- [ ] **Step 3: Write minimal implementation**

Replace `src/llm-protocol/image-attachments.ts:26-34` with:

```ts
/**
 * Decoded byte length of a base64 payload, without decoding it. Every 4 characters carry
 * 3 bytes; trailing `=` padding characters carry none.
 */
function base64PayloadByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export const ImageDataUrlSchema = z.string().refine(
  (val) => {
    if (!val.startsWith('data:image/')) return false;
    const mimeMatch = val.match(/^data:(image\/\w+);base64,/);
    if (!mimeMatch) return false;
    if (!SUPPORTED_MIMES.has(mimeMatch[1])) return false;
    return base64PayloadByteLength(val.slice(mimeMatch[0].length)) <= SIFT_MAX_IMAGE_BYTES;
  },
  { message: 'supported-image' },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, including the pre-existing `ImageAttachmentReader` oversize test at `tests/image-attachments.test.ts:230` (its file-path check is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/image-attachments.ts tests/image-attachments.test.ts
git commit -m "fix: enforce the image byte limit on the data-URL path"
```

---

### Task 2: Export `isImagePath` and the supported-extension list

`read` dispatches on extension, and the vision tool description names the formats. Both must read `IMAGE_MIME_MAP` so adding a format cannot leave either stale.

**Files:**
- Modify: `src/llm-protocol/image-attachments.ts:14-20`
- Test: `tests/image-attachments.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-attachments.test.ts` (and add `isImagePath`, `imageMimeForPath`, `getSupportedImageExtensions` to the import on line 6):

```ts
test('isImagePath recognises every extension in the MIME map, case-insensitively', () => {
  for (const extension of getSupportedImageExtensions()) {
    assert.equal(isImagePath(`docs/arch${extension}`), true, extension);
    assert.equal(isImagePath(`docs/arch${extension.toUpperCase()}`), true, extension);
  }
});

test('isImagePath rejects non-image paths', () => {
  assert.equal(isImagePath('src/index.ts'), false);
  assert.equal(isImagePath('README'), false);
});

test('getSupportedImageExtensions is sorted and matches the MIME map', () => {
  assert.deepEqual(getSupportedImageExtensions(), ['.gif', '.jpeg', '.jpg', '.png', '.webp']);
});

test('imageMimeForPath returns the mapped MIME or undefined', () => {
  assert.equal(imageMimeForPath('a/b.JPG'), 'image/jpeg');
  assert.equal(imageMimeForPath('a/b.txt'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `isImagePath`, `imageMimeForPath` and `getSupportedImageExtensions` are not exported.

- [ ] **Step 3: Write minimal implementation**

Insert into `src/llm-protocol/image-attachments.ts` immediately after the `IMAGE_MIME_MAP` declaration (line 20):

```ts
/** Sorted so the generated tool description is stable across runs. */
export function getSupportedImageExtensions(): string[] {
  return [...IMAGE_MIME_MAP.keys()].sort();
}

export function imageMimeForPath(filePath: string): string | undefined {
  return IMAGE_MIME_MAP.get(extname(filePath).toLowerCase());
}

export function isImagePath(filePath: string): boolean {
  return imageMimeForPath(filePath) !== undefined;
}
```

Then rewrite `ImageAttachmentReader.read`'s first three lines (currently `src/llm-protocol/image-attachments.ts:49-53`) to reuse the helper, so the extension lookup has one definition:

```ts
  read(filePath: string): string {
    const mime = imageMimeForPath(filePath);
    if (mime === undefined) {
      throw new Error(`Unsupported image extension: ${extname(filePath).toLowerCase()}`);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/image-attachments.ts tests/image-attachments.test.ts
git commit -m "feat: export image extension predicates from the MIME map"
```

---

### Task 3: Add `@napi-rs/image` and read image dimensions

**Files:**
- Modify: `package.json`
- Create: `src/llm-protocol/image-admission.ts`
- Create: `tests/helpers/image-fixtures.ts`
- Create: `tests/image-admission.test.ts`

- [ ] **Step 1: Install the dependency**

```bash
npm install @napi-rs/image@1.14.0 --save-exact
```

Expected: `package.json` `dependencies` gains `"@napi-rs/image": "1.14.0"`; the win32-x64-msvc prebuild is fetched. Verify with:

```bash
node -e "const {Transformer}=require('@napi-rs/image');console.log(typeof Transformer.prototype.metadata)"
```
Expected output: `function`

- [ ] **Step 2: Write the fixture helper**

Create `tests/helpers/image-fixtures.ts`:

```ts
import { Transformer } from '@napi-rs/image';

/** A 1x1 GIF87a. GIF cannot be encoded by @napi-rs/image, so it is a literal. */
const GIF_1X1_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function gifBuffer(): Buffer {
  return Buffer.from(GIF_1X1_BASE64, 'base64');
}

/**
 * A GIF header with the requested logical screen size. Bytes 6-9 are the width and height as
 * little-endian uint16, which is all `readImageDimensions` reads.
 */
export function gifBufferWithSize(width: number, height: number): Buffer {
  const buffer = Buffer.from(gifBuffer());
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** A solid-colour RGBA raster, encoded to the requested format. */
export function rasterBuffer(
  format: 'png' | 'jpeg' | 'webp',
  width: number,
  height: number,
): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 200;
    pixels[index + 1] = 120;
    pixels[index + 2] = 40;
    pixels[index + 3] = 255;
  }
  const transformer = Transformer.fromRgbaPixels(pixels, width, height);
  if (format === 'png') return transformer.pngSync();
  if (format === 'jpeg') return transformer.jpegSync(90);
  return transformer.webpSync(90);
}

export function toDataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
```

- [ ] **Step 3: Write the failing test**

Create `tests/image-admission.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { readImageDimensions } from '../src/llm-protocol/image-admission.js';
import { gifBufferWithSize, rasterBuffer } from './helpers/image-fixtures.js';

test('readImageDimensions reads PNG dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('png', 40, 25), 'image/png'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads JPEG dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('jpeg', 40, 25), 'image/jpeg'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads WebP dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('webp', 40, 25), 'image/webp'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads GIF dimensions from the header', () => {
  assert.deepEqual(
    readImageDimensions(gifBufferWithSize(1280, 720), 'image/gif'),
    { width: 1280, height: 720 },
  );
});

test('readImageDimensions throws on a truncated GIF header', () => {
  assert.throws(
    () => readImageDimensions(Buffer.alloc(6), 'image/gif'),
    /gif header/iu,
  );
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/llm-protocol/image-admission.ts` does not exist.

- [ ] **Step 5: Write minimal implementation**

Create `src/llm-protocol/image-admission.ts`:

```ts
import { Transformer } from '@napi-rs/image';

export type ImageDimensions = { width: number; height: number };

/**
 * `@napi-rs/image` cannot decode GIF at all, so GIF dimensions come from the header: bytes
 * 6-9 of the logical screen descriptor are width then height, little-endian uint16.
 */
function readGifDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.byteLength < 10) {
    throw new Error('image is not a readable GIF: header is shorter than 10 bytes');
  }
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

export function readImageDimensions(buffer: Buffer, mime: string): ImageDimensions {
  if (mime === 'image/gif') {
    return readGifDimensions(buffer);
  }
  const metadata = new Transformer(buffer).metadataSync();
  if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)
    || metadata.width <= 0 || metadata.height <= 0) {
    throw new Error(`image dimensions could not be read from ${mime} data`);
  }
  return { width: metadata.width, height: metadata.height };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

If `metadataSync` is not the exported name in the installed version, run
`node -e "const {Transformer}=require('@napi-rs/image');console.log(Object.getOwnPropertyNames(Transformer.prototype).join(','))"`
and use the synchronous metadata method it lists. Do not add an `any` cast to work around a name mismatch.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/llm-protocol/image-admission.ts tests/helpers/image-fixtures.ts tests/image-admission.test.ts
git commit -m "feat: read image dimensions for png, jpeg, webp and gif"
```

---

### Task 4: Target-dimension math and server-side downscale

**Files:**
- Modify: `src/llm-protocol/image-admission.ts`
- Test: `tests/image-admission.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-admission.test.ts` (extend the import on line 4 to include `computeTargetDimensions` and `downscaleImageBuffer`):

```ts
test('computeTargetDimensions returns null when the image already fits', () => {
  assert.equal(computeTargetDimensions(800, 600, 1_000_000), null);
});

test('computeTargetDimensions scales to fit the pixel ceiling and preserves aspect ratio', () => {
  const target = computeTargetDimensions(4000, 2000, 1_000_000);
  assert.notEqual(target, null);
  assert.ok(target!.width * target!.height <= 1_000_000);
  // 2:1 stays 2:1 within a pixel of rounding.
  assert.ok(Math.abs(target!.width / target!.height - 2) < 0.01);
});

test('computeTargetDimensions never returns a zero dimension', () => {
  const target = computeTargetDimensions(10_000, 2, 100);
  assert.notEqual(target, null);
  assert.ok(target!.width >= 1);
  assert.ok(target!.height >= 1);
});

test('downscaleImageBuffer resizes a PNG to the target and keeps the format', () => {
  const source = rasterBuffer('png', 400, 200);
  const resized = downscaleImageBuffer(source, 'image/png', { width: 100, height: 50 });
  assert.deepEqual(readImageDimensions(resized, 'image/png'), { width: 100, height: 50 });
});

test('downscaleImageBuffer resizes JPEG and WebP and keeps each format', () => {
  for (const [format, mime] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const resized = downscaleImageBuffer(rasterBuffer(format, 400, 200), mime, { width: 100, height: 50 });
    assert.deepEqual(readImageDimensions(resized, mime), { width: 100, height: 50 }, mime);
  }
});

test('downscaleImageBuffer refuses GIF because the encoder cannot decode it', () => {
  assert.throws(
    () => downscaleImageBuffer(gifBufferWithSize(4000, 4000), 'image/gif', { width: 100, height: 100 }),
    /gif/iu,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/llm-protocol/image-admission.ts`:

```ts
import { ResizeFilterType } from '@napi-rs/image';

/**
 * Returns the dimensions that bring `width * height` under `maxPixels` at the original aspect
 * ratio, or null when the image already fits. Both dimensions are clamped to at least 1, so a
 * pathologically thin image degrades rather than collapsing to zero.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxPixels: number,
): ImageDimensions | null {
  if (width * height <= maxPixels) {
    return null;
  }
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Lanczos3 because the dominant input is UI screenshots, where glyph legibility after the
 * downscale is the whole point.
 */
export function downscaleImageBuffer(
  buffer: Buffer,
  mime: string,
  target: ImageDimensions,
): Buffer {
  if (mime === 'image/gif') {
    throw new Error('gif images cannot be resized server-side; resize the gif and retry');
  }
  const resized = new Transformer(buffer)
    .resize(target.width, target.height, undefined, ResizeFilterType.Lanczos3);
  if (mime === 'image/jpeg') return resized.jpegSync(90);
  if (mime === 'image/webp') return resized.webpSync(90);
  return resized.pngSync();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/image-admission.ts tests/image-admission.test.ts
git commit -m "feat: add target-dimension math and server-side image downscaling"
```

---

### Task 5: Derive the image token ceiling from the preset

**Files:**
- Modify: `src/config/constants.ts:46`
- Create: `src/llm-protocol/image-token-budget.ts`
- Create: `tests/image-token-budget.test.ts`

Background: a Qwen-VL–family `preprocessor_config.json` carries `patch_size`, `merge_size` and `max_pixels`. One image token covers `(patch_size * merge_size)^2` pixels. The ceiling this codebase can afford is `SIFT_IMAGE_TOKEN_ESTIMATE` (2048) tokens, so `maxPixels = min(config.max_pixels, 2048 * pixelsPerToken)`.

- [ ] **Step 1: Add the fallback constants**

Insert into `src/config/constants.ts` immediately after line 46:

```ts
/**
 * Pixels covered by one image token when a preset carries no preprocessor_config.json.
 * 14px patches merged 2x2 — the Qwen-VL default — cover 28x28 = 784 pixels per token.
 */
export const SIFT_FALLBACK_IMAGE_PATCH_SIZE = 14;
export const SIFT_FALLBACK_IMAGE_MERGE_SIZE = 2;
```

- [ ] **Step 2: Write the failing test**

Create `tests/image-token-budget.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveImageTokenBudget, clearImageTokenBudgetCache } from '../src/llm-protocol/image-token-budget.js';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../src/config/constants.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { makeTestPreset } from './helpers/model-presets.js';

function writePreprocessorConfig(directory: string, body: Record<string, number>): void {
  fs.writeFileSync(path.join(directory, 'preprocessor_config.json'), JSON.stringify(body));
}

test('resolveImageTokenBudget derives the ceiling from preprocessor_config.json', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-derived');
  writePreprocessorConfig(directory, { patch_size: 14, merge_size: 2, max_pixels: 12_845_056 });
  const preset: ModelRuntimePreset = makeTestPreset({ id: 'derived', ModelPath: directory });

  const budget = resolveImageTokenBudget(preset);

  assert.equal(budget.source, 'preprocessor_config');
  assert.equal(budget.pixelsPerToken, 784);
  // 12_845_056 px would need 16_384 tokens, so the SiftKit token estimate is the binding limit.
  assert.equal(budget.maxPixels, SIFT_IMAGE_TOKEN_ESTIMATE * 784);
});

test('resolveImageTokenBudget honours a max_pixels lower than the SiftKit token ceiling', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-tight');
  writePreprocessorConfig(directory, { patch_size: 14, merge_size: 2, max_pixels: 200_000 });

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'tight', ModelPath: directory }));

  assert.equal(budget.maxPixels, 200_000);
});

test('resolveImageTokenBudget falls back when the file is absent, and says which', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-absent');

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'absent', ModelPath: directory }));

  assert.equal(budget.source, 'fallback');
  assert.equal(budget.pixelsPerToken, 784);
  assert.equal(budget.maxPixels, SIFT_IMAGE_TOKEN_ESTIMATE * 784);
});

test('resolveImageTokenBudget falls back when the file is unparseable', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-broken');
  fs.writeFileSync(path.join(directory, 'preprocessor_config.json'), '{ not json');

  assert.equal(resolveImageTokenBudget(makeTestPreset({ id: 'broken', ModelPath: directory })).source, 'fallback');
});

test('resolveImageTokenBudget falls back when ModelPath is null', () => {
  clearImageTokenBudgetCache();
  assert.equal(resolveImageTokenBudget(makeTestPreset({ id: 'nopath', ModelPath: null })).source, 'fallback');
});

test('resolveImageTokenBudget caches per preset id', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-cache');
  writePreprocessorConfig(directory, { patch_size: 14, merge_size: 2, max_pixels: 200_000 });
  const preset = makeTestPreset({ id: 'cached', ModelPath: directory });

  assert.equal(resolveImageTokenBudget(preset).maxPixels, 200_000);
  fs.rmSync(path.join(directory, 'preprocessor_config.json'));
  // Second call must not re-read the (now missing) file.
  assert.equal(resolveImageTokenBudget(preset).maxPixels, 200_000);
});
```

Create the shared preset builder `tests/helpers/model-presets.ts` by moving the existing `makePreset` body out of `tests/image-attachments.test.ts:16-...` verbatim, renaming it `makeTestPreset` and exporting it:

```ts
import type { ModelRuntimePreset } from '../../src/config/types.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';

/** The default preset, overridden per test. Keeps every preset fixture on one definition. */
export function makeTestPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const [defaultPreset] = getDefaultConfigObject().Server.ModelPresets.Presets;
  return { ...defaultPreset, ...overrides };
}
```

If `getDefaultConfigObject().Server.ModelPresets.Presets` is not the accessor path in this codebase, read `src/config/defaults.ts` and use the actual path to the default preset array — do not hand-copy 50 preset fields.

Then replace `tests/image-attachments.test.ts`'s local `makePreset` with an import of `makeTestPreset` and update its call sites.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/llm-protocol/image-token-budget.ts` does not exist.

- [ ] **Step 4: Write minimal implementation**

Create `src/llm-protocol/image-token-budget.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from '../lib/zod.js';
import {
  SIFT_FALLBACK_IMAGE_MERGE_SIZE,
  SIFT_FALLBACK_IMAGE_PATCH_SIZE,
  SIFT_IMAGE_TOKEN_ESTIMATE,
} from '../config/constants.js';
import { serverLogger } from '../status-server/server-logger.js';
import type { ModelRuntimePreset } from '../config/types.js';

export type ImageTokenBudget = {
  /** Pixels one image token covers. */
  pixelsPerToken: number;
  /** Hard pixel ceiling for a single admitted image. */
  maxPixels: number;
  /** Image tokens the ceiling costs. */
  maxImageTokens: number;
  source: 'preprocessor_config' | 'fallback';
};

const PreprocessorConfigSchema = z.object({
  patch_size: z.number().int().positive().optional(),
  merge_size: z.number().int().positive().optional(),
  max_pixels: z.number().int().positive().optional(),
});

const budgetByPresetId = new Map<string, ImageTokenBudget>();

/** Test seam. Production code never calls this. */
export function clearImageTokenBudgetCache(): void {
  budgetByPresetId.clear();
}

function buildBudget(pixelsPerToken: number, configuredMaxPixels: number | undefined, source: ImageTokenBudget['source']): ImageTokenBudget {
  const affordableMaxPixels = SIFT_IMAGE_TOKEN_ESTIMATE * pixelsPerToken;
  const maxPixels = configuredMaxPixels === undefined
    ? affordableMaxPixels
    : Math.min(configuredMaxPixels, affordableMaxPixels);
  return {
    pixelsPerToken,
    maxPixels,
    maxImageTokens: Math.ceil(maxPixels / pixelsPerToken),
    source,
  };
}

function fallbackBudget(): ImageTokenBudget {
  return buildBudget(
    (SIFT_FALLBACK_IMAGE_PATCH_SIZE * SIFT_FALLBACK_IMAGE_MERGE_SIZE) ** 2,
    undefined,
    'fallback',
  );
}

function readBudget(preset: ModelRuntimePreset): ImageTokenBudget {
  const modelPath = typeof preset.ModelPath === 'string' ? preset.ModelPath.trim() : '';
  if (!modelPath) {
    return fallbackBudget();
  }
  const configPath = join(modelPath, 'preprocessor_config.json');
  if (!existsSync(configPath)) {
    return fallbackBudget();
  }
  const parsed = PreprocessorConfigSchema.safeParse(
    JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
  );
  if (!parsed.success) {
    return fallbackBudget();
  }
  const patchSize = parsed.data.patch_size ?? SIFT_FALLBACK_IMAGE_PATCH_SIZE;
  const mergeSize = parsed.data.merge_size ?? SIFT_FALLBACK_IMAGE_MERGE_SIZE;
  return buildBudget((patchSize * mergeSize) ** 2, parsed.data.max_pixels, 'preprocessor_config');
}

/**
 * The pixel ceiling a single image may occupy for this preset. Cached per preset id and
 * logged with its source, so a silently-defaulted ceiling is visible in the log rather than
 * showing up later as an unexplained downscale.
 */
export function resolveImageTokenBudget(preset: ModelRuntimePreset): ImageTokenBudget {
  const cached = budgetByPresetId.get(preset.id);
  if (cached) {
    return cached;
  }
  let budget: ImageTokenBudget;
  try {
    budget = readBudget(preset);
  } catch {
    budget = fallbackBudget();
  }
  budgetByPresetId.set(preset.id, budget);
  serverLogger.event({
    scope: 'img',
    id: preset.id,
    event: 'token_budget_resolved',
    fields: `source=${budget.source} pixels_per_token=${budget.pixelsPerToken} `
      + `max_pixels=${budget.maxPixels} max_image_tokens=${budget.maxImageTokens}`
      + (budget.source === 'fallback'
        ? ' note=preprocessor_config.json_unavailable_using_default_ratio'
        : ''),
  });
  return budget;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/constants.ts src/llm-protocol/image-token-budget.ts tests/image-token-budget.test.ts tests/helpers/model-presets.ts tests/image-attachments.test.ts
git commit -m "feat: derive the per-preset image token ceiling from preprocessor_config.json"
```

---

### Task 6: The single admission entry point

**Files:**
- Modify: `src/llm-protocol/image-admission.ts`
- Test: `tests/image-admission.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-admission.test.ts`:

```ts
test('admitImageBuffer passes a within-budget image through untouched', () => {
  const source = rasterBuffer('png', 100, 100);
  const admitted = admitImageBuffer(source, 'image/png', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, source: 'fallback' });

  assert.equal(admitted.metadata.width, 100);
  assert.equal(admitted.metadata.height, 100);
  assert.equal(admitted.metadata.originalWidth, 100);
  assert.equal(admitted.metadata.originalHeight, 100);
  assert.equal(admitted.metadata.resized, false);
  assert.equal(admitted.dataUrl.startsWith('data:image/png;base64,'), true);
});

test('admitted metadata never carries the image data, so persisting it cannot double storage', () => {
  const admitted = admitImageBuffer(rasterBuffer('png', 100, 100), 'image/png', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, source: 'fallback' });

  assert.equal(JSON.stringify(admitted.metadata).includes('base64'), false);
});

test('admitImageBuffer downscales an over-ceiling image to within budget', () => {
  const source = rasterBuffer('png', 1000, 1000);
  const admitted = admitImageBuffer(source, 'image/png', { maxPixels: 10_000, pixelsPerToken: 784, maxImageTokens: 13, source: 'fallback' });

  assert.ok(admitted.metadata.width * admitted.metadata.height <= 10_000);
  assert.equal(admitted.metadata.originalWidth, 1000);
  assert.equal(admitted.metadata.resized, true);
  assert.ok(admitted.metadata.tokenEstimate <= 13);
});

test('admitImageBuffer rejects an over-ceiling GIF with the resize message and real numbers', () => {
  assert.throws(
    () => admitImageBuffer(gifBufferWithSize(8000, 8000), 'image/gif', { maxPixels: 12_500_000, pixelsPerToken: 6104, maxImageTokens: 2048, source: 'fallback' }),
    /image is 8000×8000 \(64\.0 MP\); this preset accepts up to 12\.5 MP \(≈2048 image tokens\) — resize and retry/u,
  );
});

test('admitImageBuffer admits a within-budget GIF', () => {
  const admitted = admitImageBuffer(gifBufferWithSize(100, 100), 'image/gif', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, source: 'fallback' });
  assert.equal(admitted.metadata.width, 100);
  assert.equal(admitted.metadata.resized, false);
});

test('admitImageDataUrl round-trips through the data-URL form', () => {
  const url = toDataUrl('image/png', rasterBuffer('png', 60, 30));
  const admitted = admitImageDataUrl(url, { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, source: 'fallback' });
  assert.deepEqual([admitted.metadata.width, admitted.metadata.height], [60, 30]);
});

test('admitImageDataUrl rejects a non-image data URL', () => {
  assert.throws(() => admitImageDataUrl('data:text/plain;base64,aGk=', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, source: 'fallback' }));
});
```

Extend the imports at the top of the file with `admitImageBuffer`, `admitImageDataUrl` and `toDataUrl`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — neither admit function is exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/llm-protocol/image-admission.ts`:

First add the metadata schema to **`packages/contracts/src/chat.ts`**, not to `image-admission.ts`. It crosses the wire and is read by both the server and the dashboard, and the dashboard cannot import from `src/`:

```ts
/** Persisted alongside a message so the dashboard annotation costs nothing to render. */
export const ImageMetadataSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  mime: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  resized: z.boolean(),
  caption: z.string().nullable(),
});
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;
```

Then append to `src/llm-protocol/image-admission.ts`:

```ts
import { ImageMetadataSchema, type ImageMetadata } from '@siftkit/contracts';
import { ImageDataUrlSchema } from './image-attachments.js';
import type { ImageTokenBudget } from './image-token-budget.js';

export type AdmittedImage = { dataUrl: string; metadata: ImageMetadata };

function formatMegapixels(width: number, height: number): string {
  return ((width * height) / 1_000_000).toFixed(1);
}

/**
 * The one place an image becomes admissible. Oversized images are downscaled to the preset's
 * pixel ceiling; GIF cannot be decoded by the encoder, so an oversized GIF is rejected with the
 * same numbers a resize would have used.
 */
export function admitImageBuffer(
  buffer: Buffer,
  mime: string,
  budget: ImageTokenBudget,
): AdmittedImage {
  const original = readImageDimensions(buffer, mime);
  const target = computeTargetDimensions(original.width, original.height, budget.maxPixels);
  if (target === null) {
    return buildAdmittedImage(buffer, mime, original, original, budget, false);
  }
  if (mime === 'image/gif') {
    throw new Error(
      `image is ${original.width}×${original.height} (${formatMegapixels(original.width, original.height)} MP); `
      + `this preset accepts up to ${(budget.maxPixels / 1_000_000).toFixed(1)} MP `
      + `(≈${budget.maxImageTokens} image tokens) — resize and retry`,
    );
  }
  const resized = downscaleImageBuffer(buffer, mime, target);
  return buildAdmittedImage(resized, mime, target, original, budget, true);
}

function buildAdmittedImage(
  buffer: Buffer,
  mime: string,
  dimensions: ImageDimensions,
  original: ImageDimensions,
  budget: ImageTokenBudget,
  resized: boolean,
): AdmittedImage {
  return {
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    // The data URL is deliberately outside `metadata`: metadata is persisted as JSON on the
    // message row, and a nested copy of the image would double every stored attachment.
    metadata: ImageMetadataSchema.parse({
      width: dimensions.width,
      height: dimensions.height,
      originalWidth: original.width,
      originalHeight: original.height,
      mime,
      byteLength: buffer.byteLength,
      tokenEstimate: Math.ceil((dimensions.width * dimensions.height) / budget.pixelsPerToken),
      resized,
      caption: null,
    }),
  };
}

export function admitImageDataUrl(dataUrl: string, budget: ImageTokenBudget): AdmittedImage {
  const validated = ImageDataUrlSchema.parse(dataUrl);
  const separator = validated.indexOf(';base64,');
  const mime = validated.slice('data:'.length, separator);
  const buffer = Buffer.from(validated.slice(separator + ';base64,'.length), 'base64');
  return admitImageBuffer(buffer, mime, budget);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Route `ImageAttachmentReader` through admission**

`ImageAttachmentReader.read` serves CLI `--image` and repo-agent. It keeps its pre-encode byte check (cheaper, catches the file before base64 inflates it by a third) but must now also downscale. Replace the body of `read` in `src/llm-protocol/image-attachments.ts`:

```ts
export class ImageAttachmentReader {
  constructor(private readonly budget: ImageTokenBudget) {}

  read(filePath: string): string {
    return this.readAdmitted(filePath).dataUrl;
  }

  readAdmitted(filePath: string): AdmittedImage {
    const mime = imageMimeForPath(filePath);
    if (mime === undefined) {
      throw new Error(`Unsupported image extension: ${extname(filePath).toLowerCase()}`);
    }
    const buf = readFileSync(filePath);
    if (buf.byteLength > SIFT_MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds maximum size of ${SIFT_MAX_IMAGE_BYTES} bytes`);
    }
    return admitImageBuffer(buf, mime, this.budget);
  }

  readAll(filePaths: string[]): string[] {
    return filePaths.map((p) => this.read(p));
  }
}
```

Update every `new ImageAttachmentReader()` call site to pass `resolveImageTokenBudget(preset)`. Find them with:

```bash
git grep -n "new ImageAttachmentReader"
```

Update `tests/image-attachments.test.ts` construction sites the same way. A construction site with no preset in scope is a signal the preset must be threaded there — thread it; do not add a default-argument shim.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add one shared image admission path with downscaling"
```

---

## Phase B — Engine (Tasks 7–13)

### Task 7: An images-only turn reaches the engine

**Files:**
- Modify: `src/repo-search/execute.ts:288-292`
- Test: `tests/repo-search.test.ts:217-235`

- [ ] **Step 1: Update the two existing assertions and add the images-only case**

Replace the two assertions at `tests/repo-search.test.ts:217-235` — the empty-and-imageless case is still a real failure, only its message changed — and add a third test. The valid PNG data URL is the same literal used in `tests/image-attachments.test.ts:11`.

```ts
const IMAGES_ONLY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('executeRepoSearchRequest rejects an empty prompt with no images', async () => {
  await assert.rejects(
    () => executeRepoSearchRequest({ presetId: 'repo-search', prompt: '', repoRoot: process.cwd() }),
    /A prompt or an image is required\./u,
  );
});

test('executeRepoSearchRequest rejects a whitespace-only prompt with no images', async () => {
  await assert.rejects(
    () => executeRepoSearchRequest({ presetId: 'repo-search', prompt: '   ', repoRoot: process.cwd() }),
    /A prompt or an image is required\./u,
  );
});

test('executeRepoSearchRequest does not reject an images-only request at the prompt guard', async () => {
  await assert.doesNotReject(
    async () => {
      try {
        await executeRepoSearchRequest({
          presetId: 'chat',
          taskKind: 'chat',
          prompt: '',
          repoRoot: process.cwd(),
          initialUserImages: [IMAGES_ONLY_PNG],
        });
      } catch (error) {
        // Anything past the guard is acceptable here; only the guard is under test.
        assert.doesNotMatch(String(error), /prompt or an image is required/u);
      }
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the current message is `A --prompt is required for repo-search.`

- [ ] **Step 3: Write minimal implementation**

Replace `src/repo-search/execute.ts:288-292` with:

```ts
  const prompt = String(request.prompt || '').trim();
  if (!prompt && (request.initialUserImages ?? []).length === 0) {
    throw new Error('A prompt or an image is required.');
  }
```

Note the removed `basePrompt` alias — it had exactly one reader.

- [ ] **Step 4: Confirm the CLI guard is untouched**

The CLI guard at `src/cli/run-repo-search.ts:31` **stays strict and keeps its current message**: `siftkit repo-search` with no `--prompt` is a user error worth naming by flag. `tests/cli-internal.test.ts:263` exercises it and must still pass unchanged. If that test fails, the CLI guard was relaxed by mistake — revert that change.

Run: `npm test`
Expected: PASS, including `tests/cli-internal.test.ts:263`.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/execute.ts tests/repo-search.test.ts
git commit -m "fix: let an images-only turn past the engine prompt guard"
```

---

### Task 8: `VisionImageRetention` preset field

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `packages/contracts/src/config.ts:67,79`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Test: `tests/config.test.ts` (or the existing preset-normalization test file — locate it with `git grep -ln "VisionEnabled" tests/`)

- [ ] **Step 1: Write the failing test**

Append to the located preset-normalization test file:

```ts
test('VisionImageRetention defaults to 8 on a preset that omits it', () => {
  const [preset] = getDefaultConfigObject().Server.ModelPresets.Presets;
  assert.equal(preset.VisionImageRetention, 8);
});

test('VisionImageRetention is a recognised model preset field', () => {
  assert.equal(ModelPresetFieldSchema.safeParse('VisionImageRetention').success, true);
});

test('VisionImageRetention accepts -1 for unbounded and 0 for disabled', () => {
  for (const value of [-1, 0, 8, 32]) {
    assert.equal(
      ModelRuntimePresetSchema.safeParse({ ...makeTestPreset(), VisionImageRetention: value }).success,
      true,
      String(value),
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the field does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/config/constants.ts` — insert after `SIFT_DEFAULT_VISION_ENABLED` (line 44):

```ts
/** Images kept live in context. -1 is unbounded; 0 refuses images on every path. */
export const SIFT_DEFAULT_VISION_IMAGE_RETENTION = 8;
```

`packages/contracts/src/config.ts:67` — extend `ManagedLlamaSettingsShape`, appending after `VisionEnabled: z.boolean()`:

```ts
  VisionImageRetention: z.number().int().min(-1),
```

`packages/contracts/src/config.ts:79` — append `'VisionImageRetention',` to the `ModelPresetFieldSchema` enum after `'VisionEnabled'`.

`src/config/defaults.ts` — add `VisionImageRetention: SIFT_DEFAULT_VISION_IMAGE_RETENTION,` to `defaultModelPreset` beside `VisionEnabled`, importing the constant.

`src/config/normalization.ts` — add the field beside the existing `VisionEnabled` normalization. Find the line with `git grep -n "VisionEnabled" src/config/normalization.ts` and mirror the numeric-field pattern already used there for e.g. `SleepIdleSeconds`, defaulting to `SIFT_DEFAULT_VISION_IMAGE_RETENTION`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS. The typecheck will name every other place a full `ModelRuntimePreset` literal is constructed; add the field there too.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add the VisionImageRetention preset field"
```

---

### Task 9: Two switches, two messages

`VisionEnabled: false` and `VisionImageRetention: 0` both reject images and must be distinguishable, or a user changes the wrong one.

**Files:**
- Modify: `src/llm-protocol/image-attachments.ts:118-129`
- Test: `tests/image-attachments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('assertPresetAcceptsImages names VisionImageRetention when retention is zero', () => {
  const preset = makeTestPreset({ Backend: 'exl3', VisionEnabled: true, VisionImageRetention: 0 });
  assert.throws(
    () => assertPresetAcceptsImages(preset, [VALID_PNG_URI]),
    /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
  );
});

test('assertPresetAcceptsImages still names VisionEnabled when vision is off', () => {
  const preset = makeTestPreset({ Backend: 'exl3', VisionEnabled: false, VisionImageRetention: 8 });
  assert.throws(
    () => assertPresetAcceptsImages(preset, [VALID_PNG_URI]),
    /Vision is not enabled for this preset; enable VisionEnabled to use images/u,
  );
});

test('assertPresetAcceptsImages admits images when vision is on and retention is non-zero', () => {
  const preset = makeTestPreset({ Backend: 'exl3', VisionEnabled: true, VisionImageRetention: -1 });
  assert.doesNotThrow(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — retention zero currently passes the guard.

- [ ] **Step 3: Write minimal implementation**

Append inside `assertPresetAcceptsImages` in `src/llm-protocol/image-attachments.ts`, after the `VisionEnabled` check:

```ts
  if (preset.VisionImageRetention === 0) {
    throw new Error('Image input is disabled for this preset (VisionImageRetention = 0)');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Confirm CLI `--image` is covered by the same guard**

Spec §5.2 requires retention 0 to refuse images on **every** path, including CLI `--image`. Find where the CLI resolves attachments:

```bash
git grep -n "readAll\|initialUserImages" src/cli/
```

If that path does not already call `assertPresetAcceptsImages(preset, images)`, add the call there and cover it:

```ts
test('the CLI image path refuses images when retention is zero', async () => {
  await assert.rejects(
    () => runRepoSearchCli({ prompt: 'look', images: ['docs/arch.png'], preset: presetWithZeroRetention }),
    /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
  );
});
```

Match the CLI test harness already used in `tests/cli-internal.test.ts`. The agent `read` path gets its own guard in Task 11; the HTTP routes get theirs in Task 19.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: reject images with a distinct message when retention is zero"
```

---

### Task 10: The `read` tool description gains a vision variant

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:85-101,352-370`
- Modify: `src/repo-search/engine.ts:199`
- Modify: `src/status-server/chat-prompt-context.ts:48`
- Modify: `src/agent-loop/action-parser.ts:13`
- Test: `tests/planner-protocol.test.ts` (locate with `git grep -ln "TOOL_DEFINITIONS" tests/`; create the file if none exists)

- [ ] **Step 1: Write the failing test**

```ts
const TEXT_ONLY_READ_DESCRIPTION = 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically, and a read whose whole range was already returned is rejected. Editing or writing a file clears that history, so you can read it again to see your change.';

function readDescription(definitions: StructuredOutputToolDefinition[]): string {
  const read = definitions.find((definition) => definition.function.name === 'read');
  assert.ok(read, 'read tool definition is present');
  return read.function.description;
}

test('the text-only read description is byte-identical to the historical string', () => {
  assert.equal(
    readDescription(resolveRepoSearchPlannerToolDefinitions(undefined, false)),
    TEXT_ONLY_READ_DESCRIPTION,
  );
});

test('TOOL_DEFINITIONS keeps the text-only read description', () => {
  assert.equal(readDescription(TOOL_DEFINITIONS), TEXT_ONLY_READ_DESCRIPTION);
});

test('the vision read description names every supported extension from the MIME map', () => {
  const description = readDescription(resolveRepoSearchPlannerToolDefinitions(undefined, true));
  assert.ok(description.startsWith(TEXT_ONLY_READ_DESCRIPTION));
  for (const extension of getSupportedImageExtensions()) {
    assert.ok(description.includes(extension), `names ${extension}`);
  }
  assert.ok(description.includes('offset` and `limit` do not apply to images'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveRepoSearchPlannerToolDefinitions` takes one argument.

- [ ] **Step 3: Write minimal implementation**

In `src/repo-search/planner-protocol.ts`, above `REPO_TOOL_REGISTRY` (line 85):

```ts
/**
 * Generated from IMAGE_MIME_MAP rather than hardcoded, so adding a format cannot leave the
 * prompt stale.
 */
function buildVisionReadDescription(textOnlyDescription: string): string {
  const extensions = getSupportedImageExtensions().map((extension) => `\`${extension}\``);
  const formatList = `${extensions.slice(0, -1).join(', ')} or ${extensions[extensions.length - 1]}`;
  return `${textOnlyDescription} Images are supported: reading a ${formatList} file returns the `
    + 'picture itself for you to look at, not its bytes. `offset` and `limit` do not apply to images.';
}
```

Import `getSupportedImageExtensions` from `../llm-protocol/image-attachments.js`.

Replace `resolveRepoSearchPlannerToolDefinitions` (lines 352-370) with:

```ts
export function resolveRepoSearchPlannerToolDefinitions(
  allowedToolNames?: readonly string[],
  visionEnabled = false,
): StructuredOutputToolDefinition[] {
  const requested = Array.isArray(allowedToolNames)
    ? allowedToolNames.map(normalizeToolName)
    : [...EXPOSED_REPO_TOOL_NAMES];
  const seen = new Set<string>();
  const definitions: StructuredOutputToolDefinition[] = [];
  for (const toolName of requested) {
    if (seen.has(toolName) || !REGISTERED_REPO_TOOL_NAME_SET.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    const definition = REPO_TOOL_REGISTRY[toolName];
    definitions.push(visionEnabled && toolName === 'read'
      ? {
        ...definition,
        function: {
          ...definition.function,
          description: buildVisionReadDescription(definition.function.description),
        },
      }
      : definition);
  }
  return definitions;
}

/** Text-only by default; a vision run resolves its own definitions. */
export const TOOL_DEFINITIONS = resolveRepoSearchPlannerToolDefinitions();
```

Then thread `visionEnabled` at the two call sites that build definitions for a live run:

- `src/repo-search/engine.ts:199` → `resolveRepoSearchPlannerToolDefinitions(options.allowedTools, getActiveModelPreset(options.config).VisionEnabled === true)`
- `src/status-server/chat-prompt-context.ts:48` → pass the session preset's `VisionEnabled === true` as the second argument.

`src/agent-loop/action-parser.ts:13`, `src/repo-search/engine/task-loop.ts:187` and `src/repo-search/engine/task-loop-support.ts:224` resolve definitions for **parsing**, not for the prompt, so the description is irrelevant there — leave them at one argument.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: swap in a vision read tool description when the preset supports images"
```

---

### Task 11: `read` returns an image

**Files:**
- Create: `src/repo-search/engine/image-read.ts`
- Modify: `src/repo-search/engine/repo-tools.ts:28-73,1010-1015`
- Modify: `src/repo-search/engine/tool-action-processor.ts:562-572`
- Create: `tests/image-read-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/image-read-tool.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executeRepoTool } from '../src/repo-search/engine/repo-tools.js';
import { getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { gifBufferWithSize, rasterBuffer } from './helpers/image-fixtures.js';
import { makeRepoToolContext } from './helpers/repo-tool-context.js';

function writeFixtureImages(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.png'), rasterBuffer('png', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.jpg'), rasterBuffer('jpeg', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.jpeg'), rasterBuffer('jpeg', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.webp'), rasterBuffer('webp', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.gif'), gifBufferWithSize(120, 80));
}

test('read returns an image for every supported extension when vision is on', async () => {
  const repoRoot = createManagedTempDir('image-read-formats');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  for (const extension of getSupportedImageExtensions()) {
    const result = await executeRepoTool('read', { path: `docs/arch${extension}` }, context);
    assert.equal(result.ok, true, extension);
    assert.ok(result.ok && result.imageDataUrl, `${extension} carries an imageDataUrl`);
    assert.match(result.ok ? result.output : '', /^Image docs\/arch\..+ \(120×80\) attached below\.$/u);
  }
});

test('read refuses an image when the preset has no vision', async () => {
  const repoRoot = createManagedTempDir('image-read-no-vision');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: false });

  const result = await executeRepoTool('read', { path: 'docs/arch.png' }, context);

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'reading images requires an exl3 preset with VisionEnabled; this preset is text-only',
  );
});

test('read refuses an image when retention is zero, with the retention message', async () => {
  const repoRoot = createManagedTempDir('image-read-retention-zero');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true, visionImageRetention: 0 });

  const result = await executeRepoTool('read', { path: 'docs/arch.png' }, context);

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'Image input is disabled for this preset (VisionImageRetention = 0)',
  );
});

test('read rejects offset on an image path rather than ignoring it', async () => {
  const repoRoot = createManagedTempDir('image-read-offset');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool('read', { path: 'docs/arch.png', offset: 2 }, context);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /offset and limit do not apply to images/u);
});

test('read rejects limit on an image path', async () => {
  const repoRoot = createManagedTempDir('image-read-limit');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool('read', { path: 'docs/arch.png', limit: 5 }, context);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /offset and limit do not apply to images/u);
});

test('read on an image keeps the ignore-policy and existence checks', async () => {
  const repoRoot = createManagedTempDir('image-read-missing');
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool('read', { path: 'docs/nope.png' }, context);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'path is not a readable file');
});

test('read on an image produces no lineReadStats', async () => {
  const repoRoot = createManagedTempDir('image-read-stats');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool('read', { path: 'docs/arch.png' }, context);

  assert.equal(result.ok && result.lineReadStats, undefined);
  assert.equal(result.ok && result.readFile, undefined);
});
```

Create `tests/helpers/repo-tool-context.ts`:

```ts
import type { RepoToolContext } from '../../src/repo-search/engine/repo-tools.js';
import { buildIgnorePolicy } from '../../src/repo-search/command-safety.js';
import { WebResearchTools } from '../../src/web-search/web-research-tools.js';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.js';
import { makeTestPreset } from './model-presets.js';

export function makeRepoToolContext(overrides: {
  repoRoot: string;
  visionEnabled: boolean;
  visionImageRetention?: number;
}): RepoToolContext {
  return {
    repoRoot: overrides.repoRoot,
    ignorePolicy: buildIgnorePolicy(overrides.repoRoot),
    webTools: new WebResearchTools(),
    expandReads: true,
    agentRunId: 'test-run',
    validationCommandOutputLineLimit: null,
    visionEnabled: overrides.visionEnabled,
    visionImageRetention: overrides.visionImageRetention ?? 8,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys: new Set<string>(),
  };
}
```

If `buildIgnorePolicy` / `new WebResearchTools()` do not have those exact signatures, read `src/repo-search/command-safety.ts` and `src/web-search/web-research-tools.ts` and use the real ones — or copy the construction from whichever existing test already builds a `RepoToolContext` (`git grep -ln "expandReads" tests/`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `RepoToolContext` has no `visionEnabled`, and `read` returns file text.

- [ ] **Step 3: Extend the tool context and execution types**

`src/repo-search/engine/repo-tools.ts` — add to `RepoToolExecution`'s success branch (after `lineReadStats`, line 55):

```ts
    /**
     * Set by an image `read`. The engine appends this as a user-role message right after the
     * tool result: OpenAI-compatible endpoints are not required to scan tool-role messages for
     * `image_url` parts, and the user-message form needs no such guarantee.
     */
    imageDataUrl?: string;
    imageMetadata?: ImageMetadata;
    /** Path key of the image, so the caller can track what is live in context. */
    imagePathKey?: string;
```

Add to `RepoToolContext` (line 64-73):

```ts
  visionEnabled: boolean;
  /** 0 refuses images on every path, including this one. -1 is unbounded. */
  visionImageRetention: number;
  imageTokenBudget: ImageTokenBudget;
  /**
   * Path keys of images currently live in the transcript. Keyed off "in context", not "ever
   * read": once an image ages out under VisionImageRetention or is dropped by compaction,
   * re-reading it must be permitted again.
   */
  liveImagePathKeys: Set<string>;
```

- [ ] **Step 4: Write the image read branch**

Create `src/repo-search/engine/image-read.ts`:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';

import { admitImageBuffer } from '../../llm-protocol/image-admission.js';
import { imageMimeForPath } from '../../llm-protocol/image-attachments.js';
import { SIFT_MAX_IMAGE_BYTES } from '../../config/constants.js';
import { buildReadPathKey } from './read-overlap.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RepoToolContext, RepoToolExecution } from './repo-tools.js';

export const VISION_DISABLED_READ_REASON =
  'reading images requires an exl3 preset with VisionEnabled; this preset is text-only';

/** Must stay byte-identical to the message assertPresetAcceptsImages throws. */
export const RETENTION_ZERO_READ_REASON =
  'Image input is disabled for this preset (VisionImageRetention = 0)';

/**
 * Shares `read`'s path resolution, ignore policy and existence checks, then diverges: no line
 * windowing, no read-overlap tracking, and a re-read guard keyed off what is live in context.
 */
export function executeImageRead(options: {
  args: JsonObject;
  requestedCommand: string;
  absolutePath: string;
  displayPath: string;
  context: RepoToolContext;
}): RepoToolExecution {
  const { args, requestedCommand, absolutePath, displayPath, context } = options;
  if (!context.visionEnabled) {
    return { ok: false, command: requestedCommand, reason: VISION_DISABLED_READ_REASON, toolType: 'read' };
  }
  // Two switches, two messages: a user must be able to tell which one to change.
  if (context.visionImageRetention === 0) {
    return { ok: false, command: requestedCommand, reason: RETENTION_ZERO_READ_REASON, toolType: 'read' };
  }
  if (args.offset !== undefined || args.limit !== undefined) {
    return {
      ok: false,
      command: requestedCommand,
      reason: 'offset and limit do not apply to images; read the image without them',
      toolType: 'read',
    };
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file', toolType: 'read' };
  }
  const pathKey = buildReadPathKey(displayPath);
  if (context.liveImagePathKeys.has(pathKey)) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `${displayPath} is already attached in this context. Look at the image above instead of reading it again.`,
      toolType: 'read',
    };
  }
  const mime = imageMimeForPath(displayPath);
  if (mime === undefined) {
    return { ok: false, command: requestedCommand, reason: 'path is not a supported image', toolType: 'read' };
  }
  const buffer = readFileSync(absolutePath);
  if (buffer.byteLength > SIFT_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `image is ${buffer.byteLength} bytes; the limit is ${SIFT_MAX_IMAGE_BYTES} bytes`,
      toolType: 'read',
    };
  }
  let admitted;
  try {
    admitted = admitImageBuffer(buffer, mime, context.imageTokenBudget);
  } catch (error) {
    return {
      ok: false,
      command: requestedCommand,
      reason: error instanceof Error ? error.message : String(error),
      toolType: 'read',
    };
  }
  return {
    ok: true,
    requestedCommand,
    command: requestedCommand,
    exitCode: 0,
    output: `Image ${displayPath} (${admitted.metadata.width}×${admitted.metadata.height}) attached below.`,
    toolType: 'read',
    imageDataUrl: admitted.dataUrl,
    imageMetadata: admitted.metadata,
    imagePathKey: pathKey,
  };
}
```

- [ ] **Step 5: Dispatch to it**

Replace `src/repo-search/engine/repo-tools.ts:1010-1015` with:

```ts
  if (toolName === 'read') {
    const requestedCommand = buildRepoToolRequestedCommand('read', args);
    const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path);
    if (!resolvedPath) {
      return failure('read', requestedCommand, 'path must stay within the repository root');
    }
    if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
      return failure('read', requestedCommand, 'path is ignored by runtime policy');
    }
    if (isImagePath(resolvedPath.relativePath)) {
      return executeImageRead({
        args,
        requestedCommand,
        absolutePath: resolvedPath.absolutePath,
        displayPath: resolvedPath.relativePath,
        context,
      });
    }
    const plan = planRead(args, context.repoRoot, context.ignorePolicy, context.fileReadStateByPath, context.expandReads);
    return isFailedReadPlan(plan)
      ? failure('read', plan.command, plan.reason)
      : buildReadExecution('read', plan);
  }
```

`planRead` re-runs those two checks for the text path; that is duplicated work on a cheap path, not duplicated logic, and keeps `planRead` independently callable. Import `isImagePath` from `../../llm-protocol/image-attachments.js` and `executeImageRead` from `./image-read.js`.

- [ ] **Step 6: Populate the new context fields**

`src/repo-search/engine/tool-action-processor.ts:562-572` — add to the `RepoToolContext` literal:

```ts
      visionEnabled: this.deps.visionEnabled,
      visionImageRetention: this.deps.visionImageRetention,
      imageTokenBudget: this.deps.imageTokenBudget,
      liveImagePathKeys: this.deps.liveImagePathKeys,
```

Add those four to the processor's `deps` type and thread them from the task loop, where `getActiveModelPreset(options.config)` is already available (`src/repo-search/engine/task-loop-support.ts:179`):

```ts
      visionEnabled: getActiveModelPreset(options.config).VisionEnabled === true,
      visionImageRetention: getActiveModelPreset(options.config).VisionImageRetention,
      imageTokenBudget: resolveImageTokenBudget(getActiveModelPreset(options.config)),
      liveImagePathKeys: new Set<string>(),
```

The `Set` is created once per run and owned by the task loop, so Task 13 and Task 16 can both mutate it.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: let the read tool return a repository image"
```

---

### Task 12: The image reaches the transcript

**Files:**
- Modify: `src/repo-search/engine/transcript-manager.ts:85-87`
- Modify: `src/repo-search/engine/tool-action-processor.ts:171-209`
- Test: `tests/image-read-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/image-read-tool.test.ts`:

```ts
test('TranscriptManager.pushUser attaches images as image_url parts', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hello',
    initialUserImages: [],
  });

  transcript.pushUser('look', ['data:image/png;base64,AAAA']);

  const [last] = transcript.getMessages().slice(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});

test('an image read appends exactly one user message immediately after its tool result', async () => {
  const repoRoot = createManagedTempDir('image-read-transcript');
  writeFixtureImages(repoRoot);

  const roles = await runImageReadTurnRoles(repoRoot, ['docs/arch.png']);

  assert.deepEqual(roles.slice(-3), ['assistant', 'tool', 'user']);
});

test('two image reads in one batch each land after their own tool result', async () => {
  const repoRoot = createManagedTempDir('image-read-transcript-batch');
  writeFixtureImages(repoRoot);

  const roles = await runImageReadTurnRoles(repoRoot, ['docs/arch.png', 'docs/arch.webp']);

  assert.deepEqual(roles.slice(-5), ['assistant', 'tool', 'user', 'tool', 'user']);
});
```

`runImageReadTurnRoles(repoRoot, paths)` drives one `ToolActionProcessor` batch with one `read` action per path and returns `transcript.messageRoles()`. Build it in the test file using whatever harness the existing tool-action-processor tests use — find it with `git grep -ln "ToolActionProcessor" tests/` and reuse that setup rather than inventing a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `pushUser` takes one argument, and no user message is appended after a tool result.

- [ ] **Step 3: Write minimal implementation**

`src/repo-search/engine/transcript-manager.ts:85-87`:

```ts
  pushUser(content: string, images: readonly string[] = []): void {
    this.messages.push({ role: 'user', content: buildUserContent(content, images) });
  }
```

`src/repo-search/engine/tool-action-processor.ts` — extend `TurnBatchState` (line 171-179) with:

```ts
      pendingToolImages: [],
```

and its type with:

```ts
  /** One entry per tool result that produced an image, in batch order. */
  pendingToolImages: Array<{ outcomeIndex: number; dataUrl: string; pathKey: string; metadata: ImageMetadata }>;
```

Where the successful execution is pushed onto `state.batchOutcomes` (around `src/repo-search/engine/tool-action-processor.ts:873-884`), record the image:

```ts
    if (execution.ok && execution.imageDataUrl && execution.imagePathKey && execution.imageMetadata) {
      state.pendingToolImages.push({
        outcomeIndex: state.batchOutcomes.length - 1,
        dataUrl: execution.imageDataUrl,
        pathKey: execution.imagePathKey,
        metadata: execution.imageMetadata,
      });
    }
```

`appendToolBatchExchange` writes one assistant message followed by one tool message per outcome, so the tool message for outcome `i` sits at `preAppendMessagesLength + 1 + i`. Insert the image messages **after** `appendBatchExchange` and **before** `pendingModeChangeUserMessages` at `src/repo-search/engine/tool-action-processor.ts:207`, walking backwards so earlier insertions do not shift later indexes:

```ts
    for (const pending of [...state.pendingToolImages].reverse()) {
      transcript.insertUserAfter(
        preAppendMessagesLength + 1 + pending.outcomeIndex,
        `Image for ${pending.pathKey}:`,
        [pending.dataUrl],
      );
      this.deps.liveImagePathKeys.add(pending.pathKey);
    }
```

Add `insertUserAfter` to `TranscriptManager`:

```ts
  insertUserAfter(index: number, content: string, images: readonly string[]): void {
    this.messages.splice(index + 1, 0, { role: 'user', content: buildUserContent(content, images) });
  }
```

Insertion shifts `duplicates.setReplayToolMessageIndex` (line 204-206), so move that call **above** the image-insertion loop. Its index is computed from `preAppendMessagesLength` and must be recorded before any splice.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: append an image read as a user message after its tool result"
```

---

### Task 13: The re-read guard follows what is live

Task 11 already reads `context.liveImagePathKeys` and Task 12 populates it. This task proves the release side: a key removed from the set permits a re-read.

**Files:**
- Test: `tests/image-read-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a second read of a live image is refused', async () => {
  const repoRoot = createManagedTempDir('image-read-dedup');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const first = await executeRepoTool('read', { path: 'docs/arch.png' }, context);
  assert.equal(first.ok, true);
  context.liveImagePathKeys.add(first.ok ? first.imagePathKey ?? '' : '');

  const second = await executeRepoTool('read', { path: 'docs/arch.png' }, context);

  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.reason, /already attached in this context/u);
});

test('re-reading is permitted again once the image is no longer live', async () => {
  const repoRoot = createManagedTempDir('image-read-dedup-release');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const first = await executeRepoTool('read', { path: 'docs/arch.png' }, context);
  const pathKey = first.ok ? first.imagePathKey ?? '' : '';
  context.liveImagePathKeys.add(pathKey);
  context.liveImagePathKeys.delete(pathKey);

  const second = await executeRepoTool('read', { path: 'docs/arch.png' }, context);

  assert.equal(second.ok, true);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS with no production change — Task 11 already implements the predicate. If either test fails, the guard was keyed off "ever read" instead of "in context"; fix `executeImageRead` to consult `context.liveImagePathKeys` only.

- [ ] **Step 3: Commit**

```bash
git add tests/image-read-tool.test.ts
git commit -m "test: pin the image re-read guard to in-context, not ever-read"
```

---

## Phase C — Retention and replay (Tasks 14–17)

### Task 14: Persist the synthetic image message

The image message must survive the run, or replay leaves text pointing at nothing.

**Files:**
- Modify: `src/repo-search/prompts.ts:376-388` (`TaskCommand`)
- Modify: `src/repo-search/engine/tool-action-processor.ts` (command record push)
- Modify: `src/state/runtime-db.ts:370-395` (column migration)
- Modify: `src/state/chat-sessions.ts:18,21-60,97-137,215-255,312-356,495-537`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/status-server/chat.ts:386-410,486-521`
- Modify: `src/status-server/chat-repo-operation-runner.ts:291-300`
- Test: `tests/image-retention.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/image-retention.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendChatMessagesWithUsage } from '../src/status-server/chat.js';
import { readChatSessionFromPath, getChatSessionPath } from '../src/state/chat-sessions.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const IMAGE_META = {
  width: 1440, height: 900, originalWidth: 1440, originalHeight: 900,
  mime: 'image/png', byteLength: 412_000, tokenEstimate: 1024, resized: false, caption: null,
};

test('a tool image is persisted as a tool_image row right after its tool call', () => {
  const runtimeRoot = createManagedTempDir('image-persist');
  const session = createTestChatSession(runtimeRoot);

  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'question', 'answer', {}, {
    turns: [{
      thinkingText: '',
      toolMessages: [{
        toolCallCommand: 'read path="docs/arch.png"',
        toolCallOutput: 'Image docs/arch.png (1440×900) attached below.',
        images: [PNG],
        imageMeta: [IMAGE_META],
      }],
    }],
  });

  const kinds = (updated.messages ?? []).map((message) => message.kind);
  assert.deepEqual(kinds, ['user_text', 'assistant_tool_call', 'tool_image', 'assistant_answer']);
});

test('a persisted tool_image row survives a session reload with its data URL and metadata', () => {
  const runtimeRoot = createManagedTempDir('image-persist-reload');
  const session = createTestChatSession(runtimeRoot);
  appendChatMessagesWithUsage(runtimeRoot, session, 'question', 'answer', {}, {
    turns: [{
      thinkingText: '',
      toolMessages: [{
        toolCallCommand: 'read path="docs/arch.png"',
        toolCallOutput: 'Image docs/arch.png (1440×900) attached below.',
        images: [PNG],
        imageMeta: [IMAGE_META],
      }],
    }],
  });

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));

  const imageMessage = (reloaded?.messages ?? []).find((message) => message.kind === 'tool_image');
  assert.ok(imageMessage);
  assert.deepEqual(imageMessage.images, [PNG]);
  assert.deepEqual(imageMessage.imageMeta, [IMAGE_META]);
});
```

`tests/helpers/chat-sessions.ts` should reuse whatever the existing chat tests already use to create a session — find it with `git grep -ln "createChatSession" tests/` and export a thin `createTestChatSession(runtimeRoot)` around it rather than duplicating setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — there is no `tool_image` kind and no `imageMeta` field.

- [ ] **Step 3: Add the persistence column and kind**

`src/state/runtime-db.ts:370-395` — append to the `ensureChatMessageTimelineSchema` column list:

```ts
  { name: 'image_meta', sql: 'ALTER TABLE chat_messages ADD COLUMN image_meta TEXT;' },
```

`src/state/chat-sessions.ts:18` — extend the kind union:

```ts
export type ChatMessageKind = 'user_text' | 'assistant_answer' | 'assistant_thinking' | 'assistant_tool_call' | 'tool_image';
```

`src/state/chat-sessions.ts:21-60` — add to `ChatMessage` after `images?: string[]`:

```ts
  imageMeta?: ImageMetadata[];
```

`src/state/chat-sessions.ts:97-137` — add to `MessageRowSchema` after `images`:

```ts
  image_meta: z.string().nullable(),
```

`src/state/chat-sessions.ts:215-255` — add to `mapMessageRow` beside the `images` mapping at line 254:

```ts
    imageMeta: row.image_meta === null
      ? []
      : z.array(ImageMetadataSchema).parse(parseJsonValueText(row.image_meta)),
```

`src/state/chat-sessions.ts:312-356` — add `image_meta` to the SELECT column list.

`src/state/chat-sessions.ts:495-537` — add `image_meta` to the INSERT column list, one more `?` placeholder, and bind `message.imageMeta && message.imageMeta.length > 0 ? JSON.stringify(message.imageMeta) : null`.

`packages/contracts/src/chat.ts` — extend `ChatMessageSchema` beside `images` (line 22):

```ts
  imageMeta: z.array(ImageMetadataSchema).optional(),
```

and add `'tool_image'` to the wire kind enum in the same file.

- [ ] **Step 4: Carry the image out of the engine**

`src/repo-search/prompts.ts:376-388` — add to `TaskCommand`:

```ts
  /** Set by an image `read`; the data URL the engine attached as a user message. */
  imageDataUrls?: string[];
  imageMeta?: ImageMetadata[];
```

In `src/repo-search/engine/tool-action-processor.ts`, where the command record is pushed (around line 873-884), populate both from `execution.imageDataUrl` / `execution.imageMetadata`.

`src/status-server/chat.ts:386-410` — add to the `PersistToolMessage` type (the element type of `AppendChatOptions['turns'][number]['toolMessages']`):

```ts
  images?: string[];
  imageMeta?: ImageMetadata[];
```

`src/status-server/chat.ts:486-521` — after the `assistant_tool_call` push inside the `for (const toolMessage of turnToolMessages)` loop, append:

```ts
      const toolImages = Array.isArray(toolMessage.images) ? toolMessage.images : [];
      if (toolImages.length > 0) {
        messages.push({
          id: randomUUID(),
          role: 'user',
          kind: 'tool_image',
          content: '',
          inputTokensEstimate: 0,
          outputTokensEstimate: 0,
          thinkingTokens: 0,
          inputTokensEstimated: false,
          outputTokensEstimated: false,
          thinkingTokensEstimated: false,
          createdAtUtc: now,
          sourceRunId,
          images: toolImages,
          imageMeta: toolMessage.imageMeta ?? [],
        });
      }
```

`src/status-server/chat-repo-operation-runner.ts:291-300` — `buildPersistTurns` already maps `buildPersistTurnsFromRepoSearchResult(result)`; carry `imageDataUrls` → `images` and `imageMeta` through in that map, and in `buildPersistTurnsFromRepoSearchResult` itself where `TaskCommand` becomes `PersistToolMessage`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: persist agent image reads as first-class tool_image messages"
```

---

### Task 15: Replay the image in position

**Files:**
- Modify: `src/status-server/chat.ts:246-289`
- Test: `tests/image-retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a persisted tool_image replays immediately after its tool result', () => {
  const session = {
    ...createTestChatSession(createManagedTempDir('image-replay')),
    messages: [
      { id: 'u1', role: 'user' as const, kind: 'user_text' as const, content: 'look at the diagram', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '' },
      { id: 't1', role: 'assistant' as const, kind: 'assistant_tool_call' as const, content: 'read path="docs/arch.png"', toolCallCommand: 'read path="docs/arch.png"', toolCallOutput: 'Image docs/arch.png (1440×900) attached below.', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '' },
      { id: 'i1', role: 'user' as const, kind: 'tool_image' as const, content: '', images: [PNG], imageMeta: [IMAGE_META], inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '' },
      { id: 'a1', role: 'assistant' as const, kind: 'assistant_answer' as const, content: 'it is a diagram', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '' },
    ],
  };

  const history = buildChatHistoryMessages(getDefaultConfigObject(), session);

  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  assert.deepEqual(history[3].content, [{ type: 'image_url', image_url: { url: PNG } }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — a `tool_image` row currently falls into the generic branch and is skipped, because its `content` is empty and the branch at `src/status-server/chat.ts:273` only keeps a message with content **or** images. (It may accidentally pass through today; the position assertion is what pins it.)

- [ ] **Step 3: Write minimal implementation**

Insert into `buildChatHistoryMessages` after the `assistant_tool_call` branch (`src/status-server/chat.ts:266-270`):

```ts
    if (kind === 'tool_image') {
      const toolImages = message.images ?? [];
      if (toolImages.length > 0) {
        history.push({ role: 'user', content: buildUserContent(trimText(message.content), toolImages) });
      }
      continue;
    }
```

Placing it inside the same loop, before the generic branch, is what keeps it in position: the row already sits directly after its tool call in `session.messages`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat.ts tests/image-retention.test.ts
git commit -m "feat: replay persisted tool images in position"
```

---

### Task 16: The retention window

**Files:**
- Create: `src/image-retention-policy.ts`
- Modify: `src/status-server/chat.ts` (apply after `buildChatHistoryMessages`)
- Modify: `src/repo-search/engine/tool-action-processor.ts` (release the re-read guard)
- Test: `tests/image-retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
function imageMessage(url: string, label: string): PlannerChatMessage {
  return { role: 'user', content: [{ type: 'text', text: label }, { type: 'image_url', image_url: { url } }] };
}

test('retention 8 keeps the 8 most recent images and degrades the ninth-oldest', () => {
  const messages = Array.from({ length: 9 }, (_, index) => imageMessage(`data:image/png;base64,I${index}`, `image docs/a${index}.png — 100×100`));

  const dropped = new ImageRetentionPolicy(8).prune(messages);

  assert.deepEqual(dropped, ['docs/a0.png']);
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'image docs/a0.png — 100×100' },
    { type: 'text', text: '[image docs/a0.png — 100×100, dropped from context]' },
  ]);
  assert.equal(countContentImages(messages[8].content), 1);
});

test('the window counts images, not messages', () => {
  const twoImages: PlannerChatMessage = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };
  const messages = [twoImages, imageMessage('data:image/png;base64,C', 'image docs/c.png — 10×10')];

  new ImageRetentionPolicy(2).prune(messages);

  // Two live images total: the newest two survive, so the first part of the first message degrades.
  assert.equal(countContentImages(messages[0].content), 1);
  assert.equal(countContentImages(messages[1].content), 1);
});

test('degrading one image leaves its live siblings untouched', () => {
  const message: PlannerChatMessage = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };

  new ImageRetentionPolicy(1).prune([message]);

  assert.equal(countContentImages(message.content), 1);
  assert.equal(extractContentText(message.content).includes('dropped from context'), true);
});

test('retention -1 never ages an image out', () => {
  const messages = Array.from({ length: 40 }, (_, index) => imageMessage(`data:image/png;base64,I${index}`, `image docs/a${index}.png — 10×10`));

  const dropped = new ImageRetentionPolicy(-1).prune(messages);

  assert.deepEqual(dropped, []);
  assert.equal(messages.reduce((total, message) => total + countContentImages(message.content), 0), 40);
});

test('retention 0 drops every image', () => {
  const messages = [imageMessage('data:image/png;base64,A', 'image docs/a.png — 10×10')];

  new ImageRetentionPolicy(0).prune(messages);

  assert.equal(countContentImages(messages[0].content), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/image-retention-policy.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/image-retention-policy.ts`:

```ts
import { extractContentText } from './llm-protocol/image-attachments.js';
import type { LlamaCppContentPart } from './llm-protocol/types.js';

type RetainableMessage = { role: string; content?: string | LlamaCppContentPart[] };

/**
 * Bounds how many images stay live in a message array, mirroring ThinkingRetentionPolicy.
 * The window counts individual images, not messages, because one message can carry several.
 * Ageing out is oldest-first, and a degraded image becomes a text part in place, so its still-live
 * siblings are untouched.
 */
export class ImageRetentionPolicy {
  constructor(private readonly retention: number) {}

  /** Rewrites `messages` in place. Returns the labels of the images it dropped, oldest first. */
  prune(messages: RetainableMessage[]): string[] {
    if (this.retention < 0) {
      return [];
    }
    const positions: Array<{ message: RetainableMessage; partIndex: number }> = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      message.content.forEach((part, partIndex) => {
        if (part.type === 'image_url') positions.push({ message, partIndex });
      });
    }
    const dropCount = Math.max(0, positions.length - this.retention);
    const dropped: string[] = [];
    for (const { message, partIndex } of positions.slice(0, dropCount)) {
      const label = extractContentText(message.content).trim() || 'image';
      dropped.push(this.extractPathLabel(label));
      if (Array.isArray(message.content)) {
        message.content[partIndex] = { type: 'text', text: `[${label}, dropped from context]` };
      }
    }
    return dropped;
  }

  /** `image docs/arch.png — 1440×900` → `docs/arch.png`, for releasing the re-read guard. */
  private extractPathLabel(label: string): string {
    const match = /^image\s+(\S+)/u.exec(label);
    return match ? match[1] : label;
  }
}
```

- [ ] **Step 4: Apply it in both places that build a transcript**

Chat replay — in `src/status-server/chat.ts`, at the end of `buildChatHistoryMessages` before `return history`:

```ts
  new ImageRetentionPolicy(getActiveModelPreset(config).VisionImageRetention).prune(history);
```

Live run — in `src/repo-search/engine/tool-action-processor.ts`, immediately after the image-insertion loop from Task 12:

```ts
    for (const droppedPath of new ImageRetentionPolicy(this.deps.visionImageRetention).prune(transcript.getMessages())) {
      this.deps.liveImagePathKeys.delete(buildReadPathKey(droppedPath));
    }
```

Add `visionImageRetention` to the processor deps, sourced from `getActiveModelPreset(options.config).VisionImageRetention` in the task loop.

Also record the image label so `extractPathLabel` finds it: change Task 12's insertion text from `Image for ${pending.pathKey}:` to

```ts
        `image ${pending.pathKey} — ${pending.metadata.width}×${pending.metadata.height}`,
```

so the degraded form reads `[image docs/arch.png — 1440×900, dropped from context]`, exactly as specified. Update Task 12's assertion on the text part accordingly.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: bound live images with VisionImageRetention"
```

---

### Task 17: Compaction releases the re-read guard

`VisionImageRetention: -1` defers entirely to compaction. If compaction drops an image message without releasing the guard, the model is stranded referring to something it cannot see.

**Files:**
- Modify: `src/repo-search/engine/transcript-manager.ts:55-59`
- Test: `tests/image-retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('compaction that drops an image message releases its re-read guard', () => {
  const liveImagePathKeys = new Set<string>([buildReadPathKey('docs/arch.png')]);
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hi',
    initialUserImages: [],
    liveImagePathKeys,
  });
  transcript.pushUser('image docs/arch.png — 1440×900', ['data:image/png;base64,A']);

  transcript.replaceWith([{ role: 'system', content: 'system' }, { role: 'user', content: 'compacted' }]);

  assert.equal(liveImagePathKeys.size, 0);
});

test('compaction that keeps an image message keeps its re-read guard', () => {
  const liveImagePathKeys = new Set<string>([buildReadPathKey('docs/arch.png')]);
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hi',
    initialUserImages: [],
    liveImagePathKeys,
  });
  const kept = { role: 'user' as const, content: [{ type: 'text', text: 'image docs/arch.png — 1440×900' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } }] };
  transcript.pushUser('image docs/arch.png — 1440×900', ['data:image/png;base64,A']);

  transcript.replaceWith([{ role: 'system', content: 'system' }, kept]);

  assert.equal(liveImagePathKeys.has(buildReadPathKey('docs/arch.png')), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `TranscriptManager` takes no `liveImagePathKeys` and `replaceWith` does not touch it.

- [ ] **Step 3: Write minimal implementation**

Add `liveImagePathKeys: Set<string>` to the `TranscriptManager` constructor options, store it, and rewrite `replaceWith` (`src/repo-search/engine/transcript-manager.ts:55-59`):

```ts
  replaceWith(compactedMessages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...compactedMessages);
    this.lastLoggedMessageCount = 0;
    this.generationCounter += 1;
    this.releaseDroppedImageGuards();
  }

  /**
   * Compaction that drops an image message must release its re-read guard, or the model is
   * stranded referring to an image it can no longer see and cannot re-read.
   */
  private releaseDroppedImageGuards(): void {
    const survivingPathKeys = new Set<string>();
    for (const message of this.messages) {
      if (!Array.isArray(message.content)) continue;
      if (countContentImages(message.content) === 0) continue;
      const match = /^image\s+(\S+)/u.exec(extractContentText(message.content).trim());
      if (match) survivingPathKeys.add(buildReadPathKey(match[1]));
    }
    for (const pathKey of [...this.liveImagePathKeys]) {
      if (!survivingPathKeys.has(pathKey)) this.liveImagePathKeys.delete(pathKey);
    }
  }
```

Pass the task loop's `liveImagePathKeys` set into the `TranscriptManager` construction site — the same set the tool-action processor already holds, so both mutate one object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: release the image re-read guard when compaction drops the image"
```

---

## Phase D — Routes (Tasks 18–19)

### Task 18: Images reach the repo-search and plan endpoints

**Files:**
- Modify: `src/status-server/chat-route-request-normalizers.ts:24-27,73-83`
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts:26-29,90-106`
- Modify: `src/status-server/routes/chat.ts:228-257`
- Modify: `src/status-server/chat-repo-operation-runner.ts:55-71,137-152,240-244`
- Modify: `dashboard/src/api.ts:403-431`
- Modify: `dashboard/src/hooks/useChatSessions.ts:353-377`
- Test: `tests/status-server-chat-routes.test.ts` (locate with `git grep -ln "repo-search/stream" tests/`)

- [ ] **Step 1: Write the failing test**

```ts
test('the repo-search endpoint forwards attached images to the engine', async () => {
  const captured = captureEngineRequests();
  const response = await postJson(`/dashboard/chat/sessions/${sessionId}/repo-search`, {
    content: 'where is the login screen',
    repoRoot: process.cwd(),
    images: [PNG],
    mockResponses: ['done'],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(captured.last().initialUserImages, [PNG]);
});

test('the plan endpoint forwards attached images to the engine', async () => {
  const captured = captureEngineRequests();
  await postJson(`/dashboard/chat/sessions/${sessionId}/plan/stream`, {
    content: 'plan the login screen',
    repoRoot: process.cwd(),
    images: [PNG],
    mockResponses: ['done'],
  });

  assert.deepEqual(captured.last().initialUserImages, [PNG]);
});

test('the repo-search endpoint still requires content', async () => {
  const response = await postJson(`/dashboard/chat/sessions/${sessionId}/repo-search`, { images: [PNG] });

  assert.equal(response.status, 400);
});

test('a repo-search image is persisted on the user message and survives a reload', async () => {
  await postJson(`/dashboard/chat/sessions/${sessionId}/repo-search`, {
    content: 'where is the login screen',
    repoRoot: process.cwd(),
    images: [PNG],
    mockResponses: ['done'],
  });

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
  const userMessage = (reloaded?.messages ?? []).find((message) => message.kind === 'user_text');

  assert.deepEqual(userMessage?.images, [PNG]);
});
```

Reuse the existing route test harness in that file (session creation, `postJson`, engine capture) rather than building a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — no layer carries `images` on this route.

- [ ] **Step 3: Write minimal implementation**

Thread `images` through every link, in order:

`src/status-server/chat-route-request-normalizers.ts:24-27`:

```ts
export type ChatRepoRequest = {
  content: string;
  images: string[];
  repoRoot: string | undefined;
};
```

`src/status-server/chat-route-request-normalizers.ts:73-83`:

```ts
export function parseChatRepoRequest(body: JsonObject): ChatRepoRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content');
  if (!content) {
    return null;
  }
  return {
    content,
    images: parseImageDataUrls(reader.value('images')),
    repoRoot: reader.optionalString('repoRoot'),
  };
}
```

`content` stays required here: a repository search with no question is not a meaningful request; images-only is a chat affordance.

`src/status-server/routes/chat-session-operation-endpoint.ts:26-29`:

```ts
export type ResolvedChatRepoRequest = {
  content: string;
  images: string[];
  repoRoot: string;
};
```

and line 105: `return { content: repoRequest.content, images: repoRequest.images, repoRoot };`

`src/status-server/routes/chat.ts:228-257` — add `images: string[];` to the `buildChatRepoOperationRequest` options and `images: options.images,` to its returned object; pass `images: request.value.images` at all three call sites (`chat.ts:1041`, `chat.ts:1113`, and the `StreamRepoSearchEndpoint` call below line 1170).

`src/status-server/chat-repo-operation-runner.ts:55-71` — add `images: string[];` to `ChatRepoOperationRequest`.

`src/status-server/chat-repo-operation-runner.ts:137-152` — add to the `executeRepoSearch` call:

```ts
      initialUserImages: request.images,
```

`src/status-server/chat-repo-operation-runner.ts:240-244` — the user message persists its images the way chat already does, so an attachment survives a session reload. Add to the `appendChatMessagesWithUsage` options object:

```ts
        images: options.request.images,
```

`dashboard/src/api.ts:403-431` — add `images?: string[];` to both stream payload types.

`dashboard/src/hooks/useChatSessions.ts:353-377` — add `images: inputs.pendingImages,` to both `streamPlanMessage` and `streamRepoSearchMessage` payloads.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: stop dropping attached images on the repo-search and plan routes"
```

---

### Task 19: `assertPresetAcceptsImages` on the repo-search and plan endpoints

The guard runs only on the message endpoints today. That is the same defect as Task 18, so it ships beside it.

**Files:**
- Modify: `src/status-server/chat-repo-operation-runner.ts:122-137`
- Test: `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('the repo-search endpoint rejects images when the preset lacks vision', async () => {
  await setSessionPreset(sessionId, presetWithoutVision.id);

  const response = await postJson(`/dashboard/chat/sessions/${sessionId}/repo-search`, {
    content: 'where is the login screen',
    repoRoot: process.cwd(),
    images: [PNG],
    mockResponses: ['done'],
  });

  assert.equal(response.status, 500);
  assert.match(String(response.body.error), /Vision is not enabled for this preset/u);
});

test('the plan endpoint rejects images when retention is zero', async () => {
  await setSessionPreset(sessionId, presetWithZeroRetention.id);

  const events = await postSse(`/dashboard/chat/sessions/${sessionId}/plan/stream`, {
    content: 'plan it',
    repoRoot: process.cwd(),
    images: [PNG],
    mockResponses: ['done'],
  });

  assert.match(String(events.error), /Image input is disabled for this preset \(VisionImageRetention = 0\)/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — no guard runs on this route.

- [ ] **Step 3: Write minimal implementation**

In `ChatRepoOperationRunner.run`, immediately after `const selected = new ChatOperationPresetSelector(...)` (`src/status-server/chat-repo-operation-runner.ts:128-129`):

```ts
    assertPresetAcceptsImages(selected.preset, request.images);
```

Placing it after preset selection is deliberate: the guard must judge the preset the run will actually use, not the session's default.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: enforce the preset image guard on the repo-search and plan routes"
```

---

## Phase E — Dashboard (Tasks 20–24)

### Task 20: Composer thumbnail strip with per-image removal

Replaces the `N image(s) attached` text at `dashboard/src/tabs/ChatTab.tsx:414`.

**Files:**
- Create: `dashboard/src/components/PendingImageStrip.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx:405-414`
- Modify: `dashboard/src/styles.css`
- Test: `dashboard/src/components/PendingImageStrip.test.tsx` (match the existing dashboard test convention — find it with `git grep -ln "render(" dashboard/src`; if the dashboard has no component tests, put the assertions in the nearest existing dashboard test file instead of introducing a second harness)

- [ ] **Step 1: Write the failing test**

```tsx
test('renders one thumbnail per pending image', () => {
  render(<PendingImageStrip images={[PNG_A, PNG_B]} onChange={() => {}} />);
  assert.equal(screen.getAllByRole('img').length, 2);
});

test('the remove control removes the right index', () => {
  const changes: string[][] = [];
  render(<PendingImageStrip images={[PNG_A, PNG_B, PNG_C]} onChange={(next) => changes.push(next)} />);

  fireEvent.click(screen.getAllByRole('button', { name: /remove image 2/iu })[0]);

  assert.deepEqual(changes, [[PNG_A, PNG_C]]);
});

test('the remove control is reachable by keyboard, not hover-only', () => {
  render(<PendingImageStrip images={[PNG_A]} onChange={() => {}} />);
  const button = screen.getByRole('button', { name: /remove image 1/iu });
  button.focus();
  assert.equal(document.activeElement, button);
});

test('renders nothing when there are no pending images', () => {
  const { container } = render(<PendingImageStrip images={[]} onChange={() => {}} />);
  assert.equal(container.firstChild, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/components/PendingImageStrip.tsx`:

```tsx
import type { PendingImage } from '../lib/downscale-image.js';

export function PendingImageStrip({ images, resizeNotes, onChange }: {
  images: string[];
  resizeNotes?: Record<number, string>;
  onChange(next: string[]): void;
}) {
  if (images.length === 0) {
    return null;
  }
  return (
    <div className="pending-images" role="list">
      {images.map((image, index) => (
        <div className="pending-image" role="listitem" key={`${index}:${image.slice(0, 32)}`}>
          <img src={image} alt={`Pending attachment ${index + 1}`} />
          {resizeNotes?.[index] ? (
            <span className="pending-image-badge" title={resizeNotes[index]}>resized</span>
          ) : null}
          <button
            type="button"
            className="pending-image-remove"
            aria-label={`Remove image ${index + 1}`}
            title={`Remove image ${index + 1}`}
            onClick={() => onChange(images.filter((_, position) => position !== index))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
```

Removal reuses the existing store transition rather than adding one: `ChatTab` passes `onChange={(next) => onPendingImagesChange(next)}`, which already routes to `setSessionImages`.

Replace `dashboard/src/tabs/ChatTab.tsx:414` (the `{pendingImages.length > 0 ? <span className="image-count">…` line) with nothing, and insert the strip **above** the `<div className="row">` at line 385, inside the composer container:

```tsx
              <PendingImageStrip
                images={pendingImages}
                resizeNotes={pendingImageResizeNotes}
                onChange={onPendingImagesChange}
              />
```

`pendingImageResizeNotes` arrives in Task 21; until then pass `undefined` by omitting the prop.

Append to `dashboard/src/styles.css`:

```css
.pending-images { display: flex; gap: 6px; overflow-x: auto; padding: 6px 0; }
.pending-image { position: relative; flex: 0 0 auto; }
.pending-image img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; display: block; }
.pending-image-remove {
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px;
  border-radius: 50%; border: none; line-height: 1; cursor: pointer;
  opacity: 0; transition: opacity 120ms ease;
}
/* Shown on hover AND on keyboard focus, never hover-only, so it stays reachable. */
.pending-image:hover .pending-image-remove,
.pending-image-remove:focus-visible { opacity: 1; }
.pending-image-badge {
  position: absolute; bottom: 2px; left: 2px; font-size: 9px;
  padding: 0 3px; border-radius: 3px; background: rgba(0, 0, 0, 0.6); color: #fff;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: preview pending composer images with per-image removal"
```

---

### Task 21: Browser-side downscale before upload

Fixes the problem at its source: a 60 MB paste never becomes an 80 MB base64 POST. This is also the only path that can downscale a GIF, since browsers decode GIF natively.

**Files:**
- Create: `dashboard/src/lib/downscale-image.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx:143-155` (`readImageFiles`)
- Test: alongside the Task 20 tests

- [ ] **Step 1: Write the failing test**

```ts
test('computeBrowserTargetDimensions matches the server-side math', () => {
  assert.equal(computeBrowserTargetDimensions(800, 600, 1_000_000), null);
  const target = computeBrowserTargetDimensions(4000, 2000, 1_000_000);
  assert.ok(target!.width * target!.height <= 1_000_000);
});

test('downscaleDataUrl leaves a within-budget image untouched and reports no resize', async () => {
  const result = await downscaleDataUrl(SMALL_PNG, 1_000_000);
  assert.equal(result.dataUrl, SMALL_PNG);
  assert.equal(result.note, null);
});

test('downscaleDataUrl reports original and final dimensions when it resizes', async () => {
  const result = await downscaleDataUrl(LARGE_PNG, 1_000);
  assert.notEqual(result.dataUrl, LARGE_PNG);
  assert.match(result.note ?? '', /^Resized from \d+×\d+ to \d+×\d+$/u);
});
```

If the dashboard test environment has no `createImageBitmap`/`OffscreenCanvas`, keep `computeBrowserTargetDimensions` as the pure, directly-tested unit and cover `downscaleDataUrl` with a jsdom stub of both globals in the test file. Do not weaken the assertions to route around a missing global.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/lib/downscale-image.ts`:

```ts
export type PendingImage = { dataUrl: string; note: string | null };

/** Mirrors computeTargetDimensions in src/llm-protocol/image-admission.ts. */
export function computeBrowserTargetDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } | null {
  if (width * height <= maxPixels) {
    return null;
  }
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function mimeOf(dataUrl: string): string {
  const separator = dataUrl.indexOf(';base64,');
  return separator < 0 ? 'image/png' : dataUrl.slice('data:'.length, separator);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/**
 * Downscales in the browser so an oversized paste never becomes an oversized POST. Browsers
 * decode GIF natively, so this is also the only path that can shrink one; the result is a
 * single frame, which is what the model sees anyway.
 */
export async function downscaleDataUrl(dataUrl: string, maxPixels: number): Promise<PendingImage> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const target = computeBrowserTargetDimensions(bitmap.width, bitmap.height, maxPixels);
  if (target === null) {
    bitmap.close();
    return { dataUrl, note: null };
  }
  const canvas = new OffscreenCanvas(target.width, target.height);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('image downscaling is unavailable: 2d canvas context could not be created');
  }
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  const note = `Resized from ${bitmap.width}×${bitmap.height} to ${target.width}×${target.height}`;
  bitmap.close();
  // GIF is not an encodable output type; a downscaled GIF ships as PNG.
  const outputType = mimeOf(dataUrl) === 'image/gif' ? 'image/png' : mimeOf(dataUrl);
  return { dataUrl: await blobToDataUrl(await canvas.convertToBlob({ type: outputType })), note };
}
```

In `dashboard/src/tabs/ChatTab.tsx`, have `readImageFiles` run each file's data URL through `downscaleDataUrl`, hold the returned notes in component state keyed by index, and pass them to `PendingImageStrip` as `resizeNotes`. The pixel ceiling comes from the session's preset — surface it on the existing preset/context payload the composer already receives rather than hardcoding a second constant in the browser.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: downscale oversized composer attachments in the browser"
```

---

### Task 22: Inline images and the collapsed annotation

**Files:**
- Create: `dashboard/src/components/MessageImages.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx:521-547` (`renderMessageBody`)
- Modify: `dashboard/src/styles.css`
- Test: alongside the Task 20 tests

- [ ] **Step 1: Write the failing test**

```tsx
const META = { width: 1440, height: 900, originalWidth: 1440, originalHeight: 900, mime: 'image/png', byteLength: 421_888, tokenEstimate: 1024, resized: false, caption: null };

test('renders each image inline in the bubble', () => {
  render(<MessageImages messageId="m1" images={[PNG_A, PNG_B]} imageMeta={[META, META]} />);
  assert.equal(screen.getAllByRole('img').length, 2);
});

test('the annotation is collapsed and shows dimensions, format, size and tokens', () => {
  render(<MessageImages messageId="m1" images={[PNG_A]} imageMeta={[META]} />);
  const disclosure = screen.getByText('1440×900 · png · 412 KB · 1,024 tok');
  assert.equal(disclosure.closest('details')?.hasAttribute('open'), false);
});

test('a user message with no metadata still renders the image', () => {
  render(<MessageImages messageId="m1" images={[PNG_A]} imageMeta={[]} />);
  assert.equal(screen.getAllByRole('img').length, 1);
});

test('renders nothing when the message has no images', () => {
  const { container } = render(<MessageImages messageId="m1" images={[]} imageMeta={[]} />);
  assert.equal(container.firstChild, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/components/MessageImages.tsx`:

```tsx
import { useState } from 'react';
import type { ImageMetadata } from '@siftkit/contracts';
import { requestImageCaption } from '../api.js';

function formatBytes(byteLength: number): string {
  return byteLength >= 1_048_576
    ? `${(byteLength / 1_048_576).toFixed(1)} MB`
    : `${Math.round(byteLength / 1024)} KB`;
}

function formatSummary(meta: ImageMetadata): string {
  const format = meta.mime.replace('image/', '');
  return `${meta.width}×${meta.height} · ${format} · ${formatBytes(meta.byteLength)} · ${meta.tokenEstimate.toLocaleString('en-US')} tok`;
}

export function MessageImages({ messageId, images, imageMeta }: {
  messageId: string;
  images: string[];
  imageMeta: ImageMetadata[];
}) {
  const [captions, setCaptions] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<Record<number, boolean>>({});

  if (images.length === 0) {
    return null;
  }

  async function loadCaption(index: number, persisted: string | null): Promise<void> {
    if (captions[index] !== undefined || pending[index]) {
      return;
    }
    if (persisted) {
      setCaptions((previous) => ({ ...previous, [index]: persisted }));
      return;
    }
    setPending((previous) => ({ ...previous, [index]: true }));
    try {
      const response = await requestImageCaption(messageId, index);
      setCaptions((previous) => ({ ...previous, [index]: response.caption }));
    } finally {
      setPending((previous) => ({ ...previous, [index]: false }));
    }
  }

  return (
    <div className="message-images">
      {images.map((image, index) => {
        const meta = imageMeta[index];
        return (
          <figure className="message-image" key={`${index}:${image.slice(0, 32)}`}>
            <img src={image} alt={meta ? `Attachment ${index + 1}, ${meta.width} by ${meta.height}` : `Attachment ${index + 1}`} />
            {meta ? (
              <details onToggle={(event) => { if (event.currentTarget.open) void loadCaption(index, meta.caption); }}>
                <summary>{formatSummary(meta)}</summary>
                <p className="image-caption-note">
                  An independent read of this image by the model at this resolution. It is not a
                  transcript of the original turn and cannot show what the model attended to then.
                </p>
                <p className="image-caption">
                  {captions[index] ?? (pending[index] ? 'Reading the image…' : '')}
                </p>
              </details>
            ) : null}
          </figure>
        );
      })}
    </div>
  );
}
```

In `dashboard/src/tabs/ChatTab.tsx`, replace the user branch at line 546 and add a `tool_image` branch to `renderMessageBody`:

```tsx
  if (messageKind === 'tool_image') {
    return <MessageImages messageId={message.id} images={message.images ?? []} imageMeta={message.imageMeta ?? []} />;
  }
  return (
    <>
      <p className="user-message">{message.content}</p>
      <MessageImages messageId={message.id} images={message.images ?? []} imageMeta={message.imageMeta ?? []} />
    </>
  );
```

Agent `read` images use the identical component; the persisted `tool_image` message from Task 14 is what the run log renders.

Append to `dashboard/src/styles.css`:

```css
.message-images { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.message-image { margin: 0; }
.message-image img { max-width: 100%; max-height: 420px; border-radius: 8px; display: block; }
.message-image summary { cursor: pointer; font-size: 11px; opacity: 0.7; }
.image-caption-note { font-size: 11px; opacity: 0.6; font-style: italic; }
.image-caption { font-size: 12px; white-space: pre-wrap; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run lint`
Expected: PASS (the caption tests come in Task 23; `requestImageCaption` must at least exist as an export by then).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: render chat images inline with a collapsed annotation"
```

---

### Task 23: The caption endpoint

**Files:**
- Create: `src/status-server/routes/chat-image-caption.ts`
- Modify: `src/status-server/route-table.ts`
- Modify: `dashboard/src/api.ts`
- Test: `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('the caption endpoint runs one vision pass, persists the caption and returns it', async () => {
  const messageId = await seedSessionWithImageMessage(sessionId, PNG);

  const response = await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, {
    messageId,
    imageIndex: 0,
    mockResponses: ['a login screen with two fields'],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.caption, 'a login screen with two fields');

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
  const message = (reloaded?.messages ?? []).find((entry) => entry.id === messageId);
  assert.equal(message?.imageMeta?.[0]?.caption, 'a login screen with two fields');
});

test('a second caption request is served from the persisted caption', async () => {
  const messageId = await seedSessionWithImageMessage(sessionId, PNG);
  await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, { messageId, imageIndex: 0, mockResponses: ['first'] });

  const second = await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, { messageId, imageIndex: 0, mockResponses: ['second'] });

  assert.equal(second.body.caption, 'first');
});

test('the caption endpoint refuses a preset without vision', async () => {
  await setSessionPreset(sessionId, presetWithoutVision.id);
  const messageId = await seedSessionWithImageMessage(sessionId, PNG);

  const response = await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, { messageId, imageIndex: 0 });

  assert.equal(response.status, 500);
  assert.match(String(response.body.error), /Vision is not enabled for this preset/u);
});

test('the caption endpoint 404s on an unknown message or index', async () => {
  const missingMessage = await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, { messageId: 'nope', imageIndex: 0 });
  assert.equal(missingMessage.status, 404);

  const messageId = await seedSessionWithImageMessage(sessionId, PNG);
  const missingIndex = await postJson(`/dashboard/chat/sessions/${sessionId}/images/caption`, { messageId, imageIndex: 7 });
  assert.equal(missingIndex.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the route does not exist (404 on every case).

- [ ] **Step 3: Write minimal implementation**

Create `src/status-server/routes/chat-image-caption.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject } from '../../lib/json-types.js';
import { assertPresetAcceptsImages } from '../../llm-protocol/image-attachments.js';
import type { ChatSession } from '../../state/chat-sessions.js';
import { updateChatMessageImageCaption } from '../../state/chat-sessions.js';
import { getRuntimeRoot } from '../paths.js';
import { sendJson } from '../http-utils.js';
import {
  ChatSessionOperationEndpoint,
  type ChatSessionOperationRequest,
} from './chat-session-operation-endpoint.js';
import type { ServerContext } from '../server-types.js';
import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  releaseModelRequest,
} from './model-request-lock.js';

const CAPTION_PROMPT = 'Describe this image in two or three sentences. Say what is legible and '
  + 'what is not at this resolution. Do not speculate about anything you cannot see.';

type CaptionRequest = { messageId: string; imageIndex: number; mockResponses: string[] | undefined };

/**
 * One single-turn vision pass per image, on demand and cached, so a run's GPU cost stays bounded.
 * The caption is an independent read of the image, not a transcript of the original turn.
 */
export class ChatImageCaptionEndpoint extends ChatSessionOperationEndpoint<CaptionRequest> {
  protected readonly operationKind = 'message' as const;

  protected parseRequest(res: ServerResponse, _session: ChatSession, parsedBody: JsonObject): CaptionRequest | null {
    const reader = new JsonRecordReader(parsedBody);
    const messageId = reader.optionalString('messageId');
    const imageIndex = reader.number('imageIndex');
    if (!messageId || imageIndex === null || imageIndex < 0) {
      sendJson(res, 400, { error: 'Expected messageId and imageIndex.' });
      return null;
    }
    const mockResponses = parsedBody.mockResponses;
    return {
      messageId,
      imageIndex,
      mockResponses: Array.isArray(mockResponses) ? mockResponses.map(String) : undefined,
    };
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<CaptionRequest>,
  ): Promise<void> {
    const message = (request.session.messages ?? []).find((entry) => entry.id === request.value.messageId);
    const dataUrl = message?.images?.[request.value.imageIndex];
    const meta = message?.imageMeta?.[request.value.imageIndex];
    if (!message || !dataUrl || !meta) {
      sendJson(res, 404, { error: 'Image not found.' });
      return;
    }
    if (meta.caption) {
      sendJson(res, 200, { caption: meta.caption });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_image_caption', req, res);
    if (!modelRequestLock) {
      return;
    }
    try {
      const preset = ctx.getActiveSessionPreset(request.session);
      assertPresetAcceptsImages(preset, [dataUrl]);
      await ensureActivePresetReadyForModelRequest(ctx);
      const caption = await ctx.engineService.completeVisionTurn({
        preset,
        prompt: CAPTION_PROMPT,
        images: [dataUrl],
        mockResponses: request.value.mockResponses,
      });
      updateChatMessageImageCaption(
        getRuntimeRoot(),
        request.sessionId,
        message.id,
        request.value.imageIndex,
        caption,
      );
      sendJson(res, 200, { caption });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}
```

Three supporting pieces:

1. `updateChatMessageImageCaption(runtimeRoot, sessionId, messageId, imageIndex, caption)` in `src/state/chat-sessions.ts` — reads the row's `image_meta`, sets `caption` at `imageIndex`, writes it back with a single `UPDATE chat_messages SET image_meta = ? WHERE session_id = ? AND id = ?`.
2. `ctx.getActiveSessionPreset(session)` — reuse whatever the message endpoints already use to resolve a session's preset (`git grep -n "assertPresetAcceptsImages" src/status-server/`) rather than adding a second resolver.
3. `engineService.completeVisionTurn` — a single-turn, no-tools completion. If `StatusEngineService` already exposes a one-shot completion helper, reuse it and pass `initialUserImages`; add a new method only if none exists.

Register the route in `src/status-server/route-table.ts` beside the other `/dashboard/chat/sessions/:id/...` entries, as `POST /dashboard/chat/sessions/([^/]+)/images/caption`.

Add to `dashboard/src/api.ts`:

```ts
export async function requestImageCaption(
  messageId: string,
  imageIndex: number,
): Promise<{ caption: string }> {
  return postJson(`/dashboard/chat/sessions/${encodeURIComponent(getSelectedSessionId())}/images/caption`, {
    messageId,
    imageIndex,
  });
}
```

If `dashboard/src/api.ts` has no ambient selected-session accessor, take `sessionId` as the first parameter and thread it from `MessageImages` — do not introduce module-level mutable state to avoid a prop.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: caption a chat image on demand with a single vision pass"
```

---

### Task 24: `VisionImageRetention` in the preset panel

**Files:**
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:494-497`
- Test: the existing settings-section test file (`git grep -ln "VisionEnabled" dashboard/src`)

- [ ] **Step 1: Write the failing test**

```tsx
test('the preset panel exposes VisionImageRetention beside VisionEnabled', () => {
  render(<ModelPresetsSection {...defaultProps} />);
  assert.ok(screen.getByLabelText(/Vision image retention/iu));
});

test('the preset panel shows the resolved image ceiling', () => {
  render(<ModelPresetsSection {...defaultProps} imageTokenBudget={{ maxPixels: 1_605_632, maxImageTokens: 2048, pixelsPerToken: 784, source: 'fallback' }} />);
  assert.ok(screen.getByText(/1\.6 MP.*2,048 image tokens.*default ratio/iu));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — neither control exists.

- [ ] **Step 3: Write minimal implementation**

Insert into `dashboard/src/tabs/settings/ModelPresetsSection.tsx` immediately after the `VisionEnabled` control at line 494-497, matching the numeric-field pattern the section already uses for e.g. `SleepIdleSeconds`:

```tsx
              <ModelPresetControl preset={preset} field="VisionImageRetention" label="Vision image retention">
                <input type="number" min={-1} step={1} />
              </ModelPresetControl>
              <p className="field-hint">
                Images kept live in context. -1 keeps every image; 0 refuses images entirely.
              </p>
              {imageTokenBudget ? (
                <p className="field-hint">
                  {`Image ceiling ${(imageTokenBudget.maxPixels / 1_000_000).toFixed(1)} MP `}
                  {`(≈${imageTokenBudget.maxImageTokens.toLocaleString('en-US')} image tokens)`}
                  {imageTokenBudget.source === 'fallback' ? ' — default ratio; no preprocessor_config.json found' : ''}
                </p>
              ) : null}
```

Surface `imageTokenBudget` on whichever status/config payload the settings panel already consumes, computed server-side by `resolveImageTokenBudget(preset)`. The resolved ceiling must be visible before it is hit.

Copy the exact `ModelPresetControl` invocation shape from the `SleepIdleSeconds` control in the same file; the snippet above is the intent, not necessarily the exact prop signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: expose VisionImageRetention and the image ceiling in the preset panel"
```

---

## Phase F — Final verification (Task 25)

### Task 25: Full-suite verification

**Files:** none

- [ ] **Step 1: Run the whole suite**

```bash
npm test
```
Expected: all tests PASS. Report any failure with its output; do not weaken a test to make it pass.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: exit 0, no output. Any `any`, type assertion, or non-null assertion introduced along the way is a defect — remove it.

- [ ] **Step 3: Lint**

```bash
npm run lint
```
Expected: exit 0.

- [ ] **Step 4: Confirm the deliberate asymmetries survived**

```bash
git grep -n "prompt is required" src/cli/run-repo-search.ts
git grep -n "A prompt or an image is required" src/repo-search/execute.ts
```
Expected: the CLI keeps its flag-specific message; the engine has the generic one. This asymmetry is deliberate (spec §1) — if a reviewer flags it, point them at that section.

- [ ] **Step 5: Commit any residue**

```bash
git status --short
```
Expected: clean. If not, the residue is scope drift — remove it or commit it deliberately.

---

## Deferred / not in this plan

- **Server-side GIF resize.** `@napi-rs/image` cannot decode GIF, so an oversized GIF on the `read` or CLI path is rejected with the resize message. The browser path handles GIF because browsers decode it natively. If server-side GIF resize later proves to matter, that is the trigger to switch that path to `sharp`, which handles it via libvips — not a reason to add a second image library now.
- **`preflightPlannerPromptBudget`** is unchanged (spec §4.5). Admission now guarantees every image is at or under `SIFT_IMAGE_TOKEN_ESTIMATE`, so the existing flat per-image charge at `src/repo-search/prompt-budget.ts:139-142` is accurate by construction rather than a guess.
- **Video, PDF, multi-frame GIF beyond frame one, automatic re-captioning on preset change** — out of scope per spec §Scope.
- **End-to-end verification against a live vision model** is blocked: TabbyAPI returned 503 on every completion during the design work, and no vision model is installed on this machine. Every task above is verifiable by unit and route tests without a live provider; the first live run is the acceptance test the environment currently cannot provide.
