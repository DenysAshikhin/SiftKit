import type { Dict } from '../lib/types.js';
import { normalizeWindowsPath as normalizeWindowsPathShared } from '../lib/paths.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  type SiftPreset,
} from '../presets.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';

export const DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
export const DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
export const FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k.ps1';
export const BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k-thinking.ps1';
export const DEFAULT_LLAMA_STARTUP_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\start-qwen35-9b-q8-200k-thinking-managed.ps1';
export const DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';

export const MAX_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
export const DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
export const DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS = 2_000;
export const DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS = 1_000;

export const RUNTIME_OWNED_LLAMA_CPP_KEYS: readonly string[] = [
  'BaseUrl',
  'NumCtx',
  'ModelPath',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'MaxTokens',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'Reasoning',
];

export function getDefaultConfig(): Dict {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.',
    LlamaCpp: {
      BaseUrl: DEFAULT_LLAMA_BASE_URL,
      NumCtx: 150000,
      ModelPath: DEFAULT_LLAMA_MODEL_PATH,
      Temperature: 0.7,
      TopP: 0.8,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 1.5,
      RepetitionPenalty: 1.0,
      MaxTokens: 15000,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Runtime: {
      Model: DEFAULT_LLAMA_MODEL,
      LlamaCpp: {
        BaseUrl: DEFAULT_LLAMA_BASE_URL,
        NumCtx: 150000,
        ModelPath: DEFAULT_LLAMA_MODEL_PATH,
        Temperature: 0.7,
        TopP: 0.8,
        TopK: 20,
        MinP: 0.0,
        PresencePenalty: 1.5,
        RepetitionPenalty: 1.0,
        MaxTokens: 15000,
        FlashAttention: true,
        ParallelSlots: 1,
        Reasoning: 'off',
      },
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
      ChunkThresholdRatio: 1.0,
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
        StartupScript: DEFAULT_LLAMA_STARTUP_SCRIPT,
        ShutdownScript: DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
        StartupTimeoutMs: DEFAULT_LLAMA_STARTUP_TIMEOUT_MS,
        HealthcheckTimeoutMs: DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS,
        HealthcheckIntervalMs: DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS,
        VerboseLogging: false,
        VerboseArgs: [],
      },
    },
    OperationModeAllowedTools: getDefaultOperationModeAllowedTools(),
    Presets: normalizePresets([]),
  };
}

export function normalizeWindowsPath(value: unknown): string {
  return normalizeWindowsPathShared(String(value || ''));
}

