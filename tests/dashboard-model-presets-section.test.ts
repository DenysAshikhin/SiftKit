import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ModelPresetsSection } from '../dashboard/src/tabs/settings/ModelPresetsSection.js';
import type { ModelPresetSettingsActions } from '../dashboard/src/settings-action-groups.js';

interface PresetRenderOptions {
  externalServerEnabled?: boolean;
  parallelSlots?: number;
  reasoning?: 'on' | 'off';
}

const MODEL_PRESET_ACTIONS: ModelPresetSettingsActions = {
  selectPreset() {},
  setString() {},
  setNullableString() {},
  setModelPath() {},
  setInteger() {},
  setFloat() {},
  setBoolean() {},
  setIdleAction() {},
  setKvCacheQuantization() {},
  setReasoning() {},
  setReasoningEffort() {},
  setReasoningContent() {},
  addPreset() {},
  deletePreset() {},
  async pickModelPath() {},
  async testBaseUrl() {},
};

function renderPreset(options: PresetRenderOptions = {}): string {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  preset.ExternalServerEnabled = options.externalServerEnabled ?? false;
  preset.KvCacheQuantization = 'f16';
  preset.ParallelSlots = options.parallelSlots ?? 1;
  preset.Reasoning = options.reasoning ?? 'off';
  preset.SpeculativeEnabled = true;

  return renderToStaticMarkup(React.createElement(ModelPresetsSection, {
    dashboardConfig: config,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions: MODEL_PRESET_ACTIONS,
    runtimeStatus: null,
  }));
}

function findRenderedField(markup: string, label: string): string | undefined {
  return markup.split('<div class="field').find((entry) => entry.includes(`<label>${label}<`));
}

function getRenderedField(markup: string, label: string): string {
  const chunk = findRenderedField(markup, label);
  if (chunk === undefined) throw new Error(`Rendered field '${label}' is missing.`);
  return chunk;
}

function assertFieldAbsent(markup: string, label: string): void {
  assert.equal(findRenderedField(markup, label), undefined, `Rendered field '${label}' should be hidden.`);
}

test('a managed preset exposes every launch control and no backend selector', () => {
  const markup = renderPreset({ parallelSlots: 2 });

  assert.doesNotMatch(markup, /aria-label="Preset backend"/u);
  assert.doesNotMatch(markup, /aria-label="Inference backend"/u);
  assertFieldAbsent(markup, 'Executable path');
  assertFieldAbsent(markup, 'Bind host');
  assertFieldAbsent(markup, 'Port');
  assertFieldAbsent(markup, 'Speculative type');
  assert.doesNotMatch(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'CacheRam'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'CacheRecurrentRam'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'SpeculativeDynamic'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /type="checkbox" checked=""/u);
});

test('an external preset exposes chunk size but disables process-scoped controls', () => {
  const markup = renderPreset({ externalServerEnabled: true, parallelSlots: 2 });

  assert.match(getRenderedField(markup, 'ParallelSlots'), /disabled/u);
  assert.doesNotMatch(getRenderedField(markup, 'UBatchSize'), /disabled/u);
  assert.match(getRenderedField(markup, 'Enable speculative decoding'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDraftMax'), /disabled/u);
  assert.match(getRenderedField(markup, 'SpeculativeDynamic'), /disabled/u);
  assert.match(markup, /Requires SiftKit-managed TabbyAPI/u);
});

test('the KV cache control offers exactly the EXL3 cache modes', () => {
  const field = getRenderedField(renderPreset(), 'KV cache quant');

  for (const mode of ['f16', 'q8_0', 'q4_0', 'q5_0', 'q8_0/q4_0', 'q8_0/q5_0']) {
    assert.match(field, new RegExp(`<option value="${mode.replace('/', '\\/')}"`, 'u'));
  }
  assert.doesNotMatch(field, /disabled=""/u);
  assert.doesNotMatch(field, /value="bf16"|value="f32"/u);
});

test('the reasoning effort dropdown offers the three levels the template distinguishes', () => {
  const markup = renderPreset({ reasoning: 'on' });
  const field = getRenderedField(markup, 'Reasoning effort');

  assert.match(field, /<option value="low">low<\/option>/u);
  assert.match(field, /<option value="medium">medium<\/option>/u);
  assert.match(field, /<option value="xhigh" selected="">xhigh<\/option>/u);
  // 'high' collapses into 'xhigh' in the Qwen3.8 template, so it is never offered.
  assert.doesNotMatch(field, /value="high"/u);
});

test('the reasoning effort dropdown is hidden when reasoning is off', () => {
  assertFieldAbsent(renderPreset({ reasoning: 'off' }), 'Reasoning effort');
});
