import type { Dict } from '../lib/types.js';
import { normalizeWindowsPath as normalizeWindowsPathShared } from '../lib/paths.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  type SiftPreset,
} from '../presets.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { readRuntimeLaunchSnapshot, type RuntimeLaunchSnapshot } from './runtime-launch-snapshot.js';

export const DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
export const DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const DEFAULT_LLAMA_EXECUTABLE_PATH = 'C:\\Users\\denys\\Documents\\GitHub\\llamacpp\\llama-server.exe';
export const DEFAULT_LLAMA_BIND_HOST = '127.0.0.1';
export const DEFAULT_LLAMA_PORT = 8097;
export const DEFAULT_LLAMA_GPU_LAYERS = 999;
export const DEFAULT_LLAMA_BATCH_SIZE = 512;
export const DEFAULT_LLAMA_UBATCH_SIZE = 512;
export const DEFAULT_LLAMA_CACHE_RAM = 8192;
export const DEFAULT_LLAMA_KV_CACHE_QUANTIZATION = 'f16';
export const DEFAULT_LLAMA_REASONING_BUDGET = 10_000;
export const DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE = 'Thinking budget exhausted. You have to provide the answer now.';

export const MAX_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
export const DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
export const DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS = 2_000;
export const DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS = 1_000;
export const DEFAULT_LLAMA_SLEEP_IDLE_SECONDS = 600;