export function isLegacyManagedStartupScriptPath(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const normalized = normalizeWindowsPath(value.trim());
  return normalized === normalizeWindowsPath(PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT);
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
  merged.LlamaCpp = (merged.LlamaCpp && typeof merged.LlamaCpp === 'object') ? merged.LlamaCpp : {};
  merged.Runtime = (merged.Runtime && typeof merged.Runtime === 'object') ? merged.Runtime : {};
  const runtime = merged.Runtime as Dict;
  runtime.LlamaCpp = (runtime.LlamaCpp && typeof runtime.LlamaCpp === 'object') ? runtime.LlamaCpp : {};
  const runtimeLlama = runtime.LlamaCpp as Dict;
  const ollama = merged.Ollama as Dict | undefined;
  if (ollama) {
    if (ollama.BaseUrl !== undefined) {
      runtimeLlama.BaseUrl = runtimeLlama.BaseUrl ?? ollama.BaseUrl;
    }
    if (ollama.NumCtx !== undefined) {
      runtimeLlama.NumCtx = runtimeLlama.NumCtx ?? Number(ollama.NumCtx);
    }
    if (ollama.Temperature !== undefined) {
      runtimeLlama.Temperature = runtimeLlama.Temperature ?? Number(ollama.Temperature);
    }
    if (ollama.TopP !== undefined) {
      runtimeLlama.TopP = runtimeLlama.TopP ?? Number(ollama.TopP);
    }
    if (ollama.TopK !== undefined) {
      runtimeLlama.TopK = runtimeLlama.TopK ?? Number(ollama.TopK);
    }
    if (ollama.MinP !== undefined) {
      runtimeLlama.MinP = runtimeLlama.MinP ?? Number(ollama.MinP);
    }
    if (ollama.PresencePenalty !== undefined) {
      runtimeLlama.PresencePenalty = runtimeLlama.PresencePenalty ?? Number(ollama.PresencePenalty);
    }
    if (ollama.RepetitionPenalty !== undefined) {
      runtimeLlama.RepetitionPenalty = runtimeLlama.RepetitionPenalty ?? Number(ollama.RepetitionPenalty);
    }
    if (Object.prototype.hasOwnProperty.call(ollama, 'NumPredict')) {
      runtimeLlama.MaxTokens = runtimeLlama.MaxTokens ?? ollama.NumPredict;
    }
  }
  delete merged.Ollama;
  delete merged.Paths;
  merged.Server = (merged.Server && typeof merged.Server === 'object') ? merged.Server : {};
  const server = merged.Server as Dict;
  server.LlamaCpp = (server.LlamaCpp && typeof server.LlamaCpp === 'object') ? server.LlamaCpp : {};
  const serverLlama = server.LlamaCpp as Dict;
  if (typeof merged.Model === 'string' && merged.Model.trim() && !runtime.Model) {
    runtime.Model = merged.Model;
  }
  delete merged.Model;
  if ((!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) && typeof runtime.PromptPrefix === 'string' && runtime.PromptPrefix.trim()) {
    merged.PromptPrefix = runtime.PromptPrefix;
  }
  delete runtime.PromptPrefix;
  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = (getDefaultConfig() as Dict).PromptPrefix;
  }
  if (merged.Thresholds && typeof merged.Thresholds === 'object') {
    delete (merged.Thresholds as Dict).MaxInputCharacters;
  }
  const llamaCpp = merged.LlamaCpp as Dict;
  if (llamaCpp && typeof llamaCpp === 'object') {
    for (const key of RUNTIME_OWNED_LLAMA_CPP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(llamaCpp, key)) {
        if (!Object.prototype.hasOwnProperty.call(runtimeLlama, key)) {
          runtimeLlama[key] = llamaCpp[key];
        }
        delete llamaCpp[key];
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'StartupScript')) {
    serverLlama.StartupScript = null;
  }
  if (isLegacyManagedStartupScriptPath(serverLlama.StartupScript)) {
    serverLlama.StartupScript = DEFAULT_LLAMA_STARTUP_SCRIPT;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ShutdownScript')) {
    serverLlama.ShutdownScript = null;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'StartupTimeoutMs')) {
    serverLlama.StartupTimeoutMs = DEFAULT_LLAMA_STARTUP_TIMEOUT_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'HealthcheckTimeoutMs')) {
    serverLlama.HealthcheckTimeoutMs = DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'HealthcheckIntervalMs')) {
    serverLlama.HealthcheckIntervalMs = DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseLogging')) {
    serverLlama.VerboseLogging = false;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseArgs')) {
    serverLlama.VerboseArgs = [];
  }
  serverLlama.VerboseLogging = Boolean(serverLlama.VerboseLogging);
  serverLlama.VerboseArgs = Array.isArray(serverLlama.VerboseArgs)
    ? (serverLlama.VerboseArgs as unknown[])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  merged.OperationModeAllowedTools = normalizeOperationModeAllowedTools(merged.OperationModeAllowedTools);
  merged.Presets = normalizePresets(merged.Presets);
  return merged;
}

