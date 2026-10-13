import assert from 'node:assert/strict';
import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../../src/config/defaults.ts';
import { PROMPT_COMPACTION_RESERVE_TOKENS } from '../../src/lib/context-token-budget.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import type { ModelPresetSettingsActions } from '../src/settings-action-groups.ts';
import type { DashboardModelRuntimePreset } from '../src/types.ts';
import { cleanup, fireEvent, render } from './react-test-environment.ts';

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

const DISK_CACHE_LABELS = ['Disk cache directory', 'Disk cache size (MiB)', 'Disk checkpoint spacing'] as const;

function renderLivePreset(overrides: Partial<DashboardModelRuntimePreset>, actions: ModelPresetSettingsActions): HTMLElement {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  Object.assign(preset, { ExternalServerEnabled: false }, overrides);
  return render(React.createElement(ModelPresetsSection, {
    dashboardConfig: config,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions: actions,
    runtimeStatus: null,
  })).container;
}

function getFieldInput(container: HTMLElement, label: string): HTMLInputElement {
  const fieldLabel = [...container.querySelectorAll('label')].find((entry) => entry.firstChild?.textContent === label);
  const input = fieldLabel?.parentElement?.querySelector('input');
  if (!input) throw new Error(`Input for '${label}' is missing.`);
  return input;
}

test('the memory group exposes the disk-cache controls for a managed preset', () => {
  const markup = renderPreset();

  for (const label of DISK_CACHE_LABELS) {
    assert.doesNotMatch(getRenderedField(markup, label), /disabled/u);
  }
  assert.match(getRenderedField(markup, 'Disk cache size (MiB)'), /value="51200"/u);
  assert.match(getRenderedField(markup, 'Disk checkpoint spacing'), /value="2048"/u);
});

test('the disk-cache controls are disabled for an external preset', () => {
  const markup = renderPreset({ externalServerEnabled: true });

  for (const label of DISK_CACHE_LABELS) {
    const field = getRenderedField(markup, label);
    assert.match(field, /disabled/u);
    assert.match(field, /Requires SiftKit-managed TabbyAPI/u);
  }
});

test('editing the disk-cache directory stores the path and an empty value as null', () => {
  const calls: Array<[string, string | null]> = [];
  const actions = { ...MODEL_PRESET_ACTIONS, setNullableString: (field: string, value: string | null) => { calls.push([field, value]); } };

  fireEvent.change(getFieldInput(renderLivePreset({ DiskCacheDir: null }, actions), 'Disk cache directory'), {
    target: { value: 'D:\\AI\\exl3-disk-cache' },
  });
  cleanup();
  fireEvent.change(getFieldInput(renderLivePreset({ DiskCacheDir: 'D:\\AI\\exl3-disk-cache' }, actions), 'Disk cache directory'), {
    target: { value: '  ' },
  });
  cleanup();
  fireEvent.change(getFieldInput(renderLivePreset({ DiskCacheDir: null }, actions), 'Disk cache directory'), {
    target: { value: 'D:\\AI Cache ' },
  });

  assert.deepEqual(calls, [['DiskCacheDir', 'D:\\AI\\exl3-disk-cache'], ['DiskCacheDir', null], ['DiskCacheDir', 'D:\\AI Cache ']]);
});

test('editing the disk-cache size and checkpoint spacing writes the integer fields', () => {
  const calls: Array<[string, number]> = [];
  const actions = { ...MODEL_PRESET_ACTIONS, setInteger: (field: string, value: number) => { calls.push([field, value]); } };
  const container = renderLivePreset({}, actions);

  fireEvent.change(getFieldInput(container, 'Disk cache size (MiB)'), { target: { value: '1024' } });
  fireEvent.change(getFieldInput(container, 'Disk checkpoint spacing'), { target: { value: '1024' } });

  assert.deepEqual(calls, [['DiskCacheSizeMiB', 1024], ['DiskCacheCheckpointInterval', 1024]]);
});

test('the memory group exposes the per-preset compaction reserve', () => {
  const field = getRenderedField(renderPreset(), 'Compaction reserve');

  assert.match(field, /type="number"/u);
  assert.match(field, new RegExp(`value="${PROMPT_COMPACTION_RESERVE_TOKENS}"`, 'u'));
});