const MANAGED_LLAMA_SPECULATIVE_TYPES = ['draft-simple', 'draft-eagle3', 'draft-mtp', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'] as const;

const DEFAULT_MANAGED_LLAMA_PRESET: Dict = {
  id: 'default',
  label: 'Default',
  Model: DEFAULT_LLAMA_MODEL,
  ExternalServerEnabled: false,
  ExecutablePath: null,
  BaseUrl: DEFAULT_LLAMA_BASE_URL,
  BindHost: DEFAULT_LLAMA_BIND_HOST,
  Port: DEFAULT_LLAMA_PORT,
  ModelPath: null,
  NumCtx: 150000,
  GpuLayers: DEFAULT_LLAMA_GPU_LAYERS,
  Threads: -1,
  NcpuMoe: 0,
  FlashAttention: true,
  ParallelSlots: 1,
  BatchSize: DEFAULT_LLAMA_BATCH_SIZE,
  UBatchSize: DEFAULT_LLAMA_UBATCH_SIZE,
  CacheRam: DEFAULT_LLAMA_CACHE_RAM,
  KvCacheQuantization: DEFAULT_LLAMA_KV_CACHE_QUANTIZATION,
  MaxTokens: 15000,
  Temperature: 0.7,
  TopP: 0.8,
  TopK: 20,
  MinP: 0.0,
  PresencePenalty: 1.5,
  RepetitionPenalty: 1.0,
  Reasoning: 'off',
  ReasoningContent: false,
  PreserveThinking: false,
  SpeculativeEnabled: false,
  SpeculativeType: 'ngram-map-k',
  SpeculativeMtpEnabled: false,
  SpeculativeNgramSizeN: 8,
  SpeculativeNgramSizeM: 16,
  SpeculativeNgramMinHits: 2,
  SpeculativeNgramModNMatch: 24,
  SpeculativeNgramModNMin: 4,
  SpeculativeNgramModNMax: 16,
  SpeculativeDraftMax: 16,
  SpeculativeDraftMin: 4,
  ReasoningBudget: DEFAULT_LLAMA_REASONING_BUDGET,
  ReasoningBudgetMessage: DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
  StartupTimeoutMs: DEFAULT_LLAMA_STARTUP_TIMEOUT_MS,
  HealthcheckTimeoutMs: DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS,
  HealthcheckIntervalMs: DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS,
  SleepIdleSeconds: DEFAULT_LLAMA_SLEEP_IDLE_SECONDS,
  VerboseLogging: false,
};

export function getDefaultConfig(): Dict {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    IncludeRepoFileListing: true,
    PromptPrefix: 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.',
    Runtime: {
      Model: DEFAULT_LLAMA_MODEL,
      LlamaCpp: {},
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
    Server: {
      LlamaCpp: {
        Presets: [{ ...DEFAULT_MANAGED_LLAMA_PRESET }],
        ActivePresetId: String(DEFAULT_MANAGED_LLAMA_PRESET.id),
      },
    },
    OperationModeAllowedTools: getDefaultOperationModeAllowedTools(),
    Presets: normalizePresets([]),
  };
}

export function normalizeWindowsPath(value: unknown): string {
  return normalizeWindowsPathShared(String(value || ''));
}

function getManagedSpeculativeType(value: unknown, fallback: string): string {
  return MANAGED_LLAMA_SPECULATIVE_TYPES.includes(String(value || '') as typeof MANAGED_LLAMA_SPECULATIVE_TYPES[number])
    ? String(value)
    : fallback;
}

export function mergeConfig(baseValue: unknown, patchValue: unknown): unknown {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }
  if (
    baseValue &&
    patchValue &&
    typeof baseValue === 'object' &&
    typeof patchValue === 'object' &&
    !Array.isArray(baseValue) &&
    !Array.isArray(patchValue)
  ) {
    const merged: Dict = { ...(baseValue as Dict) };
    for (const [key, value] of Object.entries(patchValue as Dict)) {
      if (key === 'Paths') {
        continue;
      }
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }
  return patchValue;
}

export function normalizeConfig(input: unknown): Dict {
  const merged = mergeConfig(getDefaultConfig(), input || {}) as Dict;
  if (merged.Backend === 'ollama') {
    merged.Backend = 'llama.cpp';
  }
  delete merged.Paths;
  delete merged.Ollama;
  delete merged.Model;
  delete merged.LlamaCpp;

  merged.Runtime = (merged.Runtime && typeof merged.Runtime === 'object' && !Array.isArray(merged.Runtime))
    ? merged.Runtime : {};
  const runtime = merged.Runtime as Dict;
  delete runtime.PromptPrefix;
  runtime.Model = getNullableTrimmedString(runtime.Model);
  runtime.LlamaCpp = (runtime.LlamaCpp && typeof runtime.LlamaCpp === 'object' && !Array.isArray(runtime.LlamaCpp))
    ? runtime.LlamaCpp : {};

  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = (getDefaultConfig() as Dict).PromptPrefix;
  }
  if (merged.Thresholds && typeof merged.Thresholds === 'object') {
    delete (merged.Thresholds as Dict).MaxInputCharacters;
    delete (merged.Thresholds as Dict).ChunkThresholdRatio;
  }

  merged.Server = (merged.Server && typeof merged.Server === 'object' && !Array.isArray(merged.Server))
    ? merged.Server : {};
  const server = merged.Server as Dict;
  const serverLlama = (server.LlamaCpp && typeof server.LlamaCpp === 'object' && !Array.isArray(server.LlamaCpp))
    ? server.LlamaCpp as Dict : {};
  const presets = normalizeManagedLlamaPresetArray(serverLlama.Presets, {});
  const activeId = getNullableTrimmedString(serverLlama.ActivePresetId);
  const activePreset = presets.find((preset) => String(preset.id) === activeId) || presets[0];
  server.LlamaCpp = { Presets: presets, ActivePresetId: String(activePreset.id) };

  merged.OperationModeAllowedTools = normalizeOperationModeAllowedTools(merged.OperationModeAllowedTools);
  merged.Presets = normalizePresets(merged.Presets);
  return merged;
}