type AppConfigRow = {
  version: string;
  backend: string;
  policy_mode: string;
  raw_log_retention: number;
  prompt_prefix: string | null;
  runtime_model: string | null;
  llama_base_url: string | null;
  llama_num_ctx: number | null;
  llama_model_path: string | null;
  llama_temperature: number | null;
  llama_top_p: number | null;
  llama_top_k: number | null;
  llama_min_p: number | null;
  llama_presence_penalty: number | null;
  llama_repetition_penalty: number | null;
  llama_max_tokens: number | null;
  llama_gpu_layers: number | null;
  llama_threads: number | null;
  llama_flash_attention: number | null;
  llama_parallel_slots: number | null;
  llama_reasoning: string | null;
  thresholds_min_characters_for_summary: number;
  thresholds_min_lines_for_summary: number;
  interactive_enabled: number;
  interactive_wrapped_commands_json: string;
  interactive_idle_timeout_ms: number;
  interactive_max_transcript_characters: number;
  interactive_transcript_retention: number;
  server_startup_script: string | null;
  server_shutdown_script: string | null;
  server_startup_timeout_ms: number | null;
  server_healthcheck_timeout_ms: number | null;
  server_healthcheck_interval_ms: number | null;
  server_verbose_logging: number | null;
  server_verbose_args_json: string;
  operation_mode_allowed_tools_json: string;
  presets_json: string;
};

function toNullableInteger(value: unknown): number | null {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Math.trunc(Number(value));
}

function toNullableNumber(value: unknown): number | null {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Number(value);
}

function toNullableBooleanInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

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

function normalizeConfigToRow(config: Dict): AppConfigRow {
  const normalized = normalizeConfig(config);
  const runtime = (normalized.Runtime as Dict | undefined) || {};
  const runtimeLlama = getCompatRuntimeLlamaCpp(normalized);
  const thresholds = (normalized.Thresholds as Dict | undefined) || {};
  const interactive = (normalized.Interactive as Dict | undefined) || {};
  const server = (normalized.Server as Dict | undefined) || {};
  const serverLlama = (server.LlamaCpp as Dict | undefined) || {};

  return {
    version: String(normalized.Version || '0.1.0'),
    backend: String(normalized.Backend || 'llama.cpp'),
    policy_mode: String(normalized.PolicyMode || 'conservative'),
    raw_log_retention: normalized.RawLogRetention === false ? 0 : 1,
    prompt_prefix: typeof normalized.PromptPrefix === 'string' ? normalized.PromptPrefix : null,
    runtime_model: typeof runtime.Model === 'string' && runtime.Model.trim() ? runtime.Model.trim() : null,
    llama_base_url: typeof runtimeLlama.BaseUrl === 'string' && runtimeLlama.BaseUrl.trim() ? runtimeLlama.BaseUrl.trim() : null,
    llama_num_ctx: toNullableInteger(runtimeLlama.NumCtx),
    llama_model_path: typeof runtimeLlama.ModelPath === 'string' && runtimeLlama.ModelPath.trim() ? runtimeLlama.ModelPath.trim() : null,
    llama_temperature: toNullableNumber(runtimeLlama.Temperature),
    llama_top_p: toNullableNumber(runtimeLlama.TopP),
    llama_top_k: toNullableInteger(runtimeLlama.TopK),
    llama_min_p: toNullableNumber(runtimeLlama.MinP),
    llama_presence_penalty: toNullableNumber(runtimeLlama.PresencePenalty),
    llama_repetition_penalty: toNullableNumber(runtimeLlama.RepetitionPenalty),
    llama_max_tokens: toNullableInteger(runtimeLlama.MaxTokens),
    llama_gpu_layers: toNullableInteger(runtimeLlama.GpuLayers),
    llama_threads: toNullableInteger(runtimeLlama.Threads),
    llama_flash_attention: toNullableBooleanInteger(runtimeLlama.FlashAttention),
    llama_parallel_slots: toNullableInteger(runtimeLlama.ParallelSlots),
    llama_reasoning: typeof runtimeLlama.Reasoning === 'string' && runtimeLlama.Reasoning.trim() ? runtimeLlama.Reasoning.trim() : null,
    thresholds_min_characters_for_summary: getFinitePositiveInteger(thresholds.MinCharactersForSummary, 500),
    thresholds_min_lines_for_summary: getFinitePositiveInteger(thresholds.MinLinesForSummary, 16),
    interactive_enabled: interactive.Enabled === false ? 0 : 1,
    interactive_wrapped_commands_json: JSON.stringify(
      Array.isArray(interactive.WrappedCommands) ? interactive.WrappedCommands : ['git', 'less', 'vim', 'sqlite3']
    ),
    interactive_idle_timeout_ms: getFinitePositiveInteger(interactive.IdleTimeoutMs, 900000),
    interactive_max_transcript_characters: getFinitePositiveInteger(interactive.MaxTranscriptCharacters, 60000),
    interactive_transcript_retention: interactive.TranscriptRetention === false ? 0 : 1,
    server_startup_script: typeof serverLlama.StartupScript === 'string' && serverLlama.StartupScript.trim()
      ? serverLlama.StartupScript.trim()
      : null,
    server_shutdown_script: typeof serverLlama.ShutdownScript === 'string' && serverLlama.ShutdownScript.trim()
      ? serverLlama.ShutdownScript.trim()
      : null,
    server_startup_timeout_ms: toNullableInteger(serverLlama.StartupTimeoutMs),
    server_healthcheck_timeout_ms: toNullableInteger(serverLlama.HealthcheckTimeoutMs),
    server_healthcheck_interval_ms: toNullableInteger(serverLlama.HealthcheckIntervalMs),
    server_verbose_logging: toNullableBooleanInteger(serverLlama.VerboseLogging),
    server_verbose_args_json: JSON.stringify(
      Array.isArray(serverLlama.VerboseArgs) ? serverLlama.VerboseArgs : []
    ),
    operation_mode_allowed_tools_json: JSON.stringify(
      normalizeOperationModeAllowedTools(normalized.OperationModeAllowedTools)
    ),
    presets_json: JSON.stringify(normalizePresets(normalized.Presets)),
  };
}

