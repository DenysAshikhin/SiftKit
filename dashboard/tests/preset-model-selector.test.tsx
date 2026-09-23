import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PresetsSection } from '../src/tabs/settings/PresetsSection';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection';
import type { PresetSettingsActions } from '../src/settings-action-groups';
import { fireEvent, render, screen } from './react-test-environment.js';
import {
  CUSTOM_PRESET,
  MANAGED_PRESET,
  MODEL_PRESET_ACTIONS,
  ORCHESTRATOR_PRESET,
  PRESET_ACTIONS,
  SECOND_MODEL_PRESET,
  TWO_MODEL_DASHBOARD_CONFIG,
} from './fixtures';

test('the preset editor assigns a model preset and clears it back to the current model', () => {
  const calls: Array<[string, string | null]> = [];
  const actions: PresetSettingsActions = {
    ...PRESET_ACTIONS,
    setModelPreset(presetId, value) { calls.push([presetId, value]); },
  };
  render(
    <PresetsSection
      dashboardConfig={TWO_MODEL_DASHBOARD_CONFIG}
      selectedSettingsPreset={{ ...CUSTOM_PRESET, modelPresetId: MANAGED_PRESET.id }}
      selectedSettingsPresetId={CUSTOM_PRESET.id}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      presetActions={actions}
    />,
  );

  screen.getByText('Model preset');
  const select = screen.getByRole('combobox', { name: 'Operation model preset' });
  assert.ok(select instanceof window.HTMLSelectElement);
  assert.equal(select.value, MANAGED_PRESET.id);
  assert.deepEqual([...select.options].map((option) => [option.value, option.text]),
    [['', 'Current model'], [MANAGED_PRESET.id, MANAGED_PRESET.label], [SECOND_MODEL_PRESET.id, SECOND_MODEL_PRESET.label]]);

  fireEvent.change(select, { target: { value: SECOND_MODEL_PRESET.id } });
  fireEvent.change(select, { target: { value: '' } });

  assert.deepEqual(calls, [[CUSTOM_PRESET.id, SECOND_MODEL_PRESET.id], [CUSTOM_PRESET.id, null]]);
});

test('a model preset still assigned to an operation cannot be deleted and names the assignments', () => {
  const config = {
    ...TWO_MODEL_DASHBOARD_CONFIG,
    Presets: TWO_MODEL_DASHBOARD_CONFIG.Presets.map((preset) => (
      preset.id === CUSTOM_PRESET.id ? { ...preset, modelPresetId: SECOND_MODEL_PRESET.id } : preset
    )),
    Server: {
      ...TWO_MODEL_DASHBOARD_CONFIG.Server,
      ModelPresets: { ...TWO_MODEL_DASHBOARD_CONFIG.Server.ModelPresets, ActivePresetId: SECOND_MODEL_PRESET.id },
    },
  };
  render(
    <ModelPresetsSection
      dashboardConfig={config}
      selectedModelPreset={SECOND_MODEL_PRESET}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      modelPresetActions={MODEL_PRESET_ACTIONS}
      runtimeStatus={null}
    />,
  );

  const deleteButton = screen.getByRole('button', { name: 'Delete' });
  assert.ok(deleteButton instanceof window.HTMLButtonElement);
  assert.equal(deleteButton.disabled, true);
  screen.getByText('Assigned to Deep Dive; reassign before deleting.');
});

test('an orchestrator preset edits its subagent cap and ignores values below one', () => {
  const calls: Array<[string, number]> = [];
  const actions: PresetSettingsActions = {
    ...PRESET_ACTIONS,
    setMaxSubagents(presetId, value) { calls.push([presetId, value]); },
  };
  render(
    <PresetsSection
      dashboardConfig={TWO_MODEL_DASHBOARD_CONFIG}
      selectedSettingsPreset={ORCHESTRATOR_PRESET}
      selectedSettingsPresetId={ORCHESTRATOR_PRESET.id}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      presetActions={actions}
    />,
  );

  const input = screen.getByRole('spinbutton', { name: 'Maximum concurrent subagents' });
  assert.ok(input instanceof window.HTMLInputElement);
  assert.equal(input.value, '1');
  fireEvent.change(input, { target: { value: '3' } });
  fireEvent.change(input, { target: { value: '0' } });
  assert.deepEqual(calls, [[ORCHESTRATOR_PRESET.id, 3]]);
});

test('non-orchestrator presets show no subagent cap', () => {
  render(
    <PresetsSection
      dashboardConfig={TWO_MODEL_DASHBOARD_CONFIG}
      selectedSettingsPreset={CUSTOM_PRESET}
      selectedSettingsPresetId={CUSTOM_PRESET.id}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      presetActions={PRESET_ACTIONS}
    />,
  );
  assert.equal(screen.queryByRole('spinbutton', { name: 'Maximum concurrent subagents' }), null);
});
