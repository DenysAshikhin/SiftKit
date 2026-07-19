import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveModelPreset,
  getManagedLlamaConfig,
} from '../src/status-server/config-store.js';
import { mockConfig } from './_runtime-helpers.js';
import type { SiftConfig } from '../src/config/index.js';

function configWithPresets(): SiftConfig {
  return mockConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'b',
        Presets: [
          { id: 'a', label: 'A', Model: 'a.gguf', NumCtx: 1000 },
          { id: 'b', label: 'B', Model: 'b.gguf', NumCtx: 85000 },
        ],
      },
    },
  });
}

test('getActiveModelPreset returns the preset matching ActivePresetId', () => {
  const preset = getActiveModelPreset(configWithPresets());
  assert.equal(preset.id, 'b');
  assert.equal(preset.NumCtx, 85000);
});

test('getActiveModelPreset falls back to the first preset', () => {
  const config = configWithPresets();
  config.Server.ModelPresets.ActivePresetId = 'missing';
  assert.equal(getActiveModelPreset(config).id, 'a');
});

test('getManagedLlamaConfig resolves NumCtx and Model from the active preset', () => {
  const managed = getManagedLlamaConfig(configWithPresets());
  assert.equal(managed.NumCtx, 85000);
  assert.equal(managed.Model, 'b.gguf');
});
