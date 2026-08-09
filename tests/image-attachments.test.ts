import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ImageDataUrlSchema, SIFT_MAX_IMAGE_BYTES, type ImageTokenBudget } from '@siftkit/contracts';
import { parseImageDataUrls, ImageAttachmentReader, buildUserContent, assertPresetAcceptsImages, isImagePath, imageMimeForPath, getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { gifBufferWithSize, INSTALLED_ENCODER, rasterBuffer } from './helpers/image-fixtures.js';
import { makeTestPreset } from './helpers/model-presets.js';

const VALID_PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_JPEG_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/4QCMRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAEAAAAAAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgAA+/eHxYM';
const VALID_WEBP_URI = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuQAAA=';
const VALID_GIF_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const TEST_BUDGET: ImageTokenBudget = {
  maxPixels: 1_000_000,
  pixelsPerToken: 784,
  maxImageTokens: 1275,
  encoder: INSTALLED_ENCODER,
  source: 'fallback',
};

test('ImageDataUrlSchema accepts valid png data URI', () => {
  const result = ImageDataUrlSchema.safeParse(VALID_PNG_URI);
  assert.equal(result.success, true);
});

test('ImageDataUrlSchema accepts valid jpeg data URI', () => {
  const result = ImageDataUrlSchema.safeParse(VALID_JPEG_URI);
  assert.equal(result.success, true);
});

test('ImageDataUrlSchema accepts valid webp data URI', () => {
  const result = ImageDataUrlSchema.safeParse(VALID_WEBP_URI);
  assert.equal(result.success, true);
});

test('ImageDataUrlSchema accepts valid gif data URI', () => {
  const result = ImageDataUrlSchema.safeParse(VALID_GIF_URI);
  assert.equal(result.success, true);
});

test('ImageDataUrlSchema rejects non-data-uri string', () => {
  const result = ImageDataUrlSchema.safeParse('not-a-uri');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((e) => e.message === 'supported-image'));
  }
});

test('ImageDataUrlSchema rejects unsupported mime type', () => {
  const result = ImageDataUrlSchema.safeParse('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((e) => e.message === 'supported-image'));
  }
});

test('ImageDataUrlSchema rejects missing base64 prefix', () => {
  const result = ImageDataUrlSchema.safeParse('image/png;base64,abc');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((e) => e.message === 'supported-image'));
  }
});

test('parseImageDataUrls parses array of valid URIs', () => {
  const uris = parseImageDataUrls([VALID_PNG_URI, VALID_JPEG_URI]);
  assert.equal(uris.length, 2);
  assert.equal(uris[0], VALID_PNG_URI);
  assert.equal(uris[1], VALID_JPEG_URI);
});

test('parseImageDataUrls rejects array with invalid entry', () => {
  const result = (() => {
    try {
      parseImageDataUrls([VALID_PNG_URI, 'invalid']);
      return false;
    } catch {
      return true;
    }
  })();
  assert.equal(result, true);
});

test('parseImageDataUrls rejects non-array input', () => {
  // A number is valid JSON but not an image list; the runtime schema rejects it.
  assert.throws(() => parseImageDataUrls(42));
});

test('parseImageDataUrls treats an absent field as no images', () => {
  assert.deepEqual(parseImageDataUrls(undefined), []);
  assert.deepEqual(parseImageDataUrls(null), []);
});

