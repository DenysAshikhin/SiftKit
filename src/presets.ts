import { JsonRecordReader } from './lib/json-record-reader.js';
import type { JsonObject, JsonValue, OptionalJsonValue } from './lib/json-types.js';

export type PresetKind = 'summary' | 'chat' | 'plan' | 'repo-search';
export type PresetExecutionFamily = PresetKind;
export type PresetOperationMode = 'summary' | 'read-only' | 'full';
export type PresetSurface = 'cli' | 'web';

const SUMMARY_TOOLS = ['find_text', 'read_lines', 'json_filter', 'json_get'] as const;
export const REPO_SEARCH_TOOLS = [
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
] as const;

export const WEB_RESEARCH_TOOLS = ['web_search', 'web_fetch'] as const;
const PRESET_TOOL_NAMES = [...SUMMARY_TOOLS, ...REPO_SEARCH_TOOLS, ...WEB_RESEARCH_TOOLS] as const;
const PRESET_TOOL_NAME_SET = new Set<string>(PRESET_TOOL_NAMES);
const LEGACY_REPO_SEARCH_TOOL_ALIAS = 'run_repo_cmd';
const READ_ONLY_TOOLS = [...REPO_SEARCH_TOOLS] as const;

export type PresetToolName = (typeof PRESET_TOOL_NAMES)[number];
export type OperationModeAllowedTools = Record<PresetOperationMode, PresetToolName[]>;

function isPresetToolName(value: string): value is PresetToolName {
  return PRESET_TOOL_NAME_SET.has(value);
}

export type SiftPreset = {
  id: string;
  label: string;
  description: string;
  presetKind: PresetKind;
  operationMode: PresetOperationMode;
  executionFamily: PresetExecutionFamily;
  promptPrefix: string;
  allowedTools: PresetToolName[];
  surfaces: PresetSurface[];
  useForSummary: boolean;
  builtin: boolean;
  deletable: boolean;
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
  repoRootRequired: boolean;
  maxTurns: number | null;
};

const PRESET_SURFACES: readonly PresetSurface[] = ['cli', 'web'];

const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS: OperationModeAllowedTools = {
  summary: [...SUMMARY_TOOLS],
  'read-only': [...READ_ONLY_TOOLS],
  full: [],
};

function getDefaultAllowedToolsForOperationMode(operationMode: PresetOperationMode): PresetToolName[] {
  return [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS[operationMode]];
}

function normalizePresetId(value: OptionalJsonValue): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function isPresetKind(value: OptionalJsonValue): value is PresetKind {
  return value === 'summary' || value === 'chat' || value === 'plan' || value === 'repo-search';
}

function isExecutionFamily(value: OptionalJsonValue): value is PresetExecutionFamily {
  return isPresetKind(value);
}

export function isPresetOperationMode(value: OptionalJsonValue): value is PresetOperationMode {
  return value === 'summary' || value === 'read-only' || value === 'full';
}

