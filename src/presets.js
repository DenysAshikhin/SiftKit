"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEB_RESEARCH_TOOLS = exports.REPO_SEARCH_TOOLS = void 0;
exports.getDefaultOperationModeAllowedTools = getDefaultOperationModeAllowedTools;
exports.normalizeOperationModeAllowedTools = normalizeOperationModeAllowedTools;
exports.resolvePresetAllowedTools = resolvePresetAllowedTools;
exports.getBuiltinPresets = getBuiltinPresets;
exports.normalizePresets = normalizePresets;
exports.findPresetById = findPresetById;
exports.getConfigPresets = getConfigPresets;
exports.getPresetsForSurface = getPresetsForSurface;
exports.resolveSummaryPreset = resolveSummaryPreset;
exports.getPresetExecutionFamily = getPresetExecutionFamily;
exports.getPresetKind = getPresetKind;
exports.getPresetExecutionOperationMode = getPresetExecutionOperationMode;
exports.mapLegacyModeToPresetId = mapLegacyModeToPresetId;
exports.mapPresetIdToLegacyMode = mapPresetIdToLegacyMode;
exports.getPresetSurfaceOptions = getPresetSurfaceOptions;
exports.isBuiltinPresetId = isBuiltinPresetId;
const SUMMARY_TOOLS = ['find_text', 'read_lines', 'json_filter', 'json_get'];
exports.REPO_SEARCH_TOOLS = [
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
exports.WEB_RESEARCH_TOOLS = ['web_search', 'web_fetch'];
const PRESET_TOOL_NAMES = [...SUMMARY_TOOLS, ...exports.REPO_SEARCH_TOOLS, ...exports.WEB_RESEARCH_TOOLS];
const PRESET_TOOL_NAME_SET = new Set(PRESET_TOOL_NAMES);
const LEGACY_REPO_SEARCH_TOOL_ALIAS = 'run_repo_cmd';
const READ_ONLY_TOOLS = [...exports.REPO_SEARCH_TOOLS];
const PRESET_SURFACES = ['cli', 'web'];
const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS = {
    summary: [...SUMMARY_TOOLS],
    'read-only': [...READ_ONLY_TOOLS],
    full: [],
};
function getDefaultAllowedToolsForOperationMode(operationMode) {
    return [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS[operationMode]];
}
function normalizePresetId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
}
function isPresetKind(value) {
    return value === 'summary' || value === 'chat' || value === 'plan' || value === 'repo-search';
}
function isExecutionFamily(value) {
    return isPresetKind(value);
}
function isPresetOperationMode(value) {
    return value === 'summary' || value === 'read-only' || value === 'full';
}
function normalizePromptPrefix(value) {
    return typeof value === 'string' ? value : '';
}
function normalizeSurfaceList(value, fallback) {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const seen = new Set();
    for (const item of value) {
        if ((item === 'cli' || item === 'web') && !seen.has(item)) {
            seen.add(item);
        }
    }
    return seen.size > 0 ? Array.from(seen) : [...fallback];
}
function normalizeToolList(value, fallback) {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const seen = new Set();
    const pushTool = (toolName) => {
        if (!seen.has(toolName)) {
            seen.add(toolName);
        }
    };
    for (const item of value) {
        const normalized = String(item);
        if (normalized === LEGACY_REPO_SEARCH_TOOL_ALIAS) {
            for (const repoToolName of exports.REPO_SEARCH_TOOLS) {
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
            if (PRESET_TOOL_NAME_SET.has(mappedToolName)) {
                pushTool(mappedToolName);
            }
        }
    }
    return seen.size > 0 ? Array.from(seen) : [...fallback];
}
function normalizeNullableInteger(value, fallback) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getLegacyExecutionFamily(record) {
    return isExecutionFamily(record.executionFamily) ? record.executionFamily : null;
}
function getPresetKindFromRecord(record, fallback) {
    if (isPresetKind(record.presetKind)) {
        return record.presetKind;
    }
    return getLegacyExecutionFamily(record) || fallback;
}
function getOperationModeFromRecord(record, fallback, presetKind) {
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
function buildPreset(input) {
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
const BUILTIN_PRESETS = [
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
];
const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
function normalizePresetRecord(input, fallback) {
    const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : {});
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
        includeAgentsMd: record.includeAgentsMd === undefined ? fallback.includeAgentsMd : Boolean(record.includeAgentsMd),
        includeRepoFileListing: record.includeRepoFileListing === undefined ? fallback.includeRepoFileListing : Boolean(record.includeRepoFileListing),
        repoRootRequired: record.repoRootRequired === undefined ? fallback.repoRootRequired : Boolean(record.repoRootRequired),
        maxTurns: normalizeNullableInteger(record.maxTurns, fallback.maxTurns),
    });
}
function normalizeUserPreset(input) {
    const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : null);
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
        includeAgentsMd: record.includeAgentsMd === undefined ? true : Boolean(record.includeAgentsMd),
        includeRepoFileListing: record.includeRepoFileListing === undefined ? true : Boolean(record.includeRepoFileListing),
        repoRootRequired: record.repoRootRequired === undefined ? (presetKind === 'plan' || presetKind === 'repo-search') : Boolean(record.repoRootRequired),
        maxTurns: normalizeNullableInteger(record.maxTurns, presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
    });
}
function getDefaultOperationModeAllowedTools() {
    return {
        summary: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary],
        'read-only': [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']],
        full: [...DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full],
    };
}
function normalizeOperationModeAllowedTools(input) {
    const record = (input && typeof input === 'object' && !Array.isArray(input) ? input : {});
    const summaryTools = normalizeToolList(record.summary, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary);
    if (summaryTools.includes('find_text')
        && summaryTools.includes('read_lines')
        && summaryTools.includes('json_filter')
        && !summaryTools.includes('json_get')) {
        summaryTools.push('json_get');
    }
    return {
        summary: summaryTools,
        'read-only': normalizeToolList(record['read-only'], DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']),
        full: normalizeToolList(record.full, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full),
    };
}
function resolvePresetAllowedTools(preset, operationModeAllowedTools) {
    const modeAllowed = new Set(operationModeAllowedTools[preset.operationMode] || []);
    return preset.allowedTools.filter((tool) => modeAllowed.has(tool));
}
function getBuiltinPresets() {
    return BUILTIN_PRESETS.map((preset) => buildPreset(preset));
}
function normalizePresets(input) {
    const presetsById = new Map();
    const overlays = Array.isArray(input) ? input : [];
    const overlayById = new Map();
    for (const item of overlays) {
        const record = (item && typeof item === 'object' && !Array.isArray(item) ? item : null);
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
function findPresetById(presets, presetId) {
    const normalizedId = normalizePresetId(presetId);
    if (!normalizedId) {
        return null;
    }
    return presets.find((preset) => preset.id === normalizedId) || null;
}
function getConfigPresets(config) {
    const record = (config && typeof config === 'object' && !Array.isArray(config) ? config : {});
    return normalizePresets(record.Presets);
}
function getPresetsForSurface(presets, surface) {
    return presets.filter((preset) => preset.surfaces.includes(surface));
}
function resolveSummaryPreset(presets) {
    return presets.find((preset) => preset.presetKind === 'summary' && preset.useForSummary)
        || presets.find((preset) => preset.id === 'summary')
        || normalizePresets([]).find((preset) => preset.id === 'summary');
}
function getPresetExecutionFamily(presetId, presets) {
    return findPresetById(presets, presetId)?.executionFamily || 'chat';
}
function getPresetKind(presetId, presets) {
    return findPresetById(presets, presetId)?.presetKind || 'chat';
}
function getPresetExecutionOperationMode(presetId, presets) {
    return findPresetById(presets, presetId)?.operationMode || 'summary';
}
function mapLegacyModeToPresetId(mode) {
    return mode === 'plan' || mode === 'repo-search' ? mode : 'chat';
}
function mapPresetIdToLegacyMode(presetId, presets) {
    const presetKind = presets ? getPresetKind(presetId, presets) : (presetId === 'plan' || presetId === 'repo-search' ? presetId : 'chat');
    return presetKind === 'plan' || presetKind === 'repo-search' ? presetKind : 'chat';
}
function getPresetSurfaceOptions() {
    return [...PRESET_SURFACES];
}
function isBuiltinPresetId(value) {
    return BUILTIN_PRESET_IDS.has(normalizePresetId(value));
}