function rowToConfig(row: AppConfigRow): Dict {
  const runtimeLlama: Dict = {
    BaseUrl: row.llama_base_url,
    NumCtx: row.llama_num_ctx,
    ModelPath: row.llama_model_path,
    Temperature: row.llama_temperature,
    TopP: row.llama_top_p,
    TopK: row.llama_top_k,
    MinP: row.llama_min_p,
    PresencePenalty: row.llama_presence_penalty,
    RepetitionPenalty: row.llama_repetition_penalty,
    MaxTokens: row.llama_max_tokens,
    GpuLayers: row.llama_gpu_layers,
    Threads: row.llama_threads,
    FlashAttention: row.llama_flash_attention === null ? null : row.llama_flash_attention === 1,
    ParallelSlots: row.llama_parallel_slots,
    Reasoning: row.llama_reasoning,
  };
  return normalizeConfig({
    Version: row.version,
    Backend: row.backend,
    PolicyMode: row.policy_mode,
    RawLogRetention: row.raw_log_retention === 1,
    PromptPrefix: row.prompt_prefix,
    LlamaCpp: { ...runtimeLlama },
    Runtime: {
      Model: row.runtime_model,
      LlamaCpp: { ...runtimeLlama },
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
        StartupScript: row.server_startup_script,
        ShutdownScript: row.server_shutdown_script,
        StartupTimeoutMs: row.server_startup_timeout_ms,
        HealthcheckTimeoutMs: row.server_healthcheck_timeout_ms,
        HealthcheckIntervalMs: row.server_healthcheck_interval_ms,
        VerboseLogging: row.server_verbose_logging === null ? false : row.server_verbose_logging === 1,
        VerboseArgs: parseJsonArray(row.server_verbose_args_json),
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
      prompt_prefix,
      runtime_model,
      llama_base_url,
      llama_num_ctx,
      llama_model_path,
      llama_temperature,
      llama_top_p,
      llama_top_k,
      llama_min_p,
      llama_presence_penalty,
      llama_repetition_penalty,
      llama_max_tokens,
      llama_gpu_layers,
      llama_threads,
      llama_flash_attention,
      llama_parallel_slots,
      llama_reasoning,
      thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary,
      interactive_enabled,
      interactive_wrapped_commands_json,
      interactive_idle_timeout_ms,
      interactive_max_transcript_characters,
      interactive_transcript_retention,
      server_startup_script,
      server_shutdown_script,
      server_startup_timeout_ms,
      server_healthcheck_timeout_ms,
      server_healthcheck_interval_ms,
      server_verbose_logging,
      server_verbose_args_json,
      operation_mode_allowed_tools_json,
      presets_json
    FROM app_config
    WHERE id = 1
  `).get() as AppConfigRow | undefined;
  return row || null;
}

function writeConfigRow(databasePath: string, row: AppConfigRow): void {
  const database = getRuntimeDatabase(databasePath);
  database.prepare(`
    INSERT INTO app_config (
      id,
      version,
      backend,
      policy_mode,
      raw_log_retention,
      prompt_prefix,
      runtime_model,
      llama_base_url,
      llama_num_ctx,
      llama_model_path,
      llama_temperature,
      llama_top_p,
      llama_top_k,
      llama_min_p,
      llama_presence_penalty,
      llama_repetition_penalty,
      llama_max_tokens,
      llama_gpu_layers,
      llama_threads,
      llama_flash_attention,
      llama_parallel_slots,
      llama_reasoning,
      thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary,
      interactive_enabled,
      interactive_wrapped_commands_json,
      interactive_idle_timeout_ms,
      interactive_max_transcript_characters,
      interactive_transcript_retention,
      server_startup_script,
      server_shutdown_script,
      server_startup_timeout_ms,
      server_healthcheck_timeout_ms,
      server_healthcheck_interval_ms,
      server_verbose_logging,
      server_verbose_args_json,
      operation_mode_allowed_tools_json,
      presets_json,
      updated_at_utc
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      backend = excluded.backend,
      policy_mode = excluded.policy_mode,
      raw_log_retention = excluded.raw_log_retention,
      prompt_prefix = excluded.prompt_prefix,
      runtime_model = excluded.runtime_model,
      llama_base_url = excluded.llama_base_url,
      llama_num_ctx = excluded.llama_num_ctx,
      llama_model_path = excluded.llama_model_path,
      llama_temperature = excluded.llama_temperature,
      llama_top_p = excluded.llama_top_p,
      llama_top_k = excluded.llama_top_k,
      llama_min_p = excluded.llama_min_p,
      llama_presence_penalty = excluded.llama_presence_penalty,
      llama_repetition_penalty = excluded.llama_repetition_penalty,
      llama_max_tokens = excluded.llama_max_tokens,
      llama_gpu_layers = excluded.llama_gpu_layers,
      llama_threads = excluded.llama_threads,
      llama_flash_attention = excluded.llama_flash_attention,
      llama_parallel_slots = excluded.llama_parallel_slots,
      llama_reasoning = excluded.llama_reasoning,
      thresholds_min_characters_for_summary = excluded.thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary = excluded.thresholds_min_lines_for_summary,
      interactive_enabled = excluded.interactive_enabled,
      interactive_wrapped_commands_json = excluded.interactive_wrapped_commands_json,
      interactive_idle_timeout_ms = excluded.interactive_idle_timeout_ms,
      interactive_max_transcript_characters = excluded.interactive_max_transcript_characters,
      interactive_transcript_retention = excluded.interactive_transcript_retention,
      server_startup_script = excluded.server_startup_script,
      server_shutdown_script = excluded.server_shutdown_script,
      server_startup_timeout_ms = excluded.server_startup_timeout_ms,
      server_healthcheck_timeout_ms = excluded.server_healthcheck_timeout_ms,
      server_healthcheck_interval_ms = excluded.server_healthcheck_interval_ms,
      server_verbose_logging = excluded.server_verbose_logging,
      server_verbose_args_json = excluded.server_verbose_args_json,
      operation_mode_allowed_tools_json = excluded.operation_mode_allowed_tools_json,
      presets_json = excluded.presets_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    row.version,
    row.backend,
    row.policy_mode,
    row.raw_log_retention,
    row.prompt_prefix,
    row.runtime_model,
    row.llama_base_url,
    row.llama_num_ctx,
    row.llama_model_path,
    row.llama_temperature,
    row.llama_top_p,
    row.llama_top_k,
    row.llama_min_p,
    row.llama_presence_penalty,
    row.llama_repetition_penalty,
    row.llama_max_tokens,
    row.llama_gpu_layers,
    row.llama_threads,
    row.llama_flash_attention,
    row.llama_parallel_slots,
    row.llama_reasoning,
    row.thresholds_min_characters_for_summary,
    row.thresholds_min_lines_for_summary,
    row.interactive_enabled,
    row.interactive_wrapped_commands_json,
    row.interactive_idle_timeout_ms,
    row.interactive_max_transcript_characters,
    row.interactive_transcript_retention,
    row.server_startup_script,
    row.server_shutdown_script,
    row.server_startup_timeout_ms,
    row.server_healthcheck_timeout_ms,
    row.server_healthcheck_interval_ms,
    row.server_verbose_logging,
    row.server_verbose_args_json,
    row.operation_mode_allowed_tools_json,
    row.presets_json,
    new Date().toISOString(),
  );
}

export function readConfig(configPath: string): Dict {
  const existingRow = readConfigRow(configPath);
  if (existingRow) {
    return rowToConfig(existingRow);
  }
  const fallback = normalizeConfig({});
  writeConfigRow(configPath, normalizeConfigToRow(fallback));
  return fallback;
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

type ManagedLlamaConfig = {
  StartupScript: string | null;
  ShutdownScript: string | null;
  StartupTimeoutMs: number;
  HealthcheckTimeoutMs: number;
  HealthcheckIntervalMs: number;
  VerboseLogging: boolean;
  VerboseArgs: string[];
};

export function getCompatRuntimeLlamaCpp(config: unknown): Dict {
  const cfg = (config ?? {}) as Dict;
  const runtime = (cfg.Runtime ?? {}) as Dict;
  const runtimeLlama = runtime.LlamaCpp;
  if (runtimeLlama && typeof runtimeLlama === 'object') {
    return runtimeLlama as Dict;
  }
  const llama = cfg.LlamaCpp;
  if (llama && typeof llama === 'object') {
    return llama as Dict;
  }
  return {};
}

export function getLlamaBaseUrl(config: unknown): string | null {
  const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
  return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : null;
}

export function getManagedLlamaConfig(config: unknown): ManagedLlamaConfig {
  const defaults = (getDefaultConfig().Server as Dict).LlamaCpp as Dict;
  const cfg = (config ?? {}) as Dict;
  const srv = (cfg.Server ?? {}) as Dict;
  const serverLlama = (srv.LlamaCpp ?? {}) as Dict;
  return {
    StartupScript: typeof serverLlama.StartupScript === 'string' && serverLlama.StartupScript.trim() ? serverLlama.StartupScript.trim() : null,
    ShutdownScript: typeof serverLlama.ShutdownScript === 'string' && serverLlama.ShutdownScript.trim() ? serverLlama.ShutdownScript.trim() : null,
    StartupTimeoutMs: getManagedStartupTimeoutMs(serverLlama.StartupTimeoutMs, Number(defaults.StartupTimeoutMs)),
    HealthcheckTimeoutMs: getFinitePositiveInteger(serverLlama.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs)),
    HealthcheckIntervalMs: getFinitePositiveInteger(serverLlama.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs)),
    VerboseLogging: Boolean(serverLlama.VerboseLogging),
    VerboseArgs: Array.isArray(serverLlama.VerboseArgs)
      ? (serverLlama.VerboseArgs as unknown[])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
      : [],
  };
}

export type { ManagedLlamaConfig };