function normalizePromptPrefix(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSurfaceList(value: OptionalJsonValue, fallback: readonly PresetSurface[]): PresetSurface[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<PresetSurface>();
  for (const item of value) {
    if ((item === 'cli' || item === 'web') && !seen.has(item)) {
      seen.add(item);
    }
  }
  return seen.size > 0 ? Array.from(seen) : [...fallback];
}

function normalizeToolList(value: OptionalJsonValue, fallback: readonly PresetToolName[]): PresetToolName[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<PresetToolName>();
  const pushTool = (toolName: PresetToolName): void => {
    if (!seen.has(toolName)) {
      seen.add(toolName);
    }
  };
  for (const item of value) {
    const normalized = String(item);
    if (normalized === LEGACY_REPO_SEARCH_TOOL_ALIAS) {
      for (const repoToolName of REPO_SEARCH_TOOLS) {
        pushTool(repoToolName);
      }
      continue;
    }
    const mappedToolNames = normalized === 'repo_get_content'
      ? ['repo_read_file']
      : normalized === 'repo_get_childitem' || normalized === 'repo_ls'
        ? ['repo_list_files']
        : normalized === 'repo_select_string'
          ? ['repo_rg']
          : normalized === 'repo_pwd'
            ? []
            : [normalized];
    for (const mappedToolName of mappedToolNames) {
      if (isPresetToolName(mappedToolName)) {
        pushTool(mappedToolName);
      }
    }
  }
  return seen.size > 0 ? Array.from(seen) : [...fallback];
}

function normalizeNullableInteger(value: OptionalJsonValue, fallback: number | null): number | null {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLegacyExecutionFamily(record: JsonObject): PresetExecutionFamily | null {
  return isExecutionFamily(record.executionFamily) ? record.executionFamily : null;
}

function getPresetKindFromRecord(record: JsonObject, fallback: PresetKind): PresetKind {
  if (isPresetKind(record.presetKind)) {
    return record.presetKind;
  }
  return getLegacyExecutionFamily(record) || fallback;
}

function getOperationModeFromRecord(record: JsonObject, fallback: PresetOperationMode, presetKind: PresetKind): PresetOperationMode {
  if (isPresetOperationMode(record.operationMode)) {
    return record.operationMode;
  }
  const legacyExecutionFamily = getLegacyExecutionFamily(record);
  if (legacyExecutionFamily === 'plan' || legacyExecutionFamily === 'repo-search') {
    return 'read-only';
  }
  if (legacyExecutionFamily === 'summary' || legacyExecutionFamily === 'chat') {
    return 'summary';
  }
  if (presetKind === 'plan' || presetKind === 'repo-search') {
    return 'read-only';
  }
  return fallback;
}

function buildPreset(input: {
  id: string;
  label: string;
  description: string;
  presetKind: PresetKind;
  operationMode: PresetOperationMode;
  promptPrefix: string;
  allowedTools: PresetToolName[];
  surfaces: PresetSurface[];
  useForSummary: boolean;
  builtin: boolean;
  deletable: boolean;
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
  repoRootRequired: boolean;
  maxTurns: number | null;
}): SiftPreset {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    presetKind: input.presetKind,
    operationMode: input.operationMode,
    executionFamily: input.presetKind,
    promptPrefix: input.promptPrefix,
    allowedTools: [...input.allowedTools],
    surfaces: [...input.surfaces],
    useForSummary: input.useForSummary,
    builtin: input.builtin,
    deletable: input.deletable,
    includeAgentsMd: input.includeAgentsMd,
    includeRepoFileListing: input.includeRepoFileListing,
    repoRootRequired: input.repoRootRequired,
    maxTurns: input.maxTurns,
  };
}

const BUILTIN_PRESETS: ReadonlyArray<SiftPreset> = [
  buildPreset({
    id: 'summary',
    label: 'Summary',
    description: 'Default CLI summarizer for extraction-focused questions over text, files, or stdin.',
    presetKind: 'summary',
    operationMode: 'summary',
    promptPrefix: '',
    allowedTools: [...SUMMARY_TOOLS],
    surfaces: ['cli'],
    useForSummary: true,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: false,
    maxTurns: null,
  }),
  buildPreset({
    id: 'repo-search',
    label: 'Repo Search',
    description: 'Repository-aware search preset for codebase investigation with command-backed evidence gathering.',
    presetKind: 'repo-search',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: [...READ_ONLY_TOOLS],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: true,
    maxTurns: 45,
  }),
  buildPreset({
    id: 'chat',
    label: 'Chat',
    description: 'Default web chat preset for direct local llama.cpp conversation.',
    presetKind: 'chat',
    operationMode: 'summary',
    promptPrefix: 'general, coder friendly assistant',
    allowedTools: [...SUMMARY_TOOLS],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: false,
    maxTurns: null,
  }),
  buildPreset({
    id: 'plan',
    label: 'Plan',
    description: 'Web planning preset that searches the repo and returns an implementation plan with evidence.',
    presetKind: 'plan',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: [...READ_ONLY_TOOLS],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: true,
    maxTurns: 45,
  }),
] as const;

const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));

