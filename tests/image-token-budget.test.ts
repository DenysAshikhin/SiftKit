import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  estimateVisionPeakVramBytesForImagePixels,
  estimateVisionPeakVramBytes,
  resolveEffectiveImagePixelCeiling,
} from '@siftkit/contracts';
import { resolveImageTokenBudget, clearImageTokenBudgetCache } from '../src/llm-protocol/image-token-budget.js';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../src/config/constants.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import type { JsonValue } from '../src/lib/json-types.js';
import { INSTALLED_ENCODER } from './helpers/image-fixtures.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { makeTestPreset } from './helpers/model-presets.js';

function writePreprocessorConfig(directory: string, body: JsonValue): void {
  fs.writeFileSync(path.join(directory, 'preprocessor_config.json'), JSON.stringify(body));
}

/** Byte-for-byte the shape the installed model ships. */
const INSTALLED_MODEL_CONFIG = {
  size: { longest_edge: 16_777_216, shortest_edge: 65_536 },
  patch_size: 16,
  temporal_patch_size: 2,
  merge_size: 2,
  processor_class: 'Qwen3VLProcessor',
  image_processor_type: 'Qwen2VLImageProcessorFast',
};

test('resolveImageTokenBudget derives the ceiling from the installed model config shape', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-derived');
  writePreprocessorConfig(directory, INSTALLED_MODEL_CONFIG);
  const preset: ModelRuntimePreset = makeTestPreset({ id: 'derived', ModelPath: directory });

  const budget = resolveImageTokenBudget(preset);

  assert.equal(budget.source, 'preprocessor_config');
  assert.equal(budget.pixelsPerToken, 1024);
  // 16.8 MP would need 16_384 tokens, so the SiftKit token estimate is the binding limit.
  assert.equal(budget.maxPixels, SIFT_IMAGE_TOKEN_ESTIMATE * 1024);
  // 2.1 MP — for scale, a 1920x1080 screenshot is 2.07 MP and just fits.
  assert.equal(budget.maxPixels, 2_097_152);
});

test('resolveImageTokenBudget still reads the older flat max_pixels key', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-legacy');
  writePreprocessorConfig(directory, { patch_size: 14, merge_size: 2, max_pixels: 12_845_056 });

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'legacy', ModelPath: directory }));

  assert.equal(budget.source, 'preprocessor_config');
  assert.equal(budget.pixelsPerToken, 784);
  assert.equal(budget.maxPixels, SIFT_IMAGE_TOKEN_ESTIMATE * 784);
});

test('size.longest_edge wins over max_pixels when a config carries both', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-both');
  writePreprocessorConfig(directory, { patch_size: 16, merge_size: 2, max_pixels: 999_999, size: { longest_edge: 200_000 } });

  assert.equal(resolveImageTokenBudget(makeTestPreset({ id: 'both', ModelPath: directory })).maxPixels, 200_000);
});

test('resolveImageTokenBudget honours a configured budget lower than the SiftKit token ceiling', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-tight');
  writePreprocessorConfig(directory, { patch_size: 16, merge_size: 2, size: { longest_edge: 200_000 } });

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'tight', ModelPath: directory }));

  assert.equal(budget.maxPixels, 200_000);
});

test('resolveImageTokenBudget falls back when the file is absent, and says which', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-absent');

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'absent', ModelPath: directory }));

  assert.equal(budget.source, 'fallback');
  assert.equal(budget.pixelsPerToken, 1024);
  assert.equal(budget.maxPixels, SIFT_IMAGE_TOKEN_ESTIMATE * 1024);
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

test('resolveImageTokenBudget caches per preset id and ModelPath', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-cache');
  writePreprocessorConfig(directory, { patch_size: 16, merge_size: 2, size: { longest_edge: 200_000 } });
  const preset = makeTestPreset({ id: 'cached', ModelPath: directory });

  assert.equal(resolveImageTokenBudget(preset).maxPixels, 200_000);
  fs.rmSync(path.join(directory, 'preprocessor_config.json'));
  // Second call must not re-read the (now missing) file.
  assert.equal(resolveImageTokenBudget(preset).maxPixels, 200_000);
});

