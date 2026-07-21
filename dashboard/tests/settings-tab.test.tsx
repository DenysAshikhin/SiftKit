import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsTab } from '../src/tabs/SettingsTab';
import { DASHBOARD_CONFIG, PRESET, MANAGED_PRESET } from './fixtures';

type SettingsTabProps = React.ComponentProps<typeof SettingsTab>;

function render(overrides: Partial<SettingsTabProps> = {}): string {
  const props: SettingsTabProps = {
    activeSettingsSection: overrides.activeSettingsSection ?? 'general',
    dashboardConfig: overrides.dashboardConfig ?? DASHBOARD_CONFIG,
    selectedSettingsPreset: overrides.selectedSettingsPreset ?? PRESET,
    selectedModelPreset: overrides.selectedModelPreset ?? MANAGED_PRESET,
    selectedSettingsPresetId: overrides.selectedSettingsPresetId ?? PRESET.id,
    webSearchUsage: overrides.webSearchUsage ?? { currentMonth: '2026-07', currentMonthCount: 3, allTimeCount: 20 },
    webSearchQuota: overrides.webSearchQuota ?? [{ provider: 'tavily', used: 8, limit: 100, remaining: 92 }],
    settingsLoading: false,
    settingsError: null,
    settingsDirty: overrides.settingsDirty ?? false,
    settingsSavedAtUtc: null,
    settingsActionBusy: false,
    settingsRestartSupported: true,
    settingsSaving: false,
    settingsRestarting: false,
    settingsPathPickerBusyTarget: null,
    setSelectedSettingsPresetId: () => {},
    requestSettingsAction: overrides.requestSettingsAction ?? (() => {}),
    updateSettingsDraft: () => {},
    updatePresetDraft: () => {},
    updateModelPresetDraft: () => {},
    onAddPreset: () => {},
    onDeletePreset: () => {},
    onAddModelPreset: () => {},
    onDeleteModelPreset: () => {},
    onPickModelPresetPath: async () => {},
    onTestLlamaCppBaseUrl: async () => {},
    onReloadDashboardSettings: async () => {},
    restartDashboardBackendCore: async () => true,
    onSaveDashboardSettings: async () => {},
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(SettingsTab, props));
}

test('settings shell renders a section nav, head actions, and a field grid', () => {
  const markup = render();
  assert.match(markup, /class="set-nav"/);
  for (const label of ['General', 'Tool Policy', 'Presets', 'Interactive', 'Web Search', 'Model Presets']) {
    assert.match(markup, new RegExp(label));
  }
  assert.match(markup, /class="set-head"/);
  assert.match(markup, /Reload/);
  assert.match(markup, /Restart backend/);
  assert.match(markup, /Save settings/);
  assert.match(markup, /class="fgrid"/);
});

test('dirty state shows an unsaved pill', () => {
  assert.doesNotMatch(render({ settingsDirty: false }), /class="dirty-pill"/);
  const dirty = render({ settingsDirty: true });
  assert.match(dirty, /class="dirty-pill"/);
  assert.match(dirty, /[Uu]nsaved/);
});

test('web search section masks provider keys with a show toggle and shows usage', () => {
  const markup = render({ activeSettingsSection: 'web-search' });
  assert.match(markup, /type="password"/);
  assert.match(markup, /Show/);
  assert.match(markup, /this month/);
});
