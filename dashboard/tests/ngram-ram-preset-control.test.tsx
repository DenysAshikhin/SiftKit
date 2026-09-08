import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen, cleanup } from './react-test-environment.js';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.js';
import { NGRAM_RAM_LABEL } from '../src/settings-sections.js';
import { DASHBOARD_CONFIG, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.js';
import type { DashboardModelRuntimePreset } from '../src/types.js';

type ModelPresetsSectionProps = React.ComponentProps<typeof ModelPresetsSection>;

function sectionProps(
  overrides: Partial<DashboardModelRuntimePreset> = {},
  modelPresetActions: ModelPresetsSectionProps['modelPresetActions'] = MODEL_PRESET_ACTIONS,
): ModelPresetsSectionProps {
  const preset = { ...MANAGED_PRESET, Backend: 'exl3' as const, ...overrides };
  const dashboardConfig = JSON.parse(JSON.stringify(DASHBOARD_CONFIG));
  dashboardConfig.Server.ModelPresets.Presets = [preset];
  dashboardConfig.Server.ModelPresets.ActivePresetId = preset.id;
  return {
    dashboardConfig,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions,
    runtimeStatus: null,
  };
}

test('the n-gram RAM toggle reflects the preset value', () => {
  render(<ModelPresetsSection {...sectionProps({ NgramRam: false })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(NGRAM_RAM_LABEL).checked, false);

  cleanup();
  render(<ModelPresetsSection {...sectionProps({ NgramRam: true })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(NGRAM_RAM_LABEL).checked, true);
});

test('toggling the n-gram RAM control writes the preset field', () => {
  const calls: Array<[string, boolean]> = [];
  render(
    <ModelPresetsSection
      {...sectionProps(
        { NgramRam: false },
        { ...MODEL_PRESET_ACTIONS, setBoolean: (field, value) => calls.push([field, value]) },
      )}
    />,
  );

  fireEvent.click(screen.getByLabelText(NGRAM_RAM_LABEL));

  assert.deepEqual(calls, [['NgramRam', true]]);
});

/** Managed-only fields stay visible but inert: the section wraps them in a disabled fieldset. */
test('the n-gram RAM toggle is inert for external inference servers', () => {
  render(<ModelPresetsSection {...sectionProps({ ExternalServerEnabled: true })} />);

  const enclosure = screen.getByLabelText(NGRAM_RAM_LABEL).closest('fieldset');
  assert.equal(enclosure?.disabled, true);
});
