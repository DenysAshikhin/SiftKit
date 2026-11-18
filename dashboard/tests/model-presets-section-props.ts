import type { InferenceRuntimeDashboardStatus } from '@siftkit/contracts';
import type { ModelPresetsSectionProps } from '../src/tabs/settings/ModelPresetsSection.tsx';
import type { DashboardModelRuntimePreset } from '../src/types.ts';
import type { ModelPresetSettingsActions } from '../src/settings-action-groups.ts';
import type { ModelProfileStatus } from '../src/settings-flow.ts';
import { DASHBOARD_CONFIG, MODEL_PRESET_ACTIONS } from './fixtures.ts';

/** ModelPresetsSection props with `preset` as the only, active model preset. */
export function modelPresetsSectionProps(
  preset: DashboardModelRuntimePreset,
  modelPresetActions: ModelPresetSettingsActions = MODEL_PRESET_ACTIONS,
  runtimeStatus: InferenceRuntimeDashboardStatus | null = null,
  modelProfileStatus: ModelProfileStatus = { state: 'no-path' },
): ModelPresetsSectionProps {
  return {
    dashboardConfig: { ...DASHBOARD_CONFIG, Server: { ...DASHBOARD_CONFIG.Server, ModelPresets: { Presets: [preset], ActivePresetId: preset.id } } },
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions,
    runtimeStatus,
    modelProfileStatus,
  };
}