test('resolveImageTokenBudget recomputes when ModelPath changes under the same preset id', () => {
  clearImageTokenBudgetCache();
  const firstDirectory = createManagedTempDir('image-budget-cache-first');
  const secondDirectory = createManagedTempDir('image-budget-cache-second');
  writePreprocessorConfig(firstDirectory, { patch_size: 16, merge_size: 2, size: { longest_edge: 200_000 } });
  writePreprocessorConfig(secondDirectory, { patch_size: 16, merge_size: 2, size: { longest_edge: 300_000 } });

  assert.equal(resolveImageTokenBudget(makeTestPreset({ id: 'same', ModelPath: firstDirectory })).maxPixels, 200_000);
  assert.equal(resolveImageTokenBudget(makeTestPreset({ id: 'same', ModelPath: secondDirectory })).maxPixels, 300_000);
});

test('estimateVisionPeakVramBytes scales linearly with the image token count', () => {
  const small = estimateVisionPeakVramBytes(256, INSTALLED_ENCODER);
  const large = estimateVisionPeakVramBytes(2048, INSTALLED_ENCODER);

  assert.ok(small > 0);
  assert.equal(large, small * 8);
});

test('estimateVisionPeakVramBytes matches the installed model geometry', () => {
  // 4 patches x (1152 + 4304) x 2 bytes x 2.5 = 109_120 B per image token.
  assert.equal(estimateVisionPeakVramBytes(1, INSTALLED_ENCODER), 109_120);
  // A full 2048-token image is an estimated ~223 MB transient allocation.
  assert.equal(estimateVisionPeakVramBytes(2048, INSTALLED_ENCODER), 223_477_760);
});

test('the budget carries the encoder geometry read from config.json', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-encoder');
  writePreprocessorConfig(directory, INSTALLED_MODEL_CONFIG);
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    vision_config: { hidden_size: 1152, intermediate_size: 4304, spatial_merge_size: 2 },
  }));

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'encoder', ModelPath: directory }));

  assert.deepEqual(budget.encoder, INSTALLED_ENCODER);
});

test('the encoder geometry falls back when config.json is absent', () => {
  clearImageTokenBudgetCache();
  const directory = createManagedTempDir('image-budget-encoder-absent');
  writePreprocessorConfig(directory, INSTALLED_MODEL_CONFIG);

  const budget = resolveImageTokenBudget(makeTestPreset({ id: 'encoder-absent', ModelPath: directory }));

  assert.deepEqual(budget.encoder, INSTALLED_ENCODER);
});

test('resolveEffectiveImagePixelCeiling clamps to the user pixel cap', () => {
  const budget = {
    maxPixels: 2_097_152,
    pixelsPerToken: 1024,
    maxImageTokens: 2048,
    encoder: INSTALLED_ENCODER,
    source: 'preprocessor_config' as const,
  };

  assert.equal(resolveEffectiveImagePixelCeiling(budget, 1_000_000), 1_000_000);
  // 0 means no user cap.
  assert.equal(resolveEffectiveImagePixelCeiling(budget, 0), 2_097_152);
  // A cap above the model ceiling cannot raise it.
  assert.equal(resolveEffectiveImagePixelCeiling(budget, 99_000_000), 2_097_152);
});

test('estimateVisionPeakVramBytesForImagePixels uses the effective user cap', () => {
  const budget = {
    maxPixels: 2_097_152,
    pixelsPerToken: 1024,
    maxImageTokens: 2048,
    encoder: INSTALLED_ENCODER,
    source: 'preprocessor_config' as const,
  };

  assert.equal(estimateVisionPeakVramBytesForImagePixels(budget, 409_600), estimateVisionPeakVramBytes(400, INSTALLED_ENCODER));
});
