import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsTab } from '../src/tabs/SettingsTab';
import {
  ASSISTANT_ACTIONS,
  DASHBOARD_CONFIG,
  GENERAL_ACTIONS,
  INTERACTIVE_ACTIONS,
  MANAGED_PRESET,
  MODEL_PRESET_ACTIONS,
  PRESET,
  PRESET_ACTIONS,
  TOOL_POLICY_ACTIONS,
  WEB_SEARCH_ACTIONS,
} from './fixtures';

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
    requestSettingsAction: overrides.requestSettingsAction ?? (() => {}),
    generalActions: GENERAL_ACTIONS,
    toolPolicyActions: TOOL_POLICY_ACTIONS,
    presetActions: PRESET_ACTIONS,
    interactiveActions: INTERACTIVE_ACTIONS,
    webSearchActions: WEB_SEARCH_ACTIONS,
    modelPresetActions: MODEL_PRESET_ACTIONS,
    assistantActions: ASSISTANT_ACTIONS,
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
  for (const label of ['General', 'Tool Policy', 'Presets', 'Interactive', 'Web Search', 'Model Presets', 'Assistant']) {
    assert.match(markup, new RegExp(label));
  }
  assert.match(markup, /class="set-head"/);
  assert.match(markup, /Reload/);
  assert.match(markup, /Restart backend/);
  assert.match(markup, /Save settings/);
  assert.match(markup, /class="fgrid"/);
});

test('assistant section exposes configuration, proof review, and memory history views', () => {
  const markup = render({ activeSettingsSection: 'assistant' });
  assert.match(markup, /Configuration/);
  assert.match(markup, /Pending validation/);
  assert.match(markup, /Memory history/);
  assert.match(markup, /Evidence is encrypted with a local file key/);
  assert.match(markup, /Assistant enabled/);
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

test('general section renders an Expand reads toggle bound to config', () => {
  const enabled = render();
  assert.match(enabled, /Expand reads/);

  const disabledConfig = { ...DASHBOARD_CONFIG, ExpandReads: false };
  const disabled = render({ dashboardConfig: disabledConfig });
  assert.match(disabled, /Expand reads[\s\S]{0,300}class="settings-live-toggle-control"[\s\S]{0,300}><span>Disabled<\/span>/);
});

test('general section does not render global startup-context controls', () => {
  const markup = render();
  assert.doesNotMatch(markup, />AGENTS\.md</u);
  assert.doesNotMatch(markup, /Initial repo file scan/u);
});
