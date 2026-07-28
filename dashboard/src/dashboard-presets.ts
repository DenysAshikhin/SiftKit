import type { OptionalJsonValue } from '../../src/lib/json-types.js';
import type { ChatSession, DashboardConfig, DashboardPreset, DashboardPresetKind, DashboardPresetSurface } from './types.js';

function normalizePresetId(value: OptionalJsonValue): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function getSurfacePresets(config: DashboardConfig | null, surface: DashboardPresetSurface): DashboardPreset[] {
  if (!config || !Array.isArray(config.Presets)) {
    return [];
  }
  return config.Presets.filter((preset) => preset.surfaces.includes(surface));
}

export function getPresetById(config: DashboardConfig | null, presetId: OptionalJsonValue): DashboardPreset | null {
  const normalizedId = normalizePresetId(presetId);
  if (!normalizedId || !config || !Array.isArray(config.Presets)) {
    return null;
  }
  return config.Presets.find((preset) => preset.id === normalizedId) || null;
}

export function getPresetFamily(config: DashboardConfig | null, session: ChatSession | null): DashboardPresetKind | null {
  const preset = getPresetById(config, session?.presetId);
  return preset?.presetKind ?? null;
}

export function getDefaultWebPresetId(config: DashboardConfig | null): string | null {
  const webPresets = getSurfacePresets(config, 'web');
  return webPresets[0]?.id ?? null;
}

export function createPresetIdFromLabel(label: string): string {
  const normalized = normalizePresetId(label);
  return normalized || 'custom-preset';
}
