import type { ModelProfile } from '@siftkit/contracts';
import type { SettingsSectionId } from './settings-sections.ts';
import type { DashboardModelRuntimePreset } from './types.ts';

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

/** Identification of the selected preset's model directory. */
export type ModelProfileStatus =
  | { state: 'no-path' }
  | { state: 'identifying' }
  | { state: 'identified'; presetId: string; profile: ModelProfile }
  | { state: 'unidentified'; error: string };

export function getIdentifiedProfile(status: ModelProfileStatus): ModelProfile | null {
  return status.state === 'identified' ? status.profile : null;
}

export type SettingsPathPickerBusyTarget =
  | { kind: 'model-preset' }
  | { kind: 'preset-autoload'; presetId: string; index: number };

export function isModelPresetPickerBusy(busyTarget: SettingsPathPickerBusyTarget | null): boolean {
  return busyTarget?.kind === 'model-preset';
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