type AppConfigRow = {
  version: string;
  backend: string;
  policy_mode: string;
  raw_log_retention: number;
  include_repo_file_listing: number;
  prompt_prefix: string | null;
  runtime_model: string | null;
  thresholds_min_characters_for_summary: number;
  thresholds_min_lines_for_summary: number;
  interactive_enabled: number;
  interactive_wrapped_commands_json: string;
  interactive_idle_timeout_ms: number;
  interactive_max_transcript_characters: number;
  interactive_transcript_retention: number;
  server_llama_presets_json: string;
  server_llama_active_preset_id: string | null;
  server_external_server_enabled: number;
  operation_mode_allowed_tools_json: string;
  presets_json: string;
};

function parseJsonArray(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  } catch {
    return [];
  }
}

function parsePresetArray(text: unknown): SiftPreset[] {
  if (typeof text !== 'string' || !text.trim()) {
    return normalizePresets([]);
  }
  try {
    return normalizePresets(JSON.parse(text) as unknown);
  } catch {
    return normalizePresets([]);
  }
}

function parseOperationModeAllowedTools(text: unknown): ReturnType<typeof normalizeOperationModeAllowedTools> {
  if (typeof text !== 'string' || !text.trim()) {
    return getDefaultOperationModeAllowedTools();
  }
  try {
    return normalizeOperationModeAllowedTools(JSON.parse(text) as unknown);
  } catch {
    return getDefaultOperationModeAllowedTools();
  }
}

function parseManagedLlamaPresetArray(text: unknown): Dict[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Dict => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      : [];
  } catch {
    return [];
  }
}

function normalizeConfigToRow(config: Dict): AppConfigRow {
  const normalized = normalizeConfig(config);
  const runtime = (normalized.Runtime as Dict | undefined) || {};
  const thresholds = (normalized.Thresholds as Dict | undefined) || {};
  const interactive = (normalized.Interactive as Dict | undefined) || {};
  const server = (normalized.Server as Dict | undefined) || {};
  const serverLlama = (server.LlamaCpp as Dict | undefined) || {};

  return {
    version: String(normalized.Version || '0.1.0'),
    backend: String(normalized.Backend || 'llama.cpp'),
    policy_mode: String(normalized.PolicyMode || 'conservative'),
    raw_log_retention: normalized.RawLogRetention === false ? 0 : 1,
    include_repo_file_listing: normalized.IncludeRepoFileListing === false ? 0 : 1,
    prompt_prefix: typeof normalized.PromptPrefix === 'string' ? normalized.PromptPrefix : null,
    runtime_model: typeof runtime.Model === 'string' && runtime.Model.trim() ? runtime.Model.trim() : null,
    thresholds_min_characters_for_summary: getFinitePositiveInteger(thresholds.MinCharactersForSummary, 500),
    thresholds_min_lines_for_summary: getFinitePositiveInteger(thresholds.MinLinesForSummary, 16),
    interactive_enabled: interactive.Enabled === false ? 0 : 1,
    interactive_wrapped_commands_json: JSON.stringify(
      Array.isArray(interactive.WrappedCommands) ? interactive.WrappedCommands : ['git', 'less', 'vim', 'sqlite3']
    ),
    interactive_idle_timeout_ms: getFinitePositiveInteger(interactive.IdleTimeoutMs, 900000),
    interactive_max_transcript_characters: getFinitePositiveInteger(interactive.MaxTranscriptCharacters, 60000),
    interactive_transcript_retention: interactive.TranscriptRetention === false ? 0 : 1,
    server_external_server_enabled: getActiveManagedLlamaPreset(normalized).ExternalServerEnabled === true ? 1 : 0,
    server_llama_presets_json: JSON.stringify(
      Array.isArray(serverLlama.Presets) ? serverLlama.Presets : [],
    ),
    server_llama_active_preset_id: getNullableTrimmedString(serverLlama.ActivePresetId),
    operation_mode_allowed_tools_json: JSON.stringify(
      normalizeOperationModeAllowedTools(normalized.OperationModeAllowedTools)
    ),
    presets_json: JSON.stringify(normalizePresets(normalized.Presets)),
  };
}

