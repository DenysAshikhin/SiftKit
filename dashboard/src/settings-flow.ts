import type { SettingsSectionId } from './settings-sections.js';
import type { DashboardModelRuntimePreset } from './types.js';

export type DirtyContinuation =
  | { kind: 'switch-section'; nextSection: SettingsSectionId }
  | { kind: 'switch-tab'; nextTab: 'runs' | 'metrics' | 'benchmark' | 'chat' | 'assistant' | 'settings' }
  | { kind: 'reload-settings' }
  | { kind: 'restart-backend' };

export type DirtyActionKind = DirtyContinuation['kind'];

export function getDirtyActionRequirement(isDirty: boolean, action: DirtyActionKind): 'confirm' | 'continue' {
  void action;
  return isDirty ? 'confirm' : 'continue';
}

// Both managed runtimes restart through the preset coordinator; an external inference
// server is not owned by SiftKit, so there is nothing for it to restart.
export function isBackendRestartSupported(activeModelPreset: DashboardModelRuntimePreset | null): boolean {
  return activeModelPreset !== null && !activeModelPreset.ExternalServerEnabled;
}

export type ModelPresetPathField = 'ExecutablePath' | 'ModelPath';

export type SettingsPathPickerBusyTarget =
  | { kind: 'model-preset'; field: ModelPresetPathField }
  | { kind: 'preset-autoload'; presetId: string; index: number };

export function isModelPresetPickerBusy(
  busyTarget: SettingsPathPickerBusyTarget | null,
  field: ModelPresetPathField,
): boolean {
  return busyTarget?.kind === 'model-preset' && busyTarget.field === field;
}

export function isPresetAutoloadPickerBusy(
  busyTarget: SettingsPathPickerBusyTarget | null,
  presetId: string,
  index: number,
): boolean {
  return busyTarget?.kind === 'preset-autoload'
    && busyTarget.presetId === presetId
    && busyTarget.index === index;
}