function normalizePresetRecord(input: OptionalJsonValue, fallback: SiftPreset): SiftPreset {
  const record = JsonRecordReader.asObject(input) || {};
  const reader = new JsonRecordReader(record);
  const presetKind = getPresetKindFromRecord(record, fallback.presetKind);
  const operationMode = getOperationModeFromRecord(record, fallback.operationMode, presetKind);
  return buildPreset({
    id: fallback.id,
    label: reader.optionalString('label') || fallback.label,
    description: reader.optionalString('description') || fallback.description,
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(reader.value('promptPrefix') ?? fallback.promptPrefix),
    allowedTools: normalizeToolList(reader.value('allowedTools'), fallback.allowedTools),
    surfaces: normalizeSurfaceList(reader.value('surfaces'), fallback.surfaces),
    useForSummary: reader.value('useForSummary') === undefined ? fallback.useForSummary : Boolean(reader.value('useForSummary')),
    builtin: fallback.builtin,
    deletable: false,
    includeAgentsMd: reader.value('includeAgentsMd') === undefined ? fallback.includeAgentsMd : Boolean(reader.value('includeAgentsMd')),
    includeRepoFileListing: reader.value('includeRepoFileListing') === undefined ? fallback.includeRepoFileListing : Boolean(reader.value('includeRepoFileListing')),
    repoRootRequired: reader.value('repoRootRequired') === undefined ? fallback.repoRootRequired : Boolean(reader.value('repoRootRequired')),
    maxTurns: normalizeNullableInteger(reader.value('maxTurns'), fallback.maxTurns),
  });
}

function normalizeUserPreset(input: OptionalJsonValue): SiftPreset | null {
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return null;
  }
  const reader = new JsonRecordReader(record);
  const id = normalizePresetId(reader.value('id'));
  if (!id || BUILTIN_PRESET_IDS.has(id)) {
    return null;
  }
  const presetKind = getPresetKindFromRecord(record, 'summary');
  const operationMode = getOperationModeFromRecord(record, presetKind === 'plan' || presetKind === 'repo-search' ? 'read-only' : 'summary', presetKind);
  const defaultAllowedTools = getDefaultAllowedToolsForOperationMode(operationMode);
  return buildPreset({
    id,
    label: reader.optionalString('label') || id,
    description: reader.string('description'),
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(reader.value('promptPrefix')),
    allowedTools: normalizeToolList(reader.value('allowedTools'), defaultAllowedTools),
    surfaces: normalizeSurfaceList(reader.value('surfaces'), presetKind === 'summary' ? ['cli'] : ['web']),
    useForSummary: Boolean(reader.value('useForSummary')),
    builtin: false,
    deletable: true,
    includeAgentsMd: reader.value('includeAgentsMd') === undefined ? true : Boolean(reader.value('includeAgentsMd')),
    includeRepoFileListing: reader.value('includeRepoFileListing') === undefined ? true : Boolean(reader.value('includeRepoFileListing')),
    repoRootRequired: reader.value('repoRootRequired') === undefined ? (presetKind === 'plan' || presetKind === 'repo-search') : Boolean(reader.value('repoRootRequired')),
    maxTurns: normalizeNullableInteger(reader.value('maxTurns'), presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
  });
}

export function getDefaultOperationModeAllowedTools(): OperationModeAllowedTools {
  return {
    summary: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary],
    'read-only': [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']],
    full: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full],
  };
}

