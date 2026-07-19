import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ModelPresetsSection } from '../dashboard/src/tabs/settings/ModelPresetsSection.js';

function renderExl3Preset(kvCacheQuantization: 'bf16' | 'f16' = 'f16'): string {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  preset.Backend = 'exl3';
  preset.KvCacheQuantization = kvCacheQuantization;
  preset.SpeculativeEnabled = true;
  preset.SpeculativeType = 'draft-mtp';

  return renderToStaticMarkup(React.createElement(ModelPresetsSection, {
    dashboardConfig: config,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, label, children) => React.createElement('div', { 'data-label': label }, children),
    updateSettingsDraft: () => {},
    updateModelPresetDraft: () => {},
    onAddModelPreset: () => {},
    onDeleteModelPreset: () => {},
    onPickModelPresetPath: async () => {},
    onTestLlamaCppBaseUrl: async () => {},
  }));
}

test('EXL3 preset keeps unsupported controls visible and disabled', () => {
  const markup = renderExl3Preset();

  assert.match(markup, /aria-label="Preset backend"/u);
  assert.match(markup, /data-label="GpuLayers"[\s\S]*?disabled/u);
  assert.match(markup, /data-label="ParallelSlots"[\s\S]*?disabled/u);
  assert.match(markup, /data-label="Bind host"[\s\S]*?disabled/u);
  assert.match(markup, /data-label="Port"[\s\S]*?disabled/u);
  assert.match(markup, /data-label="Enable speculative decoding"[\s\S]*?disabled/u);
  assert.match(markup, /data-label="SpeculativeDraftMax"[\s\S]*?disabled/u);
  assert.match(markup, /Not supported by EXL3/u);
  assert.doesNotMatch(markup, /aria-label="Inference backend"/u);
});

test('EXL3 enum controls disable incompatible values without changing the preset', () => {
  const markup = renderExl3Preset('bf16');

  assert.match(markup, /<option value="bf16"[^>]*disabled=""[^>]*>bf16<\/option>/u);
  assert.match(markup, /<select[^>]*><option value="f32" disabled="">/u);
});
