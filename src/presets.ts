import type { Dict } from './lib/types.js';

export type PresetKind = 'summary' | 'chat' | 'plan' | 'repo-search';
export type PresetExecutionFamily = PresetKind;
export type PresetOperationMode = 'summary' | 'read-only' | 'full';
export type PresetSurface = 'cli' | 'web';
export type PresetToolName = 'find_text' | 'read_lines' | 'json_filter' | 'run_repo_cmd';
export type OperationModeAllowedTools = Record<PresetOperationMode, PresetToolName[]>;

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
  repoRootRequired: boolean;
  maxTurns: number | null;
  thinkingInterval: number | null;
  thinkingEnabled: boolean | null;
};

const SUMMARY_TOOLS: readonly PresetToolName[] = ['find_text', 'read_lines', 'json_filter'];
const READ_ONLY_TOOLS: readonly PresetToolName[] = ['run_repo_cmd'];
const PRESET_SURFACES: readonly PresetSurface[] = ['cli', 'web'];
const PRESET_TOOL_NAMES: readonly PresetToolName[] = ['find_text', 'read_lines', 'json_filter', 'run_repo_cmd'];

const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS: OperationModeAllowedTools = {
  summary: [...SUMMARY_TOOLS],
  'read-only': [...READ_ONLY_TOOLS],
  full: [],
};

function getDefaultAllowedToolsForOperationMode(operationMode: PresetOperationMode): PresetToolName[] {
  return [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS[operationMode]];
}

function normalizePresetId(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function isPresetKind(value: unknown): value is PresetKind {
  return value === 'summary' || value === 'chat' || value === 'plan' || value === 'repo-search';
}

function isExecutionFamily(value: unknown): value is PresetExecutionFamily {
  return isPresetKind(value);
}

function isPresetOperationMode(value: unknown): value is PresetOperationMode {
  return value === 'summary' || value === 'read-only' || value === 'full';
}

function normalizePromptPrefix(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSurfaceList(value: unknown, fallback: readonly PresetSurface[]): PresetSurface[] {
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

function normalizeToolList(value: unknown, fallback: readonly PresetToolName[]): PresetToolName[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<PresetToolName>();
  for (const item of value) {
    const normalized = String(item);
    if ((PRESET_TOOL_NAMES as readonly string[]).includes(normalized) && !seen.has(normalized as PresetToolName)) {
      seen.add(normalized as PresetToolName);
    }
  }
  return seen.size > 0 ? Array.from(seen) : [...fallback];
}

function normalizeNullableInteger(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNullableBoolean(value: unknown, fallback: boolean | null): boolean | null {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return Boolean(value);
}

function getLegacyExecutionFamily(record: Dict): PresetExecutionFamily | null {
  return isExecutionFamily(record.executionFamily) ? record.executionFamily : null;
}

function getPresetKindFromRecord(record: Dict, fallback: PresetKind): PresetKind {
  if (isPresetKind(record.presetKind)) {
    return record.presetKind;
  }
  return getLegacyExecutionFamily(record) || fallback;
}

function getOperationModeFromRecord(record: Dict, fallback: PresetOperationMode, presetKind: PresetKind): PresetOperationMode {
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
  repoRootRequired: boolean;
  maxTurns: number | null;
  thinkingInterval: number | null;
  thinkingEnabled: boolean | null;
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
    repoRootRequired: input.repoRootRequired,
    maxTurns: input.maxTurns,
    thinkingInterval: input.thinkingInterval,
    thinkingEnabled: input.thinkingEnabled,
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
    allowedTools: SUMMARY_TOOLS as PresetToolName[],
    surfaces: ['cli'],
    useForSummary: true,
    builtin: true,
    deletable: false,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: null,
  }),
  buildPreset({
    id: 'repo-search',
    label: 'Repo Search',
    description: 'Repository-aware search preset for codebase investigation with command-backed evidence gathering.',
    presetKind: 'repo-search',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: READ_ONLY_TOOLS as PresetToolName[],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: true,
    maxTurns: 45,
    thinkingInterval: 5,
    thinkingEnabled: null,
  }),
  buildPreset({
    id: 'chat',
    label: 'Chat',
    description: 'Default web chat preset for direct local llama.cpp conversation.',
    presetKind: 'chat',
    operationMode: 'summary',
    promptPrefix: 'general, coder friendly assistant',
    allowedTools: SUMMARY_TOOLS as PresetToolName[],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: true,
  }),
  buildPreset({
    id: 'plan',
    label: 'Plan',
    description: 'Web planning preset that searches the repo and returns an implementation plan with evidence.',
    presetKind: 'plan',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: READ_ONLY_TOOLS as PresetToolName[],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: true,
    maxTurns: 45,
    thinkingInterval: 5,
    thinkingEnabled: null,
  }),
] as const;

const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));

