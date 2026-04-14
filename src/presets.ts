import type { Dict } from './lib/types.js';

export type PresetExecutionFamily = 'summary' | 'chat' | 'plan' | 'repo-search';
export type PresetSurface = 'cli' | 'web';
export type PresetToolName = 'find_text' | 'read_lines' | 'json_filter' | 'run_repo_cmd';

export type SiftPreset = {
  id: string;
  label: string;
  description: string;
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

const BUILTIN_PRESETS: ReadonlyArray<SiftPreset> = [
  {
    id: 'summary',
    label: 'Summary',
    description: 'Default CLI summarizer for extraction-focused questions over text, files, or stdin.',
    executionFamily: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text', 'read_lines', 'json_filter'],
    surfaces: ['cli'],
    useForSummary: true,
    builtin: true,
    deletable: false,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: null,
  },
  {
    id: 'repo-search',
    label: 'Repo Search',
    description: 'Repository-aware search preset for codebase investigation with command-backed evidence gathering.',
    executionFamily: 'repo-search',
    promptPrefix: '',
    allowedTools: ['run_repo_cmd'],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: true,
    maxTurns: 45,
    thinkingInterval: 5,
    thinkingEnabled: null,
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Default web chat preset for direct local llama.cpp conversation.',
    executionFamily: 'chat',
    promptPrefix: 'general, coder friendly assistant',
    allowedTools: [],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: true,
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Web planning preset that searches the repo and returns an implementation plan with evidence.',
    executionFamily: 'plan',
    promptPrefix: '',
    allowedTools: ['run_repo_cmd'],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    repoRootRequired: true,
    maxTurns: 45,
    thinkingInterval: 5,
    thinkingEnabled: null,
  },
] as const;

const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
const PRESET_SURFACES: readonly PresetSurface[] = ['cli', 'web'];
const PRESET_TOOL_NAMES: readonly PresetToolName[] = ['find_text', 'read_lines', 'json_filter', 'run_repo_cmd'];

function toPresetId(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function isExecutionFamily(value: unknown): value is PresetExecutionFamily {
  return value === 'summary' || value === 'chat' || value === 'plan' || value === 'repo-search';
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
    if ((PRESET_TOOL_NAMES as readonly string[]).includes(String(item)) && !seen.has(item as PresetToolName)) {
      seen.add(item as PresetToolName);
    }
  }
  return Array.from(seen);
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

function normalizePresetRecord(input: unknown, fallback: SiftPreset): SiftPreset {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Dict;
  return {
    id: fallback.id,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : fallback.label,
    description: typeof record.description === 'string' && record.description.trim() ? record.description.trim() : fallback.description,
    executionFamily: fallback.executionFamily,
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
  };
}

function normalizeUserPreset(input: unknown): SiftPreset | null {
  const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Dict | null;
  if (!record) {
    return null;
  }
  const id = toPresetId(record.id);
  if (!id || BUILTIN_PRESET_IDS.has(id)) {
    return null;
  }
  const executionFamily = isExecutionFamily(record.executionFamily) ? record.executionFamily : 'summary';
  return {
    id,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    executionFamily,
    promptPrefix: normalizePromptPrefix(record.promptPrefix),
    allowedTools: normalizeToolList(record.allowedTools, executionFamily === 'summary'
      ? ['find_text', 'read_lines', 'json_filter']
      : executionFamily === 'chat'
        ? []
        : ['run_repo_cmd']),
    surfaces: normalizeSurfaceList(record.surfaces, executionFamily === 'summary' ? ['cli'] : ['web']),
    useForSummary: Boolean(record.useForSummary),
    builtin: false,
    deletable: true,
    repoRootRequired: record.repoRootRequired === undefined ? (executionFamily === 'plan' || executionFamily === 'repo-search') : Boolean(record.repoRootRequired),
    maxTurns: normalizeNullableInteger(record.maxTurns, executionFamily === 'plan' || executionFamily === 'repo-search' ? 45 : null),
    thinkingInterval: normalizeNullableInteger(record.thinkingInterval, executionFamily === 'plan' || executionFamily === 'repo-search' ? 5 : null),
    thinkingEnabled: normalizeNullableBoolean(record.thinkingEnabled, executionFamily === 'chat' ? true : null),
  };
}

export function getBuiltinPresets(): SiftPreset[] {
  return BUILTIN_PRESETS.map((preset) => ({ ...preset, surfaces: [...preset.surfaces], allowedTools: [...preset.allowedTools] }));
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
    const id = toPresetId(record.id);
    if (!id) {
      continue;
    }
    overlayById.set(id, item);
  }
  for (const builtin of BUILTIN_PRESETS) {
    const normalized = normalizePresetRecord(overlayById.get(builtin.id), builtin);
    presetsById.set(builtin.id, normalized);
  }
  for (const item of overlays) {
    const normalized = normalizeUserPreset(item);
    if (!normalized || presetsById.has(normalized.id)) {
      continue;
    }
    presetsById.set(normalized.id, normalized);
  }
  const result = Array.from(presetsById.values());
  const hasSummaryDefault = result.some((preset) => preset.executionFamily === 'summary' && preset.useForSummary);
  if (!hasSummaryDefault) {
    const summaryPreset = result.find((preset) => preset.id === 'summary');
    if (summaryPreset) {
      summaryPreset.useForSummary = true;
    }
  }
  return result;
}

export function findPresetById(presets: readonly SiftPreset[], presetId: unknown): SiftPreset | null {
  const normalizedId = toPresetId(presetId);
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
  return presets.find((preset) => preset.executionFamily === 'summary' && preset.useForSummary)
    || presets.find((preset) => preset.id === 'summary')
    || normalizePresets([]).find((preset) => preset.id === 'summary') as SiftPreset;
}

export function getPresetExecutionFamily(presetId: unknown, presets: readonly SiftPreset[]): PresetExecutionFamily {
  return findPresetById(presets, presetId)?.executionFamily || 'chat';
}

export function mapLegacyModeToPresetId(mode: unknown): string {
  return mode === 'plan' || mode === 'repo-search' ? mode : 'chat';
}

export function mapPresetIdToLegacyMode(presetId: unknown, presets?: readonly SiftPreset[]): 'chat' | 'plan' | 'repo-search' {
  const executionFamily = presets ? getPresetExecutionFamily(presetId, presets) : (
    presetId === 'plan' || presetId === 'repo-search' ? presetId : 'chat'
  );
  return executionFamily === 'plan' || executionFamily === 'repo-search' ? executionFamily : 'chat';
}

export function getPresetSurfaceOptions(): PresetSurface[] {
  return [...PRESET_SURFACES];
}

export function isBuiltinPresetId(value: unknown): boolean {
  return BUILTIN_PRESET_IDS.has(toPresetId(value));
}
