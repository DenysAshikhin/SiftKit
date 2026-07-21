import type {
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetToolName,
} from './types.js';

export const PRESET_TOOL_OPTIONS: DashboardPresetToolName[] = [
  'find_text',
  'read_lines',
  'json_filter',
  'json_get',
  'read',
  'grep',
  'find',
  'ls',
  'git',
  'web_search',
  'web_fetch',
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
  read:
    'Read one repository file, optionally from a line offset for a line limit. Best once grep has anchored the exact file and region you need. Lines already returned in a task are skipped automatically.',
  grep:
    'Search file contents for a regex or literal pattern, returning file:line anchors. Best for locating symbols, configs, or call sites. Ignored paths are excluded automatically.',
  find:
    'Find files by glob pattern, returning paths relative to the search directory. Best for filename discovery without shell-specific commands.',
  ls:
    'List one directory level, with a trailing slash on directories and dotfiles included. Best for orienting in an unfamiliar tree.',
  git:
    'Run git read-only commands (status, log, diff, show, blame). Best for inspecting branch state, recent history, or a specific commit without modifying the repo.',
  web_search:
    'Search public web results. Best for finding current or external information by query; returns result titles, URLs, and snippets.',
  web_fetch:
    'Fetch public URL text. Best for reading the extracted text of one public HTTP(S) page. Private, local, and internal URLs are blocked.',
};

const SUMMARY_TOOLS: DashboardPresetToolName[] = ['find_text', 'read_lines', 'json_filter', 'json_get'];
const READ_ONLY_TOOLS: DashboardPresetToolName[] = ['read', 'grep', 'find', 'ls', 'git'];

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