function normalizePresetRecord(input: unknown, fallback: SiftPreset): SiftPreset {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Dict;
  const presetKind = getPresetKindFromRecord(record, fallback.presetKind);
  const operationMode = getOperationModeFromRecord(record, fallback.operationMode, presetKind);
  return buildPreset({
    id: fallback.id,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : fallback.label,
    description: typeof record.description === 'string' && record.description.trim() ? record.description.trim() : fallback.description,
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(record.promptPrefix ?? fallback.promptPrefix),
    allowedTools: normalizeToolList(record.allowedTools, fallback.allowedTools),
    surfaces: normalizeSurfaceList(record.surfaces, fallback.surfaces),
    useForSummary: record.useForSummary === undefined ? fallback.useForSummary : Boolean(record.useForSummary),
    builtin: fallback.builtin,
    deletable: false,
    repoRootRequired: record.repoRootRequired === undefined ? fallback.repoRootRequired : Boolean(record.repoRootRequired),
    maxTurns: normalizeNullableInteger(record.maxTurns, fallback.maxTurns),
    thinkingInterval: normalizeNullableInteger(record.thinkingInterval, fallback.thinkingInterval),
    thinkingEnabled: normalizeNullableBoolean(record.thinkingEnabled, fallback.thinkingEnabled),
  });
}

function normalizeUserPreset(input: unknown): SiftPreset | null {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Dict | null;
  if (!record) {
    return null;
  }
  const id = normalizePresetId(record.id);
  if (!id || BUILTIN_PRESET_IDS.has(id)) {
    return null;
  }
  const presetKind = getPresetKindFromRecord(record, 'summary');
  const operationMode = getOperationModeFromRecord(record, presetKind === 'plan' || presetKind === 'repo-search' ? 'read-only' : 'summary', presetKind);
  const defaultAllowedTools = getDefaultAllowedToolsForOperationMode(operationMode);
  return buildPreset({
    id,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(record.promptPrefix),
    allowedTools: normalizeToolList(record.allowedTools, defaultAllowedTools),
    surfaces: normalizeSurfaceList(record.surfaces, presetKind === 'summary' ? ['cli'] : ['web']),
    useForSummary: Boolean(record.useForSummary),
    builtin: false,
    deletable: true,
    repoRootRequired: record.repoRootRequired === undefined ? (presetKind === 'plan' || presetKind === 'repo-search') : Boolean(record.repoRootRequired),
    maxTurns: normalizeNullableInteger(record.maxTurns, presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
    thinkingInterval: normalizeNullableInteger(record.thinkingInterval, presetKind === 'plan' || presetKind === 'repo-search' ? 5 : null),
    thinkingEnabled: normalizeNullableBoolean(record.thinkingEnabled, presetKind === 'chat' ? true : null),
  });
}

export function getDefaultOperationModeAllowedTools(): OperationModeAllowedTools {
  return {
    summary: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary],
    'read-only': [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']],
    full: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full],
  };
}

export function normalizeOperationModeAllowedTools(input: unknown): OperationModeAllowedTools {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Dict;
  return {
    summary: normalizeToolList(record.summary, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary),
    'read-only': normalizeToolList(record['read-only'], DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']),
    full: normalizeToolList(record.full, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full),
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

export function normalizePresets(input: unknown): SiftPreset[] {
  const presetsById = new Map<string, SiftPreset>();
  const overlays = Array.isArray(input) ? input : [];
  const overlayById = new Map<string, unknown>();
  for (const item of overlays) {
    const record = (item && typeof item === 'object' && !Array.isArray(item) ? item : null) as Dict | null;
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

export function findPresetById(presets: readonly SiftPreset[], presetId: unknown): SiftPreset | null {
  const normalizedId = normalizePresetId(presetId);
  if (!normalizedId) {
    return null;
  }
  return presets.find((preset) => preset.id === normalizedId) || null;
}

export function getConfigPresets(config: unknown): SiftPreset[] {
  const record = (config && typeof config === 'object' && !Array.isArray(config) ? config : {}) as Dict;
  return normalizePresets(record.Presets);
}

export function getPresetsForSurface(presets: readonly SiftPreset[], surface: PresetSurface): SiftPreset[] {
  return presets.filter((preset) => preset.surfaces.includes(surface));
}

export function resolveSummaryPreset(presets: readonly SiftPreset[]): SiftPreset {
  return presets.find((preset) => preset.presetKind === 'summary' && preset.useForSummary)
    || presets.find((preset) => preset.id === 'summary')
    || normalizePresets([]).find((preset) => preset.id === 'summary') as SiftPreset;
}

export function getPresetExecutionFamily(presetId: unknown, presets: readonly SiftPreset[]): PresetExecutionFamily {
  return findPresetById(presets, presetId)?.executionFamily || 'chat';
}

export function getPresetKind(presetId: unknown, presets: readonly SiftPreset[]): PresetKind {
  return findPresetById(presets, presetId)?.presetKind || 'chat';
}

export function getPresetExecutionOperationMode(presetId: unknown, presets: readonly SiftPreset[]): PresetOperationMode {
  return findPresetById(presets, presetId)?.operationMode || 'summary';
}

export function mapLegacyModeToPresetId(mode: unknown): string {
  return mode === 'plan' || mode === 'repo-search' ? mode : 'chat';
}

export function mapPresetIdToLegacyMode(presetId: unknown, presets?: readonly SiftPreset[]): 'chat' | 'plan' | 'repo-search' {
  const presetKind = presets ? getPresetKind(presetId, presets) : (
    presetId === 'plan' || presetId === 'repo-search' ? presetId : 'chat'
  );
  return presetKind === 'plan' || presetKind === 'repo-search' ? presetKind : 'chat';
}

export function getPresetSurfaceOptions(): PresetSurface[] {
  return [...PRESET_SURFACES];
}

export function isBuiltinPresetId(value: unknown): boolean {
  return BUILTIN_PRESET_IDS.has(normalizePresetId(value));
}
