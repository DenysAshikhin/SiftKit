import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRuntimeModelId, syncDerivedSettingsFields } from '../dashboard/src/settings-runtime.js';
import { mockConfig } from './_runtime-helpers.js';

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

test('syncDerivedSettingsFields uses the active managed preset model when present', () => {
  const config = mockConfig({
    Runtime: { LlamaCpp: {} },
    Server: {
      ModelPresets: {
        ActivePresetId: 'preset-a',
        Presets: [
          {
            id: 'preset-a',
            label: 'Preset A',
            Model: 'Managed Model',
            BaseUrl: 'http://127.0.0.1:8080',
            ModelPath: 'D:\\models\\managed.gguf',
          },
        ],
      },
    },
  });

  syncDerivedSettingsFields(config);

  assert.equal(config.Server.ModelPresets.Presets[0].Model, 'Managed Model');
});