function rowToConfig(row: AppConfigRow): Dict {
  return normalizeConfig({
    Version: row.version,
    Backend: row.backend,
    PolicyMode: row.policy_mode,
    RawLogRetention: row.raw_log_retention === 1,
    IncludeRepoFileListing: row.include_repo_file_listing !== 0,
    PromptPrefix: row.prompt_prefix,
    Runtime: {
      Model: row.runtime_model,
      LlamaCpp: {},
    },
    Thresholds: {
      MinCharactersForSummary: row.thresholds_min_characters_for_summary,
      MinLinesForSummary: row.thresholds_min_lines_for_summary,
    },
    Interactive: {
      Enabled: row.interactive_enabled === 1,
      WrappedCommands: parseJsonArray(row.interactive_wrapped_commands_json),
      IdleTimeoutMs: row.interactive_idle_timeout_ms,
      MaxTranscriptCharacters: row.interactive_max_transcript_characters,
      TranscriptRetention: row.interactive_transcript_retention === 1,
    },
    Server: {
      LlamaCpp: {
        Presets: parseManagedLlamaPresetArray(row.server_llama_presets_json),
        ActivePresetId: row.server_llama_active_preset_id,
      },
    },
    OperationModeAllowedTools: parseOperationModeAllowedTools(row.operation_mode_allowed_tools_json),
    Presets: parsePresetArray(row.presets_json),
  });
}

function readConfigRow(databasePath: string): AppConfigRow | null {
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare(`
    SELECT
      version,
      backend,
      policy_mode,
      raw_log_retention,
      include_repo_file_listing,
      prompt_prefix,
      runtime_model,
      thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary,
      interactive_enabled,
      interactive_wrapped_commands_json,
      interactive_idle_timeout_ms,
      interactive_max_transcript_characters,
      interactive_transcript_retention,
      server_llama_presets_json,
      server_llama_active_preset_id,
      server_external_server_enabled,
      operation_mode_allowed_tools_json,
      presets_json
    FROM app_config
    WHERE id = 1
  `).get() as AppConfigRow | undefined;
  return row || null;
}

function writeConfigRow(databasePath: string, row: AppConfigRow): void {
  const database = getRuntimeDatabase(databasePath);
  const columns = [
    'id',
    'version',
    'backend',
    'policy_mode',
    'raw_log_retention',
    'include_repo_file_listing',
    'prompt_prefix',
    'runtime_model',
    'thresholds_min_characters_for_summary',
    'thresholds_min_lines_for_summary',
    'interactive_enabled',
    'interactive_wrapped_commands_json',
    'interactive_idle_timeout_ms',
    'interactive_max_transcript_characters',
    'interactive_transcript_retention',
    'server_llama_presets_json',
    'server_llama_active_preset_id',
    'server_external_server_enabled',
    'operation_mode_allowed_tools_json',
    'presets_json',
    'updated_at_utc',
  ];
  const values = columns.map((column) => (column === 'id' ? '1' : `@${column}`));
  const assignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);
  database.prepare(`
    INSERT INTO app_config (
      ${columns.join(',\n      ')}
    ) VALUES (
      ${values.join(',\n      ')}
    )
    ON CONFLICT(id) DO UPDATE SET
      ${assignments.join(',\n      ')}
  `).run({
    ...row,
    updated_at_utc: new Date().toISOString(),
  });
}

export function readConfig(configPath: string): Dict {
  const existingRow = readConfigRow(configPath);
  const config = existingRow
    ? rowToConfig(existingRow)
    : (() => {
      const fallback = normalizeConfig({});
      writeConfigRow(configPath, normalizeConfigToRow(fallback));
      return fallback;
    })();
  // The launch snapshot pins the values the managed server was actually
  // started with (which can diverge from the active preset if the user edits
  // the preset afterwards). Before any launch there is no snapshot, so the
  // active preset is the best available source for the runtime config.
  const snapshot = readRuntimeLaunchSnapshot(configPath) ?? buildRuntimeLaunchSnapshot(config);
  const runtime = (config.Runtime as Dict | undefined) ?? {};
  runtime.Model = snapshot.Model;
  runtime.LlamaCpp = snapshot.LlamaCpp as unknown as Dict;
  config.Runtime = runtime;
  return config;
}