export function normalizeOperationModeAllowedTools(input: OptionalJsonValue): OperationModeAllowedTools {
  const reader = JsonRecordReader.fromJsonValue(input);
  const summaryTools = normalizeToolList(reader.value('summary'), DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary);
  if (
    summaryTools.includes('find_text')
    && summaryTools.includes('read_lines')
    && summaryTools.includes('json_filter')
    && !summaryTools.includes('json_get')
  ) {
    summaryTools.push('json_get');
  }
  return {
    summary: summaryTools,
    'read-only': normalizeToolList(reader.value('read-only'), DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']),
    full: normalizeToolList(reader.value('full'), DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full),
  };
}

export function resolvePresetAllowedTools(
  preset: Pick<SiftPreset, 'allowedTools' | 'operationMode'>,
  operationModeAllowedTools: OperationModeAllowedTools,
): PresetToolName[] {
  const modeAllowed = new Set<PresetToolName>(operationModeAllowedTools[preset.operationMode] || []);
  return preset.allowedTools.filter((tool) => modeAllowed.has(tool));
}

export function getBuiltinPresets(): SiftPreset[] {
  return BUILTIN_PRESETS.map((preset) => buildPreset(preset));
}

export function normalizePresets(input: OptionalJsonValue): SiftPreset[] {
  const presetsById = new Map<string, SiftPreset>();
  const overlays = Array.isArray(input) ? input : [];
  const overlayById = new Map<string, JsonValue>();
  for (const item of overlays) {
    const record = JsonRecordReader.asObject(item);
    if (!record) {
      continue;
    }
    const id = normalizePresetId(record.id);
    if (!id) {
      continue;
    }
    overlayById.set(id, item);
  }
  for (const builtin of BUILTIN_PRESETS) {
    presetsById.set(builtin.id, normalizePresetRecord(overlayById.get(builtin.id), builtin));
  }
  for (const item of overlays) {
    const normalized = normalizeUserPreset(item);
    if (!normalized || presetsById.has(normalized.id)) {
      continue;
    }
    presetsById.set(normalized.id, normalized);
  }
  const result = Array.from(presetsById.values());
  const hasSummaryDefault = result.some((preset) => preset.presetKind === 'summary' && preset.useForSummary);
  if (!hasSummaryDefault) {
    const summaryPreset = result.find((preset) => preset.id === 'summary');
    if (summaryPreset) {
      summaryPreset.useForSummary = true;
    }
  }
  return result;
}

export function findPresetById(presets: readonly SiftPreset[], presetId: OptionalJsonValue): SiftPreset | null {
  const normalizedId = normalizePresetId(presetId);
  if (!normalizedId) {
    return null;
  }
  return presets.find((preset) => preset.id === normalizedId) || null;
}

export function getConfigPresets(config: OptionalJsonValue): SiftPreset[] {
  const reader = JsonRecordReader.fromJsonValue(config);
  return normalizePresets(reader.value('Presets'));
}

export function getPresetsForSurface(presets: readonly SiftPreset[], surface: PresetSurface): SiftPreset[] {
  return presets.filter((preset) => preset.surfaces.includes(surface));
}

export function resolveSummaryPreset(presets: readonly SiftPreset[]): SiftPreset {
  const found = presets.find((preset) => preset.presetKind === 'summary' && preset.useForSummary)
    || presets.find((preset) => preset.id === 'summary')
    || normalizePresets([]).find((preset) => preset.id === 'summary');
  if (!found) {
    throw new Error('Summary preset is missing from the builtin preset set.');
  }
  return found;
}

export function getPresetExecutionFamily(presetId: OptionalJsonValue, presets: readonly SiftPreset[]): PresetExecutionFamily {
  return findPresetById(presets, presetId)?.executionFamily || 'chat';
}

export function getPresetKind(presetId: OptionalJsonValue, presets: readonly SiftPreset[]): PresetKind {
  return findPresetById(presets, presetId)?.presetKind || 'chat';
}

export function getPresetExecutionOperationMode(presetId: OptionalJsonValue, presets: readonly SiftPreset[]): PresetOperationMode {
  return findPresetById(presets, presetId)?.operationMode || 'summary';
}

export function mapLegacyModeToPresetId(mode: OptionalJsonValue): string {
  return mode === 'plan' || mode === 'repo-search' ? mode : 'chat';
}

export function mapPresetIdToLegacyMode(presetId: OptionalJsonValue, presets?: readonly SiftPreset[]): 'chat' | 'plan' | 'repo-search' {
  const presetKind = presets ? getPresetKind(presetId, presets) : (
    presetId === 'plan' || presetId === 'repo-search' ? presetId : 'chat'
  );
  return presetKind === 'plan' || presetKind === 'repo-search' ? presetKind : 'chat';
}

export function getPresetSurfaceOptions(): PresetSurface[] {
  return [...PRESET_SURFACES];
}

export function isBuiltinPresetId(value: OptionalJsonValue): boolean {
  return BUILTIN_PRESET_IDS.has(normalizePresetId(value));
}
