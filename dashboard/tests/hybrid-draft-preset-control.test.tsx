import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { HYBRID_DRAFT_TOKENS_LABEL } from '../src/settings-sections.ts';
import { DASHBOARD_CONFIG, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import type { DashboardModelRuntimePreset } from '../src/types.ts';

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
    modelProfileStatus: { state: 'no-path' },
  };
}

/** Hybrid drafting runs on its own, so the control stays visible while MTP speculation is off. */
test('the hybrid draft input shows the preset value with speculation off', () => {
  render(<ModelPresetsSection {...sectionProps({ SpeculativeEnabled: false, HybridDraftTokens: 5 })} />);

  assert.equal(screen.getByLabelText<HTMLInputElement>(HYBRID_DRAFT_TOKENS_LABEL).value, '5');
});

test('editing the hybrid draft input writes the preset field', () => {
  const calls: Array<[string, number]> = [];
  render(
    <ModelPresetsSection
      {...sectionProps(
        { HybridDraftTokens: 5 },
        { ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) },
      )}
    />,
  );

  fireEvent.change(screen.getByLabelText(HYBRID_DRAFT_TOKENS_LABEL), { target: { value: '8' } });

  assert.deepEqual(calls, [['HybridDraftTokens', 8]]);
});

test('the hybrid draft input is inert for external inference servers', () => {
  render(<ModelPresetsSection {...sectionProps({ ExternalServerEnabled: true })} />);

  const enclosure = screen.getByLabelText(HYBRID_DRAFT_TOKENS_LABEL).closest('fieldset');
  assert.equal(enclosure?.disabled, true);
});