/**
 * Builds the runtime launch snapshot (resolved `Model` + `Runtime.LlamaCpp`)
 * from the active managed-llama preset. Written verbatim to `runtime_metadata`
 * when the managed server boots; also used as the runtime fallback before any
 * launch has happened.
 */
export function buildRuntimeLaunchSnapshot(config: unknown): RuntimeLaunchSnapshot {
  const managed = getManagedLlamaConfig(config);
  return {
    Model: managed.Model ?? null,
    LlamaCpp: {
      BaseUrl: getManagedLlamaInternalBaseUrl(config),
      NumCtx: managed.NumCtx,
      ModelPath: managed.ModelPath,
      Temperature: managed.Temperature,
      TopP: managed.TopP,
      TopK: managed.TopK,
      MinP: managed.MinP,
      PresencePenalty: managed.PresencePenalty,
      RepetitionPenalty: managed.RepetitionPenalty,
      MaxTokens: managed.MaxTokens,
      GpuLayers: managed.GpuLayers,
      Threads: managed.Threads,
      NcpuMoe: managed.NcpuMoe,
      FlashAttention: managed.FlashAttention,
      ParallelSlots: managed.ParallelSlots,
      Reasoning: managed.Reasoning,
    },
  };
}

export function writeConfig(configPath: string, config: Dict): void {
  writeConfigRow(configPath, normalizeConfigToRow(config));
}

export function getFinitePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getManagedStartupTimeoutMs(value: unknown, fallback: number): number {
  return Math.min(getFinitePositiveInteger(value, fallback), MAX_LLAMA_STARTUP_TIMEOUT_MS);
}

function getFiniteInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSpeculativeInteger(value: unknown, fallback: number, requirePositive: boolean): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed === -1) {
    return -1;
  }
  return !requirePositive || parsed > 0 ? parsed : fallback;
}

function getFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNullableTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deriveModelIdFromPath(value: unknown): string | null {
  const normalized = getNullableTrimmedString(value);
  if (!normalized) {
    return null;
  }
  const lastSeparatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return lastSeparatorIndex >= 0 ? normalized.slice(lastSeparatorIndex + 1) : normalized;
}