test('ImageAttachmentReader.read returns data URI for .png', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(filePath, rasterBuffer('png', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .jpg', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.jpg');
  fs.writeFileSync(filePath, rasterBuffer('jpeg', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .jpeg', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.jpeg');
  fs.writeFileSync(filePath, rasterBuffer('jpeg', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .webp', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.webp');
  fs.writeFileSync(filePath, rasterBuffer('webp', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/webp;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .gif', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.gif');
  fs.writeFileSync(filePath, gifBufferWithSize(1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/gif;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read handles uppercase extensions', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.PNG');
  fs.writeFileSync(filePath, rasterBuffer('png', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read throws for unknown extension', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(filePath, 'hello');
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  assert.throws(() => reader.read(filePath), /txt/u);
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read throws for missing file', async () => {
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  let threw = false;
  try {
    await reader.read('/nonexistent/path/test.png');
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

test('ImageAttachmentReader.read throws for oversized file', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'big.png');
  fs.writeFileSync(filePath, Buffer.alloc(SIFT_MAX_IMAGE_BYTES + 1, 0));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  let threw = false;
  try {
    await reader.read(filePath);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.readAll preserves order', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const paths = [
    path.join(tmpDir, 'a.png'),
    path.join(tmpDir, 'b.png'),
    path.join(tmpDir, 'c.png'),
  ];
  fs.writeFileSync(paths[0], rasterBuffer('png', 1, 1));
  fs.writeFileSync(paths[1], rasterBuffer('png', 1, 1));
  fs.writeFileSync(paths[2], rasterBuffer('png', 1, 1));
  const reader = new ImageAttachmentReader(TEST_BUDGET);
  const uris = await reader.readAll(paths);
  assert.equal(uris.length, 3);
  assert.ok(uris.every((u) => u.startsWith('data:image/png;base64,')));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageDataUrlSchema rejects a data URL whose payload exceeds SIFT_MAX_IMAGE_BYTES', () => {
  // 4 base64 chars encode 3 bytes, so this payload decodes to just over the limit.
  const base64Length = Math.ceil((SIFT_MAX_IMAGE_BYTES + 1) / 3) * 4;
  const oversized = `data:image/png;base64,${'A'.repeat(base64Length)}`;
  const result = ImageDataUrlSchema.safeParse(oversized);
  assert.equal(result.success, false);
});

test('ImageDataUrlSchema accepts a data URL at exactly SIFT_MAX_IMAGE_BYTES', () => {
  const base64Length = Math.ceil(SIFT_MAX_IMAGE_BYTES / 3) * 4;
  const atLimit = `data:image/png;base64,${'A'.repeat(base64Length - 1)}=`;
  assert.equal(ImageDataUrlSchema.safeParse(atLimit).success, true);
});

test('parseImageDataUrls rejects an oversized entry rather than dropping it', () => {
  const base64Length = Math.ceil((SIFT_MAX_IMAGE_BYTES + 1) / 3) * 4;
  const oversized = `data:image/png;base64,${'A'.repeat(base64Length)}`;
  assert.throws(() => parseImageDataUrls([VALID_PNG_URI, oversized]));
});

test('buildUserContent returns plain string for zero images', () => {
  const result = buildUserContent('hello world', []);
  assert.equal(result, 'hello world');
});

test('buildUserContent returns plain string for zero images with empty text', () => {
  const result = buildUserContent('', []);
  assert.equal(result, '');
});

test('buildUserContent returns content parts array for one image', () => {
  const result = buildUserContent('describe this', [VALID_PNG_URI]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'describe this');
  assert.equal(result[1].type, 'image_url');
  assert.equal(result[1].image_url?.url, VALID_PNG_URI);
});

test('buildUserContent returns content parts for many images', () => {
  const result = buildUserContent('compare', [VALID_PNG_URI, VALID_JPEG_URI]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'compare');
  assert.equal(result[1].type, 'image_url');
  assert.equal(result[2].type, 'image_url');
});

test('buildUserContent handles empty text with images', () => {
  const result = buildUserContent('', [VALID_PNG_URI]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'image_url');
});

test('assertPresetAcceptsImages is no-op for zero images', () => {
  const preset = makeTestPreset({ Backend: 'llama', VisionEnabled: false });
  assert.doesNotThrow(() => assertPresetAcceptsImages(preset, []));
});

test('assertPresetAcceptsImages accepts managed EXL3 with VisionEnabled=true', () => {
  const preset = makeTestPreset({ Backend: 'exl3', VisionEnabled: true });
  assert.doesNotThrow(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]));
});

test('assertPresetAcceptsImages throws for llama backend', () => {
  const preset = makeTestPreset({ Backend: 'llama', VisionEnabled: true });
  assert.throws(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]), /llama/iu);
});

test('assertPresetAcceptsImages throws for VisionEnabled=false', () => {
  const preset = makeTestPreset({ Backend: 'exl3', VisionEnabled: false });
  assert.throws(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]), /vision/iu);
});

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
