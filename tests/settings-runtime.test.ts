import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRuntimeModelId } from '../dashboard/src/settings-runtime.ts';

test('deriveRuntimeModelId returns the gguf filename from a Windows path', () => {
  assert.equal(
    deriveRuntimeModelId('D:\\personal\\models\\Qwen3.5-27B-Q4_K_M.gguf'),
    'Qwen3.5-27B-Q4_K_M.gguf',
  );
});

test('deriveRuntimeModelId returns the filename from a Unix-style path', () => {
  assert.equal(
    deriveRuntimeModelId('/models/Qwen3.5-9B-Q8_0.gguf'),
    'Qwen3.5-9B-Q8_0.gguf',
  );
});

test('deriveRuntimeModelId trims whitespace and returns empty text for empty input', () => {
  assert.equal(deriveRuntimeModelId('   C:\\models\\example.gguf   '), 'example.gguf');
  assert.equal(deriveRuntimeModelId('   '), '');
  assert.equal(deriveRuntimeModelId(null), '');
});