function getManagedKvCacheQuantization(value: unknown, fallback: string): string {
  const normalized = getNullableTrimmedString(value);
  if (
    normalized === 'f32'
    || normalized === 'f16'
    || normalized === 'bf16'
    || normalized === 'q8_0'
    || normalized === 'q4_0'
    || normalized === 'q4_1'
    || normalized === 'iq4_nl'
    || normalized === 'q5_0'
    || normalized === 'q5_1'
    || normalized === 'q8_0/q4_1'
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeManagedLlamaPresetRecord(input: unknown, fallbackId: string, fallbackLabel: string): Dict {
  const record = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Dict : {};
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    Model: getNullableTrimmedString(record.Model) || deriveModelIdFromPath(record.ModelPath) || DEFAULT_LLAMA_MODEL,
    ...resolveManagedLlamaSettings(record),
  };
}

function normalizeManagedLlamaPresetArray(value: unknown, fallbackSource: Dict): Dict[] {
  const records = Array.isArray(value) ? value : [];
  const normalized: Dict[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const candidate = normalizeManagedLlamaPresetRecord(record, `preset-${index + 1}`, `Preset ${index + 1}`);
    if (seen.has(String(candidate.id))) {
      continue;
    }
    seen.add(String(candidate.id));
    normalized.push(candidate);
  }
  if (normalized.length > 0) {
    return normalized;
  }
  return [normalizeManagedLlamaPresetRecord({
    id: 'default',
    label: 'Default',
    ...fallbackSource,
  }, 'default', 'Default')];
}

type ManagedLlamaConfig = {
  Model?: string | null;
  ExternalServerEnabled: boolean;
  ExecutablePath: string | null;
  BaseUrl: string | null;
  BindHost: string;
  Port: number;
  ModelPath: string | null;
  NumCtx: number;
  GpuLayers: number;
  Threads: number;
  NcpuMoe: number;
  FlashAttention: boolean;
  ParallelSlots: number;
  BatchSize: number;
  UBatchSize: number;
  CacheRam: number;
  KvCacheQuantization: string;
  MaxTokens: number;
  Temperature: number;
  TopP: number;
  TopK: number;
  MinP: number;
  PresencePenalty: number;
  RepetitionPenalty: number;
  Reasoning: 'on' | 'off';
  ReasoningContent: boolean;
  PreserveThinking: boolean;
  SpeculativeEnabled: boolean;
  SpeculativeType: string;
  SpeculativeMtpEnabled: boolean;
  SpeculativeNgramSizeN: number;
  SpeculativeNgramSizeM: number;
  SpeculativeNgramMinHits: number;
  SpeculativeNgramModNMatch: number;
  SpeculativeNgramModNMin: number;
  SpeculativeNgramModNMax: number;
  SpeculativeDraftMax: number;
  SpeculativeDraftMin: number;
  ReasoningBudget: number;
  ReasoningBudgetMessage: string | null;
  StartupTimeoutMs: number;
  HealthcheckTimeoutMs: number;
  HealthcheckIntervalMs: number;
  SleepIdleSeconds: number;
  VerboseLogging: boolean;
};

export function getRuntimeLlamaCpp(config: unknown): Dict {
  const cfg = (config ?? {}) as Dict;
  const runtime = (cfg.Runtime ?? {}) as Dict;
  const runtimeLlama = runtime.LlamaCpp;
  return (runtimeLlama && typeof runtimeLlama === 'object') ? runtimeLlama as Dict : {};
}

export function getLlamaBaseUrl(config: unknown): string | null {
  return getManagedLlamaConfig(config).BaseUrl;
}

/**
 * Returns the URL the host's own SiftKit should use to talk to its managed
 * llama. The configured BaseUrl is what *external* clients (VM SiftKits,
 * other hosts on the LAN) use to reach this llama via the passthrough route.
 * For host-internal calls we want loopback — otherwise we depend on the
 * user-supplied BaseUrl being routable from the host back to itself, which
 * fails when BaseUrl is a stale/wrong LAN IP, when Hyper-V hairpinning is
 * misconfigured, when Windows Firewall blocks the host's own LAN IP, etc.
 *
 * Rules:
 *   - External llama: always BaseUrl (we have no other handle on it).
 *   - Managed llama, BaseUrl is loopback (127.0.0.1 / localhost / ::1): use
 *     BaseUrl as-is so the user's explicit port choice in BaseUrl is honored
 *     even if it doesn't match Server.LlamaCpp.Port (e.g. test scaffolds).
 *   - Managed llama, BaseUrl is non-loopback (or missing): use
 *     http://127.0.0.1:${Port} where Port is the port llama-server was
 *     launched on. This is the fix for stale LAN-IP BaseUrl.
 */
export function getManagedLlamaInternalBaseUrl(config: unknown): string | null {
  const managed = getManagedLlamaConfig(config);
  if (managed.ExternalServerEnabled) {
    return managed.BaseUrl;
  }
  const baseUrl = managed.BaseUrl;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
        return baseUrl;
      }
    } catch {
      // Fall through to the loopback-by-port path below.
    }
  }
  if (!managed.Port || managed.Port <= 0) {
    return baseUrl;
  }
  return `http://127.0.0.1:${managed.Port}`;
}

