import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresetsSection } from '../src/tabs/settings/PresetsSection';
import type { SettingsPathPickerBusyTarget } from '../src/settings-flow';
import type { DashboardPreset } from '../src/types';
import { DASHBOARD_CONFIG, CUSTOM_PRESET, PRESET_ACTIONS } from './fixtures';

const AUTOLOAD_PRESET: DashboardPreset = {
  ...CUSTOM_PRESET,
  operationMode: 'summary',
  autoloadFiles: ['C:\\shared\\rules.md', 'C:\\shared\\AGENTS.md'],
};

function renderAutoloadPreset(
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null,
  settingsActionBusy = false,
): string {
  return renderToStaticMarkup(
    <PresetsSection
      dashboardConfig={{ ...DASHBOARD_CONFIG, Presets: [AUTOLOAD_PRESET] }}
      selectedSettingsPreset={AUTOLOAD_PRESET}
      selectedSettingsPresetId={AUTOLOAD_PRESET.id}
      settingsActionBusy={settingsActionBusy}
      settingsPathPickerBusyTarget={settingsPathPickerBusyTarget}
      presetActions={PRESET_ACTIONS}
    />,
  );
}

test('presets section renders a master-detail library with badges and tool chips', () => {
  const markup = renderToStaticMarkup(
    <PresetsSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedSettingsPreset={CUSTOM_PRESET}
      selectedSettingsPresetId={CUSTOM_PRESET.id}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      presetActions={PRESET_ACTIONS}
    />,
  );

  assert.match(markup, /class="plib"/);
  assert.match(markup, /class="plist"/);
  assert.match(markup, /class="pcard"/);
  assert.match(markup, /class="prow sel"/);
  assert.match(markup, /class="bdg custom"/);
  assert.match(markup, /\+ Add preset/);
  assert.match(markup, /Preset kind/);
  assert.match(markup, /Operation mode/);
  assert.match(markup, /class="tchip on"[^>]*>read_lines/);
  assert.match(markup, /class="tchip blocked"/);
});

test('preset editor shows startup context for summary presets', () => {
  const markup = renderAutoloadPreset(null);

  assert.match(markup, /Load AGENTS\.md/u);
  assert.match(markup, /Load repository file list/u);
  assert.match(markup, /Autoload files/u);
  assert.match(markup, /C:\\shared\\rules\.md/u);
  assert.match(markup, /\+ Add file/u);
  assert.match(markup, /Remove/u);
});

test('each autoload row offers a browse button so paths need not be typed', () => {
  const markup = renderAutoloadPreset(null);

  assert.equal(markup.match(/Browse…/gu)?.length, AUTOLOAD_PRESET.autoloadFiles.length);
  assert.doesNotMatch(markup, /Opening…/u);
});

test('only the autoload row whose picker is open shows the opening label', () => {
  const markup = renderAutoloadPreset({ kind: 'preset-autoload', presetId: AUTOLOAD_PRESET.id, index: 1 });

  assert.equal(markup.match(/Opening…/gu)?.length, 1);
  assert.equal(markup.match(/Browse…/gu)?.length, 1);
});

test('a picker busy on the model preset section leaves autoload rows idle', () => {
  const markup = renderAutoloadPreset({ kind: 'model-preset' });

  assert.doesNotMatch(markup, /Opening…/u);
  assert.equal(markup.match(/Browse…/gu)?.length, AUTOLOAD_PRESET.autoloadFiles.length);
});

test('autoload browse buttons are disabled while a settings action is in flight', () => {
  const markup = renderAutoloadPreset(null, true);

  assert.match(markup, /Browse…/u);
  assert.match(markup, /disabled=""/u);
});
