import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ImageDataUrlSchema, parseImageDataUrls, ImageAttachmentReader, buildUserContent, assertPresetAcceptsImages } from '../src/llm-protocol/image-attachments.js';
import { SIFT_MAX_IMAGE_BYTES } from '../src/config/constants.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const VALID_PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_JPEG_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/4QCMRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAEAAAAAAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgAA+/eHxYM';
const VALID_WEBP_URI = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuQAAA=';
const VALID_GIF_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function makePreset(opts: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  return {
    id: 'test',
    label: 'Test',
    Backend: 'llama',
    Model: null,
    ExternalServerEnabled: false,
    ExecutablePath: null,
    BaseUrl: 'http://localhost:8080',
    BindHost: '127.0.0.1',
    Port: 8080,
    ModelPath: null,
    NumCtx: 8192,
    GpuLayers: 99,
    Threads: 0,
    NcpuMoe: 0,
    FlashAttention: true,
    ParallelSlots: 1,
    BatchSize: 512,
    UBatchSize: 512,
    CacheRam: 8192,
    CacheRecurrentRam: 4096,
    KvCacheQuantization: 'f16',
    MaxTokens: 4096,
    Temperature: 0.7,
    TopP: 0.95,
    TopK: 40,
    MinP: 0.05,
    PresencePenalty: 0,
    RepetitionPenalty: 1.1,
    Reasoning: 'off',
    ReasoningContent: false,
    PreserveThinking: false,
    MaintainPerStepThinking: false,
    SpeculativeEnabled: false,
    SpeculativeType: 'ngram-simple',
    SpeculativeMtpEnabled: false,
    SpeculativeNgramSizeN: 3,
    SpeculativeNgramSizeM: 2,
    SpeculativeNgramMinHits: 2,
    SpeculativeNgramModNMatch: 1,
    SpeculativeNgramModNMin: 1,
    SpeculativeNgramModNMax: 3,
    SpeculativeDraftMax: 16,
    SpeculativeDraftMin: 1,
    SpeculativeDynamic: true,
    ReasoningBudget: 0,
    ReasoningBudgetMessage: null,
    StartupTimeoutMs: 60000,
    HealthcheckTimeoutMs: 30000,
    HealthcheckIntervalMs: 5000,
    SleepIdleSeconds: 600,
    VerboseLogging: false,
    VisionEnabled: false,
    ...opts,
  };
}

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
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .jpg', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.jpg');
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .jpeg', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.jpeg');
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .webp', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.webp');
  fs.writeFileSync(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/webp;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read returns data URI for .gif', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.gif');
  fs.writeFileSync(filePath, Buffer.from([0x47, 0x49, 0x46, 0x38]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/gif;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read handles uppercase extensions', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.PNG');
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const reader = new ImageAttachmentReader();
  const uri = await reader.read(filePath);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read throws for unknown extension', async () => {
  const tmpDir = createManagedTempDir('img-att-');
  const filePath = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(filePath, 'hello');
  const reader = new ImageAttachmentReader();
  assert.throws(() => reader.read(filePath), /txt/u);
  fs.rmSync(tmpDir, { recursive: true });
});

test('ImageAttachmentReader.read throws for missing file', async () => {
  const reader = new ImageAttachmentReader();
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
  const reader = new ImageAttachmentReader();
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
  fs.writeFileSync(paths[0], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(paths[1], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(paths[2], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const reader = new ImageAttachmentReader();
  const uris = await reader.readAll(paths);
  assert.equal(uris.length, 3);
  assert.ok(uris.every((u) => u.startsWith('data:image/png;base64,')));
  fs.rmSync(tmpDir, { recursive: true });
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
  const preset = makePreset({ Backend: 'llama', VisionEnabled: false });
  assert.doesNotThrow(() => assertPresetAcceptsImages(preset, []));
});

test('assertPresetAcceptsImages accepts managed EXL3 with VisionEnabled=true', () => {
  const preset = makePreset({ Backend: 'exl3', VisionEnabled: true });
  assert.doesNotThrow(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]));
});

test('assertPresetAcceptsImages throws for llama backend', () => {
  const preset = makePreset({ Backend: 'llama', VisionEnabled: true });
  assert.throws(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]), /llama/iu);
});

test('assertPresetAcceptsImages throws for VisionEnabled=false', () => {
  const preset = makePreset({ Backend: 'exl3', VisionEnabled: false });
  assert.throws(() => assertPresetAcceptsImages(preset, [VALID_PNG_URI]), /vision/iu);
});