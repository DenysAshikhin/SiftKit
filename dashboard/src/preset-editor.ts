import type {
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetToolName,
} from './types';

export const PRESET_TOOL_OPTIONS: DashboardPresetToolName[] = [
  'find_text',
  'read_lines',
  'json_filter',
  'repo_rg',
  'repo_get_content',
  'repo_get_childitem',
  'repo_select_string',
  'repo_git',
  'repo_pwd',
  'repo_ls',
  'repo_select_object',
  'repo_where_object',
  'repo_sort_object',
  'repo_group_object',
  'repo_measure_object',
  'repo_foreach_object',
  'repo_format_table',
  'repo_format_list',
  'repo_out_string',
  'repo_convertto_json',
  'repo_convertfrom_json',
  'repo_get_unique',
  'repo_join_string',
];

const SUMMARY_TOOLS: DashboardPresetToolName[] = ['find_text', 'read_lines', 'json_filter'];
const READ_ONLY_TOOLS: DashboardPresetToolName[] = [
  'repo_rg',
  'repo_get_content',
  'repo_get_childitem',
  'repo_select_string',
  'repo_git',
  'repo_pwd',
  'repo_ls',
  'repo_select_object',
  'repo_where_object',
  'repo_sort_object',
  'repo_group_object',
  'repo_measure_object',
  'repo_foreach_object',
  'repo_format_table',
  'repo_format_list',
  'repo_out_string',
  'repo_convertto_json',
  'repo_convertfrom_json',
  'repo_get_unique',
  'repo_join_string',
];

export function getDefaultToolsForOperationMode(
  operationMode: DashboardPresetOperationMode,
): DashboardPresetToolName[] {
  if (operationMode === 'summary') {
    return [...SUMMARY_TOOLS];
  }
  if (operationMode === 'read-only') {
    return [...READ_ONLY_TOOLS];
  }
  return [];
}

export function getDefaultOperationModeForPresetKind(
  presetKind: DashboardPresetKind,
): DashboardPresetOperationMode {
  if (presetKind === 'plan' || presetKind === 'repo-search') {
    return 'read-only';
  }
  return 'summary';
}

export function applyOperationModeDefaults(
  preset: DashboardPreset,
  operationMode: DashboardPresetOperationMode,
): void {
  preset.operationMode = operationMode;
  preset.allowedTools = getDefaultToolsForOperationMode(operationMode);
  if (preset.presetKind === 'plan' || preset.presetKind === 'repo-search') {
    preset.repoRootRequired = true;
    preset.maxTurns = preset.maxTurns || 45;
    preset.thinkingInterval = preset.thinkingInterval || 5;
    preset.thinkingEnabled = null;
    return;
  }
  preset.repoRootRequired = false;
  preset.maxTurns = null;
  preset.thinkingInterval = null;
  preset.thinkingEnabled = preset.presetKind === 'chat' ? true : null;
}

export function applyPresetKindDefaults(
  preset: DashboardPreset,
  presetKind: DashboardPresetKind,
): void {
  preset.presetKind = presetKind;
  preset.executionFamily = presetKind;
  applyOperationModeDefaults(preset, getDefaultOperationModeForPresetKind(presetKind));
}

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

export function getEffectivePresetTools(
  preset: Pick<DashboardPreset, 'allowedTools' | 'operationMode'>,
  operationModeAllowedTools: DashboardOperationModeAllowedTools,
): DashboardPresetToolName[] {
  const modeAllowedTools = operationModeAllowedTools[preset.operationMode] || [];
  return PRESET_TOOL_OPTIONS.filter((tool) => (
    preset.allowedTools.includes(tool) && modeAllowedTools.includes(tool)
  ));
}
