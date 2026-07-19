import type { DashboardConfig, DashboardModelRuntimePreset } from './types.js';

function createPresetIdFromLabel(label: string): string {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'preset';
}

function getUniqueModelPresetId(
  presets: DashboardModelRuntimePreset[],
  label: string,
): string {
  const baseId = createPresetIdFromLabel(label);
  if (!presets.some((preset) => preset.id === baseId)) {
    return baseId;
  }
  let counter = 2;
  while (presets.some((preset) => preset.id === `${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

export function getActiveModelPreset(config: DashboardConfig): DashboardModelRuntimePreset {
  const presets = config.Server.ModelPresets.Presets;
  const activePreset = presets.find((preset) => preset.id === config.Server.ModelPresets.ActivePresetId)
    ?? presets[0];
  if (!activePreset) {
    throw new Error('Model preset list is empty.');
  }
  config.Server.ModelPresets.ActivePresetId = activePreset.id;
  return activePreset;
}

export function applyModelPresetSelection(config: DashboardConfig, presetId: string): void {
  const preset = config.Server.ModelPresets.Presets.find((entry) => entry.id === presetId);
  if (!preset) {
    return;
  }
  config.Server.ModelPresets.ActivePresetId = preset.id;
}

export function updateActiveModelPreset(
  config: DashboardConfig,
  updater: (preset: DashboardModelRuntimePreset) => void,
): void {
  updater(getActiveModelPreset(config));
}

export function addModelPreset(config: DashboardConfig): string {
  const presets = config.Server.ModelPresets.Presets;
  const activePreset = getActiveModelPreset(config);
  const nextId = getUniqueModelPresetId(presets, activePreset.label);
  presets.push({ ...activePreset, id: nextId, label: activePreset.label });
  config.Server.ModelPresets.ActivePresetId = nextId;
  return nextId;
}

export function deleteModelPreset(config: DashboardConfig, presetId: string): void {
  const presets = config.Server.ModelPresets.Presets;
  if (presets.length <= 1) {
    return;
  }
  const remaining = presets.filter((preset) => preset.id !== presetId);
  config.Server.ModelPresets.Presets = remaining;
  const nextPreset = remaining.find((preset) => preset.id === config.Server.ModelPresets.ActivePresetId)
    ?? remaining[0];
  if (!nextPreset) {
    throw new Error('Model preset list is empty.');
  }
  config.Server.ModelPresets.ActivePresetId = nextPreset.id;
}

export type { DashboardModelRuntimePreset };
