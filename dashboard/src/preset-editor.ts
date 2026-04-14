import type { DashboardPreset, DashboardPresetToolName } from './types';

export const PRESET_TOOL_OPTIONS: DashboardPresetToolName[] = [
  'find_text',
  'read_lines',
  'json_filter',
  'run_repo_cmd',
];

export function getFallbackPresetId(
  presets: DashboardPreset[],
  selectedPresetId: string | null,
): string | null {
  if (presets.length === 0) {
    return null;
  }
  if (selectedPresetId && presets.some((preset) => preset.id === selectedPresetId)) {
    return selectedPresetId;
  }
  return presets[0]?.id ?? null;
}

export function getNextPresetIdAfterDelete(
  presets: DashboardPreset[],
  removedPresetId: string,
): string | null {
  if (presets.length === 0) {
    return null;
  }
  const removedIndex = presets.findIndex((preset) => preset.id === removedPresetId);
  if (removedIndex < 0) {
    return presets[0]?.id ?? null;
  }
  return presets[removedIndex + 1]?.id ?? presets[removedIndex - 1]?.id ?? null;
}

export function togglePresetTool(
  allowedTools: DashboardPresetToolName[],
  tool: DashboardPresetToolName,
): DashboardPresetToolName[] {
  if (allowedTools.includes(tool)) {
    return PRESET_TOOL_OPTIONS.filter((option) => option !== tool && allowedTools.includes(option));
  }
  return PRESET_TOOL_OPTIONS.filter((option) => option === tool || allowedTools.includes(option));
}

export function getPresetToolsSummary(allowedTools: DashboardPresetToolName[]): string {
  return PRESET_TOOL_OPTIONS.filter((tool) => allowedTools.includes(tool)).join(', ');
}