export function getActiveManagedLlamaPreset(config: unknown): Dict {
  const cfg = (config ?? {}) as Dict;
  const serverLlama = ((cfg.Server as Dict | undefined)?.LlamaCpp ?? {}) as Dict;
  const presets = normalizeManagedLlamaPresetArray(serverLlama.Presets, serverLlama);
  const activeId = getNullableTrimmedString(serverLlama.ActivePresetId);
  return presets.find((preset) => String(preset.id) === activeId) || presets[0];
}

export function getManagedLlamaConfig(config: unknown): ManagedLlamaConfig {
  const preset = getActiveManagedLlamaPreset(config);
  return {
    Model: getNullableTrimmedString(preset.Model),
    ...resolveManagedLlamaSettings(preset),
  };
}

// Pure per-record defaulting: takes ONE flat managed-llama record (a preset
// body) and applies defaults/validation. No preset lookup, so it is safe to
// call from normalizeManagedLlamaPresetRecord without recursion.
function resolveManagedLlamaSettings(serverLlama: Dict): ManagedLlamaConfig {
  const defaults = DEFAULT_MANAGED_LLAMA_PRESET;
  const reasoning = getNullableTrimmedString(serverLlama.Reasoning);
  const reasoningEnabled = reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && serverLlama.ReasoningContent === true;
  return {
    ExternalServerEnabled: serverLlama.ExternalServerEnabled === true,
    ExecutablePath: getNullableTrimmedString(serverLlama.ExecutablePath)
      || getNullableTrimmedString(defaults.ExecutablePath),
    BaseUrl: getNullableTrimmedString(serverLlama.BaseUrl) || getNullableTrimmedString(defaults.BaseUrl),
    BindHost: getNullableTrimmedString(serverLlama.BindHost) || String(defaults.BindHost || DEFAULT_LLAMA_BIND_HOST),
    Port: getFinitePositiveInteger(serverLlama.Port, Number(defaults.Port ?? DEFAULT_LLAMA_PORT)),
    ModelPath: getNullableTrimmedString(serverLlama.ModelPath) || getNullableTrimmedString(defaults.ModelPath),
    NumCtx: getFinitePositiveInteger(serverLlama.NumCtx, Number(defaults.NumCtx ?? 150000)),
    GpuLayers: getFiniteInteger(serverLlama.GpuLayers, Number(defaults.GpuLayers ?? DEFAULT_LLAMA_GPU_LAYERS)),
    Threads: getFiniteInteger(serverLlama.Threads, Number(defaults.Threads ?? -1)),
    NcpuMoe: getFiniteInteger(serverLlama.NcpuMoe, Number(defaults.NcpuMoe ?? 0)),
    FlashAttention: serverLlama.FlashAttention === null || serverLlama.FlashAttention === undefined
      ? Boolean(defaults.FlashAttention)
      : Boolean(serverLlama.FlashAttention),
    ParallelSlots: getFinitePositiveInteger(serverLlama.ParallelSlots, Number(defaults.ParallelSlots ?? 1)),
    BatchSize: getFinitePositiveInteger(serverLlama.BatchSize, Number(defaults.BatchSize ?? DEFAULT_LLAMA_BATCH_SIZE)),
    UBatchSize: getFinitePositiveInteger(serverLlama.UBatchSize, Number(defaults.UBatchSize ?? DEFAULT_LLAMA_UBATCH_SIZE)),
    CacheRam: getFinitePositiveInteger(serverLlama.CacheRam, Number(defaults.CacheRam ?? DEFAULT_LLAMA_CACHE_RAM)),
    KvCacheQuantization: getManagedKvCacheQuantization(
      serverLlama.KvCacheQuantization,
      String(defaults.KvCacheQuantization ?? DEFAULT_LLAMA_KV_CACHE_QUANTIZATION),
    ),
    MaxTokens: getFinitePositiveInteger(serverLlama.MaxTokens, Number(defaults.MaxTokens ?? 15000)),
    Temperature: getFiniteNumber(serverLlama.Temperature, Number(defaults.Temperature ?? 0.7)),
    TopP: getFiniteNumber(serverLlama.TopP, Number(defaults.TopP ?? 0.8)),
    TopK: getFiniteInteger(serverLlama.TopK, Number(defaults.TopK ?? 20)),
    MinP: getFiniteNumber(serverLlama.MinP, Number(defaults.MinP ?? 0.0)),
    PresencePenalty: getFiniteNumber(serverLlama.PresencePenalty, Number(defaults.PresencePenalty ?? 1.5)),
    RepetitionPenalty: getFiniteNumber(serverLlama.RepetitionPenalty, Number(defaults.RepetitionPenalty ?? 1.0)),
    Reasoning: reasoning === 'on' || reasoning === 'off'
      ? reasoning
      : String(defaults.Reasoning || 'off') as 'on' | 'off',
    ReasoningContent: reasoningContentEnabled,
    PreserveThinking: reasoningContentEnabled && serverLlama.PreserveThinking === true,
    SpeculativeEnabled: serverLlama.SpeculativeEnabled === true,
    SpeculativeType: getManagedSpeculativeType(serverLlama.SpeculativeType, String(defaults.SpeculativeType || 'ngram-map-k')),
    SpeculativeMtpEnabled: serverLlama.SpeculativeMtpEnabled === true,
    SpeculativeNgramSizeN: getSpeculativeInteger(serverLlama.SpeculativeNgramSizeN, Number(defaults.SpeculativeNgramSizeN ?? 8), true),
    SpeculativeNgramSizeM: getSpeculativeInteger(serverLlama.SpeculativeNgramSizeM, Number(defaults.SpeculativeNgramSizeM ?? 16), true),
    SpeculativeNgramMinHits: getSpeculativeInteger(serverLlama.SpeculativeNgramMinHits, Number(defaults.SpeculativeNgramMinHits ?? 2), true),
    SpeculativeNgramModNMatch: getSpeculativeInteger(serverLlama.SpeculativeNgramModNMatch, Number(defaults.SpeculativeNgramModNMatch ?? 24), true),
    SpeculativeNgramModNMin: getSpeculativeInteger(serverLlama.SpeculativeNgramModNMin, Number(defaults.SpeculativeNgramModNMin ?? 4), true),
    SpeculativeNgramModNMax: getSpeculativeInteger(serverLlama.SpeculativeNgramModNMax, Number(defaults.SpeculativeNgramModNMax ?? 16), true),
    SpeculativeDraftMax: getSpeculativeInteger(serverLlama.SpeculativeDraftMax, Number(defaults.SpeculativeDraftMax ?? 16), true),
    SpeculativeDraftMin: getSpeculativeInteger(serverLlama.SpeculativeDraftMin, Number(defaults.SpeculativeDraftMin ?? 4), false),
    ReasoningBudget: getFinitePositiveInteger(serverLlama.ReasoningBudget, Number(defaults.ReasoningBudget ?? DEFAULT_LLAMA_REASONING_BUDGET)),
    ReasoningBudgetMessage: getNullableTrimmedString(serverLlama.ReasoningBudgetMessage)
      || getNullableTrimmedString(defaults.ReasoningBudgetMessage)
      || DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
    StartupTimeoutMs: getManagedStartupTimeoutMs(serverLlama.StartupTimeoutMs, Number(defaults.StartupTimeoutMs)),
    HealthcheckTimeoutMs: getFinitePositiveInteger(serverLlama.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs)),
    HealthcheckIntervalMs: getFinitePositiveInteger(serverLlama.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs)),
    SleepIdleSeconds: getFinitePositiveInteger(serverLlama.SleepIdleSeconds, Number(defaults.SleepIdleSeconds ?? DEFAULT_LLAMA_SLEEP_IDLE_SECONDS)),
    VerboseLogging: Boolean(serverLlama.VerboseLogging),
  };
}

export type { ManagedLlamaConfig };
