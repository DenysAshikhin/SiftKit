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

function equalOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function hasSamePresetExecutionContext(current: DashboardPreset, next: DashboardPreset): boolean {
  return current.presetKind === next.presetKind
    && current.operationMode === next.operationMode
    && current.promptPrefix === next.promptPrefix
    && equalOrderedValues(current.allowedTools, next.allowedTools)
    && current.includeAgentsMd === next.includeAgentsMd
    && current.includeRepoFileListing === next.includeRepoFileListing
    && current.assistantMemory === next.assistantMemory
    && equalOrderedValues(current.autoloadFiles, next.autoloadFiles);
}

export function createPresetIdFromLabel(label: string): string {
  const normalized = normalizePresetId(label);
  return normalized || 'custom-preset';
}
