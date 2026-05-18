import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveManagedLlamaPreset,
  getManagedLlamaConfig,
} from '../src/status-server/config-store.js';

function configWithPresets() {
  return {
    Server: {
      LlamaCpp: {
        ActivePresetId: 'b',
        Presets: [
          { id: 'a', label: 'A', Model: 'a.gguf', NumCtx: 1000 },
          { id: 'b', label: 'B', Model: 'b.gguf', NumCtx: 85000 },
        ],
      },
    },
  };
}

test('getActiveManagedLlamaPreset returns the preset matching ActivePresetId', () => {
  const preset = getActiveManagedLlamaPreset(configWithPresets());
  assert.equal(preset.id, 'b');
  assert.equal(preset.NumCtx, 85000);
});

test('getActiveManagedLlamaPreset falls back to the first preset', () => {
  const config = configWithPresets();
  config.Server.LlamaCpp.ActivePresetId = 'missing';
  assert.equal(getActiveManagedLlamaPreset(config).id, 'a');
});

test('getManagedLlamaConfig resolves NumCtx and Model from the active preset', () => {
  const managed = getManagedLlamaConfig(configWithPresets());
  assert.equal(managed.NumCtx, 85000);
  assert.equal(managed.Model, 'b.gguf');
});
