import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { PresetsSection } from '../dashboard/src/tabs/settings/PresetsSection.js';
import type { PresetSettingsActions } from '../dashboard/src/settings-action-groups.js';
import type { SettingsPathPickerBusyTarget } from '../dashboard/src/settings-flow.js';

const PRESET_ACTIONS: PresetSettingsActions = {
  selectPreset() {},
  setString() {},
  setKind() {},
  setOperationMode() {},
  setToolEnabled() {},
  setSurfaceEnabled() {},
  setAgentsMdEnabled() {},
  setRepoFileListingEnabled() {},
  setAssistantMemoryEnabled() {},
  setAutoloadFile() {},
  async pickAutoloadFile() {},
  addAutoloadFile() {},
  removeAutoloadFile() {},
  setSummaryDefault() {},
  addPreset() {},
  deletePreset() {},
};

const AUTOLOAD_FILES = ['C:\\shared\\rules.md', 'C:\\shared\\AGENTS.md'];

function renderAutoloadPreset(
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null,
  settingsActionBusy = false,
): string {
  const config = getDefaultConfigObject();
  const preset = config.Presets[0];
  if (!preset) throw new Error('Default config must include a preset.');
  preset.autoloadFiles = [...AUTOLOAD_FILES];

  return renderToStaticMarkup(React.createElement(PresetsSection, {
    dashboardConfig: config,
    selectedSettingsPreset: preset,
    selectedSettingsPresetId: preset.id,
    settingsActionBusy,
    settingsPathPickerBusyTarget,
    presetActions: PRESET_ACTIONS,
  }));
}

test('every autoload row offers a browse button so paths need not be typed', () => {
  const markup = renderAutoloadPreset(null);

  assert.match(markup, /Autoload files/u);
  assert.match(markup, /C:\\shared\\AGENTS\.md/u);
  assert.equal(markup.match(/Browse…/gu)?.length, AUTOLOAD_FILES.length);
  assert.doesNotMatch(markup, /Opening…/u);
});

test('only the autoload row whose picker is open shows the opening label', () => {
  const config = getDefaultConfigObject();
  const presetId = config.Presets[0]?.id;
  assert.ok(presetId);
  const markup = renderAutoloadPreset({ kind: 'preset-autoload', presetId, index: 1 });

  assert.equal(markup.match(/Opening…/gu)?.length, 1);
  assert.equal(markup.match(/Browse…/gu)?.length, AUTOLOAD_FILES.length - 1);
});

test('a model preset picker in flight leaves autoload rows idle', () => {
  const markup = renderAutoloadPreset({ kind: 'model-preset' });

  assert.doesNotMatch(markup, /Opening…/u);
  assert.equal(markup.match(/Browse…/gu)?.length, AUTOLOAD_FILES.length);
});

test('autoload browse buttons are disabled while a settings action is in flight', () => {
  const idle = renderAutoloadPreset(null);
  const busy = renderAutoloadPreset(null, true);

  assert.doesNotMatch(idle, /disabled=""[^>]*>Browse…/u);
  assert.match(busy, /disabled=""[^>]*>Browse…/u);
});
