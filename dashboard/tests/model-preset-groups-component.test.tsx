import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection';
import { DASHBOARD_CONFIG, MANAGED_PRESET } from './fixtures';
import type { DashboardModelRuntimePreset } from '../src/types';

type ModelPresetsSectionProps = React.ComponentProps<typeof ModelPresetsSection>;

function render(preset: DashboardModelRuntimePreset): string {
  const config = JSON.parse(JSON.stringify(DASHBOARD_CONFIG));
  config.Server.ModelPresets.Presets = [preset];
  config.Server.ModelPresets.ActivePresetId = preset.id;
  const props: ModelPresetsSectionProps = {
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
  };
  return renderToStaticMarkup(React.createElement(ModelPresetsSection, props));
}

test('renders a toolbar with preset selector, active pill, add/delete and a backend segmented control', () => {
  const markup = render(MANAGED_PRESET);
  assert.match(markup, /class="mp-toolbar"/);
  assert.match(markup, /class="mp-select"/);
  assert.match(markup, /class="active-pill"/);
  assert.match(markup, /class="segc"/);
  assert.match(markup, /llama\.cpp/);
  assert.match(markup, />Add</);
  assert.match(markup, />Delete</);
});

test('renders six collapsible groups with Identity open by default and a live summary', () => {
  const markup = render(MANAGED_PRESET);
  const groupCount = markup.match(/class="mpg"/g)?.length ?? 0;
  assert.equal(groupCount, 6);
  assert.match(markup, /<details class="mpg" open=""><summary><span class="chev">/);
  assert.match(markup, /class="gsum"/);
});

test('llama backend shows the gguf model path and be-l fields', () => {
  const markup = render(MANAGED_PRESET);
  assert.match(markup, /Model path \(\.gguf\)/);
  assert.match(markup, /GpuLayers/);
  assert.match(markup, /class="field be-l"/);
  assert.doesNotMatch(markup, /id="mp-body" class="exl3"/);
});

test('exl3 backend flags mp-body and switches the model field to the EXL3 directory', () => {
  const markup = render({ ...MANAGED_PRESET, Backend: 'exl3', SpeculativeType: 'draft-mtp' });
  assert.match(markup, /id="mp-body" class="exl3"/);
  assert.match(markup, /Model directory \(EXL3\)/);
});

test('speculative sub-fields are gated by the enable toggle', () => {
  assert.doesNotMatch(render(MANAGED_PRESET), /Speculative type/);
  const on = render({ ...MANAGED_PRESET, SpeculativeEnabled: true, SpeculativeType: 'ngram-map-k' });
  assert.match(on, /Speculative type/);
  assert.match(on, /SpeculativeNgramSizeN/);
});
