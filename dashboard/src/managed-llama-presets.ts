import type { DashboardConfig, DashboardManagedLlamaPreset } from './types.js';

function createPresetIdFromLabel(label: string): string {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'preset';
}

function getUniqueManagedLlamaPresetId(
  presets: DashboardManagedLlamaPreset[],
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

export function getActiveManagedLlamaPreset(config: DashboardConfig): DashboardManagedLlamaPreset {
  const presets = config.Server.LlamaCpp.Presets;
  const activePreset = presets.find((preset) => preset.id === config.Server.LlamaCpp.ActivePresetId)
    ?? presets[0];
  if (!activePreset) {
    throw new Error('Managed llama preset list is empty.');
  }
  config.Server.LlamaCpp.ActivePresetId = activePreset.id;
  return activePreset;
}

export function applyManagedLlamaPresetSelection(config: DashboardConfig, presetId: string): void {
  const preset = config.Server.LlamaCpp.Presets.find((entry) => entry.id === presetId);
  if (!preset) {
    return;
  }
  config.Server.LlamaCpp.ActivePresetId = preset.id;
}

export function updateActiveManagedLlamaPreset(
  config: DashboardConfig,
  updater: (preset: DashboardManagedLlamaPreset) => void,
): void {
  updater(getActiveManagedLlamaPreset(config));
}

export function addManagedLlamaPreset(config: DashboardConfig): string {
  const presets = config.Server.LlamaCpp.Presets;
  const activePreset = getActiveManagedLlamaPreset(config);
  const nextId = getUniqueManagedLlamaPresetId(presets, activePreset.label);
  presets.push({ ...activePreset, id: nextId, label: activePreset.label });
  config.Server.LlamaCpp.ActivePresetId = nextId;
  return nextId;
}

export function deleteManagedLlamaPreset(config: DashboardConfig, presetId: string): void {
  const presets = config.Server.LlamaCpp.Presets;
  if (presets.length <= 1) {
    return;
  }
  const remaining = presets.filter((preset) => preset.id !== presetId);
  config.Server.LlamaCpp.Presets = remaining;
  const nextPreset = remaining.find((preset) => preset.id === config.Server.LlamaCpp.ActivePresetId)
    ?? remaining[0];
  if (!nextPreset) {
    throw new Error('Managed llama preset list is empty.');
  }
  config.Server.LlamaCpp.ActivePresetId = nextPreset.id;
}

export type { DashboardManagedLlamaPreset };
