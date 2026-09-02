import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection';
import { DASHBOARD_CONFIG, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures';
import type { DashboardModelRuntimePreset } from '../src/types';
import type { InferenceRuntimeDashboardStatus } from '@siftkit/contracts';

type ModelPresetsSectionProps = React.ComponentProps<typeof ModelPresetsSection>;

function render(preset: DashboardModelRuntimePreset, runtimeStatus: InferenceRuntimeDashboardStatus | null = null): string {
  const config = JSON.parse(JSON.stringify(DASHBOARD_CONFIG));
  config.Server.ModelPresets.Presets = [preset];
  config.Server.ModelPresets.ActivePresetId = preset.id;
  const props: ModelPresetsSectionProps = {
    dashboardConfig: config,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions: MODEL_PRESET_ACTIONS,
    runtimeStatus,
  };
  return renderToStaticMarkup(React.createElement(ModelPresetsSection, props));
}

test('renders a toolbar with preset selector, active pill and add/delete but no backend control', () => {
  const markup = render(MANAGED_PRESET);
  assert.match(markup, /class="mp-toolbar"/);
  assert.match(markup, /class="mp-select"/);
  assert.match(markup, /class="active-pill"/);
  assert.doesNotMatch(markup, /class="segc"/);
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

test('the preset editor flags mp-body as exl3 and asks for the EXL3 model directory', () => {
  const markup = render(MANAGED_PRESET);
  assert.match(markup, /id="mp-body" class="exl3"/);
  assert.match(markup, /Model directory \(EXL3\)/);
  assert.doesNotMatch(markup, /GpuLayers|Executable path|Bind host/);
});

test('speculative sub-fields are gated by the enable toggle', () => {
  assert.doesNotMatch(render(MANAGED_PRESET), /SpeculativeDraftMax/);
  const on = render({ ...MANAGED_PRESET, SpeculativeEnabled: true });
  assert.match(on, /SpeculativeDraftMax/);
  assert.match(on, /SpeculativeDynamic/);
  assert.doesNotMatch(on, /Speculative type/);
});

test('selected preset editor does not render active runtime lifecycle controls', () => {
  const markup = render(MANAGED_PRESET);
  assert.doesNotMatch(markup, /Runtime:/u);
  assert.doesNotMatch(markup, /<button[^>]*>Load/u);
  assert.doesNotMatch(markup, /<button[^>]*>Freeze/u);
  assert.doesNotMatch(markup, /<button[^>]*>Unload/u);
});

const ACTIVE_RUNTIME_STATUS = {
  activePresetId: MANAGED_PRESET.id,
  activePresetLabel: MANAGED_PRESET.label,
  backend: 'exl3',
  idleAction: 'freeze',
  freezeSupported: true,
  processState: 'ready',
  modelState: 'ready',
  model: 'active-model',
  idleDeadlineUtc: null,
  errorPhase: null,
  error: null,
  rollback: null,
  imageTokenBudget: {
    pixelsPerToken: 1024,
    maxPixels: 2_097_152,
    maxImageTokens: 2048,
    encoder: { hiddenSize: 1152, intermediateSize: 4304, patchesPerToken: 4 },
    source: 'preprocessor_config',
  },
  gpuFreeBytes: 8 * 1_073_741_824,
} satisfies InferenceRuntimeDashboardStatus;

test('matching active EXL3 preset and model receives runtime vision metrics', () => {
  const preset = { ...MANAGED_PRESET, Backend: 'exl3', Model: 'active-model', VisionEnabled: true };
  const markup = render(preset, ACTIVE_RUNTIME_STATUS);
  assert.match(markup, /Model ceiling/u);
  assert.match(markup, /free VRAM/u);
});

test('edited or different preset does not receive another runtime model metrics', () => {
  const edited = { ...MANAGED_PRESET, Backend: 'exl3', Model: 'edited-model', VisionEnabled: true };
  const markup = render(edited, ACTIVE_RUNTIME_STATUS);
  assert.doesNotMatch(markup, /Model ceiling/u);
  assert.doesNotMatch(markup, /free VRAM/u);
});

test('a different selected preset does not receive active runtime metrics', () => {
  const different = { ...MANAGED_PRESET, id: 'different', Backend: 'exl3', Model: 'active-model', VisionEnabled: true };
  const markup = render(different, ACTIVE_RUNTIME_STATUS);
  assert.doesNotMatch(markup, /Model ceiling/u);
  assert.doesNotMatch(markup, /free VRAM/u);
});
