import type { ChatSession, DashboardConfig, DashboardPreset, DashboardPresetKind, DashboardPresetSurface } from './types';

function normalizePresetId(value: unknown): string {
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

export function getPresetById(config: DashboardConfig | null, presetId: unknown): DashboardPreset | null {
  const normalizedId = normalizePresetId(presetId);
  if (!normalizedId || !config || !Array.isArray(config.Presets)) {
    return null;
  }
  return config.Presets.find((preset) => preset.id === normalizedId) || null;
}

export function getPresetFamily(config: DashboardConfig | null, session: ChatSession | null): DashboardPresetKind {
  const preset = getPresetById(config, session?.presetId);
  if (preset) {
    return preset.presetKind;
  }
  const normalizedPresetId = normalizePresetId(session?.presetId);
  if (
    normalizedPresetId === 'summary'
    || normalizedPresetId === 'chat'
    || normalizedPresetId === 'plan'
    || normalizedPresetId === 'repo-search'
  ) {
    return normalizedPresetId;
  }
  if (session?.mode === 'plan' || session?.mode === 'repo-search') {
    return session.mode;
  }
  return 'chat';
}

export function getDefaultWebPresetId(config: DashboardConfig | null): string {
  const webPresets = getSurfacePresets(config, 'web');
  return webPresets[0]?.id || 'chat';
}

export function createPresetIdFromLabel(label: string): string {
  const normalized = normalizePresetId(label);
  return normalized || 'custom-preset';
}
