import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresetsSection } from '../src/tabs/settings/PresetsSection';
import { DASHBOARD_CONFIG, CUSTOM_PRESET } from './fixtures';

test('presets section renders a master-detail library with badges and tool chips', () => {
  const markup = renderToStaticMarkup(
    <PresetsSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedSettingsPreset={CUSTOM_PRESET}
      selectedSettingsPresetId={CUSTOM_PRESET.id}
      setSelectedSettingsPresetId={() => {}}
      updateSettingsDraft={() => {}}
      updatePresetDraft={() => {}}
      onAddPreset={() => {}}
      onDeletePreset={() => {}}
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
