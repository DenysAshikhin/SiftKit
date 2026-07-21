import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ModelPresetsSection } from '../dashboard/src/tabs/settings/ModelPresetsSection.js';

interface Exl3RenderOptions {
  externalServerEnabled?: boolean;
  kvCacheQuantization?: 'bf16' | 'f16';
  parallelSlots?: number;
}

function renderExl3Preset(options: Exl3RenderOptions = {}): string {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  preset.Backend = 'exl3';
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
    updateSettingsDraft: () => {},
    updateModelPresetDraft: () => {},
    onAddModelPreset: () => {},
    onDeleteModelPreset: () => {},
    onPickModelPresetPath: async () => {},
    onTestLlamaCppBaseUrl: async () => {},
  }));
}

function getRenderedField(markup: string, label: string): string {
  const chunk = markup.split('<div class="field').find((entry) => entry.includes(`<label>${label}<`));
  if (chunk === undefined) throw new Error(`Rendered field '${label}' is missing.`);
  return chunk;
}

test('managed EXL3 enables supported runtime controls and exposes only MTP drafting', () => {
  const markup = renderExl3Preset({ parallelSlots: 2 });

  assert.match(markup, /aria-label="Preset backend"/u);
  assert.match(getRenderedField(markup, 'GpuLayers'), /disabled/u);
  assert.match(getRenderedField(markup, 'Bind host'), /disabled/u);
  assert.match(getRenderedField(markup, 'Port'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.match(markup, /<option value="draft-mtp" selected="">draft-mtp<\/option>/u);
  assert.doesNotMatch(markup, /<option value="ngram-map-k">/u);
  assert.doesNotMatch(markup, /MTP speculative decoding does not support parallel slots/u);
  assert.match(markup, /Not supported by EXL3/u);
  assert.doesNotMatch(markup, /aria-label="Inference backend"/u);
});

test('external EXL3 exposes chunk size but disables process-scoped controls', () => {
  const markup = renderExl3Preset({ externalServerEnabled: true, parallelSlots: 2 });

  assert.match(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.match(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.match(markup, /Requires SiftKit-managed TabbyAPI/u);
});

test('EXL3 enum controls disable incompatible values without changing the preset', () => {
  const markup = renderExl3Preset({ kvCacheQuantization: 'bf16' });

  assert.match(markup, /<option value="bf16"[^>]*disabled=""[^>]*>bf16<\/option>/u);
  assert.match(markup, /<select[^>]*><option value="f32" disabled="">/u);
});
