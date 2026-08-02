import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ModelPresetsSection } from '../dashboard/src/tabs/settings/ModelPresetsSection.js';
import type { ModelPresetSettingsActions } from '../dashboard/src/settings-action-groups.js';

interface PresetRenderOptions {
  backend?: 'llama' | 'exl3';
  externalServerEnabled?: boolean;
  kvCacheQuantization?: 'bf16' | 'f16';
  parallelSlots?: number;
}

const MODEL_PRESET_ACTIONS: ModelPresetSettingsActions = {
  selectPreset() {},
  setString() {},
  setNullableString() {},
  setModelPath() {},
  setInteger() {},
  setFloat() {},
  setBoolean() {},
  setBackend() {},
  setKvCacheQuantization() {},
  setReasoning() {},
  setReasoningContent() {},
  setSpeculativeType() {},
  addPreset() {},
  deletePreset() {},
  async pickPath() {},
  async testBaseUrl() {},
};

function renderPreset(options: PresetRenderOptions = {}): string {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  preset.Backend = options.backend ?? 'exl3';
  preset.ExternalServerEnabled = options.externalServerEnabled ?? false;
  preset.KvCacheQuantization = options.kvCacheQuantization ?? 'f16';
  preset.ParallelSlots = options.parallelSlots ?? 1;
  preset.SpeculativeEnabled = true;
  preset.SpeculativeType = 'draft-mtp';

  return renderToStaticMarkup(React.createElement(ModelPresetsSection, {
    dashboardConfig: config,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions: MODEL_PRESET_ACTIONS,
  }));
}

function getRenderedField(markup: string, label: string): string {
  const chunk = markup.split('<div class="field').find((entry) => entry.includes(`<label>${label}<`));
  if (chunk === undefined) throw new Error(`Rendered field '${label}' is missing.`);
  return chunk;
}

test('managed EXL3 enables supported runtime controls and exposes only MTP drafting', () => {
  const markup = renderPreset({ parallelSlots: 2 });

  assert.match(markup, /aria-label="Preset backend"/u);
  assert.match(getRenderedField(markup, 'GpuLayers'), /disabled/u);
  assert.match(getRenderedField(markup, 'Bind host'), /disabled/u);
  assert.match(getRenderedField(markup, 'Port'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDynamic'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /type="checkbox" checked=""/u);
  assert.match(markup, /<option value="draft-mtp" selected="">draft-mtp<\/option>/u);
  assert.doesNotMatch(markup, /<option value="ngram-map-k">/u);
  assert.doesNotMatch(markup, /MTP speculative decoding does not support parallel slots/u);
  assert.match(markup, /Not supported by EXL3/u);
  assert.doesNotMatch(markup, /aria-label="Inference backend"/u);
});

test('external EXL3 exposes chunk size but disables process-scoped controls', () => {
  const markup = renderPreset({ externalServerEnabled: true, parallelSlots: 2 });

  assert.match(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.match(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /disabled/u);
  assert.match(markup, /Requires SiftKit-managed TabbyAPI/u);
});

test('llama disables SpeculativeDynamic because llama.cpp has no dynamic draft window', () => {
  const markup = renderPreset({ backend: 'llama' });

  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /Not supported by llama\.cpp/u);
});

test('EXL3 enum controls disable incompatible values without changing the preset', () => {
  const markup = renderPreset({ kvCacheQuantization: 'bf16' });

  assert.match(markup, /<option value="bf16"[^>]*disabled=""[^>]*>bf16<\/option>/u);
  assert.match(markup, /<select[^>]*><option value="f32" disabled="">/u);
});
