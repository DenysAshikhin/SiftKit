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
  'json_get',
  'repo_rg',
  'repo_read_file',
  'repo_list_files',
  'repo_git',
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

export const PRESET_TOOL_DESCRIPTIONS: Record<DashboardPresetToolName, string> = {
  find_text:
    'Search the input text for a literal string or regex and return matching lines with optional surrounding context. Best for anchoring on a known keyword, identifier, or symbol before reading larger windows.',
  read_lines:
    'Read a specific 1-based line range from the input text. Best after a find_text hit when you need surrounding context. Prefer larger contiguous windows over many tiny adjacent slices.',
  json_filter:
    'Parse JSON, filter array items by field conditions, and project only selected fields. Best for narrowing large JSON dumps to the few records that matter without paging through raw text.',
  json_get:
    'Parse JSON and return one exact nested value by dot-path. Best for object drill-down when you need a specific field or array element.',
  repo_rg:
    'Run ripgrep against the repository (read-only). Best for fast literal/regex search across a tree to locate symbols, configs, or call sites. Example: rg -n "pattern" src.',
  repo_read_file:
    'Read one repository file with optional 1-based line bounds. Best once ripgrep has already anchored the exact file and region you need.',
  repo_list_files:
    'List repository files under an optional path with optional glob filtering and recursion control. Best for directory/file discovery without shell-specific commands.',
  repo_git:
    'Run git read-only commands (status, log, diff, show). Best for inspecting branch state, recent history, or a specific commit without modifying the repo.',
  repo_select_object:
    'PowerShell Select-Object. Best for projecting specific properties or taking a head/tail slice from piped object output.',
  repo_where_object:
    'PowerShell Where-Object. Best for filtering piped objects by predicate (e.g. file size, extension, date) before further processing.',
  repo_sort_object:
    'PowerShell Sort-Object. Best for ordering piped object output by one or more properties before display or further filtering.',
  repo_group_object:
    'PowerShell Group-Object. Best for bucketing piped objects by a property to count occurrences or group related items.',
  repo_measure_object:
    'PowerShell Measure-Object. Best for computing counts, sums, averages, min/max over numeric or text properties of a piped collection.',
  repo_foreach_object:
    'PowerShell ForEach-Object. Best for projecting or transforming each item in a piped collection into a derived shape.',
  repo_format_table:
    'PowerShell Format-Table. Best for rendering a piped collection as a compact aligned table for human-readable output.',
  repo_format_list:
    'PowerShell Format-List. Best for rendering a piped collection as multi-line property lists when rows are too wide for a table.',
  repo_out_string:
    'PowerShell Out-String. Best for collapsing a piped object stream into a single rendered string suitable for downstream text processing.',
  repo_convertto_json:
    'PowerShell ConvertTo-Json. Best for serializing a piped object collection to JSON for stable, machine-readable downstream parsing.',
  repo_convertfrom_json:
    'PowerShell ConvertFrom-Json. Best for parsing a JSON file or string back into objects so other repo_* object cmdlets can operate on it.',
  repo_get_unique:
    'PowerShell Get-Unique. Best for de-duplicating a sorted piped collection (typically after Sort-Object).',
  repo_join_string:
    'PowerShell Join-String. Best for concatenating piped values into a single delimited string for compact output or building an argument list.',
};

const SUMMARY_TOOLS: DashboardPresetToolName[] = ['find_text', 'read_lines', 'json_filter', 'json_get'];
const READ_ONLY_TOOLS: DashboardPresetToolName[] = [
  'repo_rg',
  'repo_read_file',
  'repo_list_files',
  'repo_git',
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
    return;
  }
  preset.repoRootRequired = false;
  preset.maxTurns = null;
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
