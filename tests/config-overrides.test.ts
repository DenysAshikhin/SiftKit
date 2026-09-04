import assert from 'node:assert/strict';
import test from 'node:test';

import { applyModelOverrideToConfig, overlayActivePreset } from '../src/config/overrides.js';
import {
  getActiveModelPreset,
  getConfiguredEngineNumCtx,
  getConfiguredModel,
  getConfiguredReasoning,
} from '../src/config/index.js';
import { mockSiftConfig } from './helpers/mock-config.js';

function buildConfig() {
  return mockSiftConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [
          { id: 'active', label: 'active', Model: 'preset-model', IdleAction: 'unload' },
          { id: 'other', label: 'other', Model: 'other-model', IdleAction: 'unload' },
        ],
      },
    },
  });
}

test('applyModelOverrideToConfig overlays the model onto the active preset only', () => {
  const config = applyModelOverrideToConfig(buildConfig(), 'override-model');

  assert.equal(getActiveModelPreset(config).Model, 'override-model');
  assert.equal(getConfiguredModel(config), 'override-model');
  assert.equal(config.Server.ModelPresets.Presets[1]?.Model, 'other-model');
});

test('applyModelOverrideToConfig trims the override and ignores blank values', () => {
  const config = buildConfig();

  assert.equal(getActiveModelPreset(applyModelOverrideToConfig(config, '  spaced  ')).Model, 'spaced');
  assert.equal(applyModelOverrideToConfig(config, undefined), config);
  assert.equal(applyModelOverrideToConfig(config, '   '), config);
  assert.equal(applyModelOverrideToConfig(config, null), config);
});


// The getters read the active preset, so an overlay must land on that preset.
test('overlayActivePreset writes NumCtx and Reasoning onto the active preset', () => {
  const config = mockSiftConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [{ id: 'active', label: 'active', Model: 'preset-model', NumCtx: 8000, Reasoning: 'off', IdleAction: 'unload' }],
      },
    },
  });

  const overlaid = overlayActivePreset(config, { NumCtx: 200_000, Reasoning: 'on' });

  assert.equal(getConfiguredEngineNumCtx(overlaid), 200_000);
  assert.equal(getConfiguredReasoning(overlaid), 'on');
  assert.equal(getActiveModelPreset(overlaid).NumCtx, 200_000);
  assert.equal(getActiveModelPreset(overlaid).Reasoning, 'on');
});

test('overlayActivePreset leaves preset fields it does not overlay untouched', () => {
  const config = mockSiftConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [{ id: 'active', label: 'active', Model: 'preset-model', BaseUrl: 'http://127.0.0.1:9999', NumCtx: 8000, Reasoning: 'off', IdleAction: 'unload' }],
      },
    },
  });

  const overlaid = overlayActivePreset(config, { Model: 'override-model' });

  assert.equal(getActiveModelPreset(overlaid).BaseUrl, 'http://127.0.0.1:9999');
  assert.equal(getActiveModelPreset(overlaid).NumCtx, 8000);
  assert.equal(getActiveModelPreset(overlaid).Reasoning, 'off');
});

test('overlays follow the active preset id rather than the first preset', () => {
  const config = mockSiftConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'other',
        Presets: [
          { id: 'active', label: 'active', Model: 'preset-model', IdleAction: 'unload' },
          { id: 'other', label: 'other', Model: 'other-model', IdleAction: 'unload' },
        ],
      },
    },
  });
  const overlaid = applyModelOverrideToConfig(config, 'override-model');

  assert.equal(getActiveModelPreset(overlaid).Model, 'override-model');
  assert.equal(overlaid.Server.ModelPresets.Presets[0]?.Model, 'preset-model');
});
