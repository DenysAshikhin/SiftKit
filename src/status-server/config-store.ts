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
export const DEFAULT_LLAMA_EXECUTABLE_PATH = 'C:\\Users\\denys\\Documents\\GitHub\\llamacpp\\llama-server.exe';
export const DEFAULT_LLAMA_BIND_HOST = '127.0.0.1';
export const DEFAULT_LLAMA_PORT = 8097;
export const DEFAULT_LLAMA_GPU_LAYERS = 999;
export const DEFAULT_LLAMA_BATCH_SIZE = 512;
export const DEFAULT_LLAMA_UBATCH_SIZE = 512;
export const DEFAULT_LLAMA_CACHE_RAM = 8192;
export const DEFAULT_LLAMA_KV_CACHE_QUANTIZATION = 'f16';
export const DEFAULT_LLAMA_REASONING_BUDGET = 10_000;
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

const MANAGED_LLAMA_RUNTIME_KEYS: readonly string[] = [
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

const MANAGED_LLAMA_FIELD_KEYS: readonly string[] = [
  'ExecutablePath',
  'BaseUrl',
  'BindHost',
  'Port',
  'ModelPath',
  'NumCtx',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'BatchSize',
  'UBatchSize',
  'CacheRam',
  'KvCacheQuantization',
  'MaxTokens',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'Reasoning',
  'ReasoningBudget',
  'StartupTimeoutMs',
  'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs',
  'VerboseLogging',
];

const MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS: readonly string[] = [
  'BaseUrl',
  'BindHost',
  'Port',
  'NumCtx',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'BatchSize',
  'UBatchSize',
  'CacheRam',
  'KvCacheQuantization',
  'MaxTokens',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'Reasoning',
  'ReasoningBudget',
  'StartupTimeoutMs',
  'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs',
  'VerboseLogging',
];

export function getDefaultConfig(): Dict {
  const defaultManagedLlamaPreset = {
    id: 'default',
    label: 'Default',
    ExecutablePath: null,
    BaseUrl: DEFAULT_LLAMA_BASE_URL,
    BindHost: DEFAULT_LLAMA_BIND_HOST,
    Port: DEFAULT_LLAMA_PORT,
    ModelPath: null,
    NumCtx: 150000,
    GpuLayers: DEFAULT_LLAMA_GPU_LAYERS,
    Threads: -1,
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
    ReasoningBudget: DEFAULT_LLAMA_REASONING_BUDGET,
    StartupTimeoutMs: DEFAULT_LLAMA_STARTUP_TIMEOUT_MS,
    HealthcheckTimeoutMs: DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS,
    HealthcheckIntervalMs: DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS,
    VerboseLogging: false,
  };
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.',
    LlamaCpp: {
      BaseUrl: DEFAULT_LLAMA_BASE_URL,
      NumCtx: 150000,
      ModelPath: null,
      Temperature: 0.7,
      TopP: 0.8,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 1.5,
      RepetitionPenalty: 1.0,
      MaxTokens: 15000,
      GpuLayers: DEFAULT_LLAMA_GPU_LAYERS,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Runtime: {
      Model: DEFAULT_LLAMA_MODEL,
      LlamaCpp: {
        BaseUrl: DEFAULT_LLAMA_BASE_URL,
        NumCtx: 150000,
        ModelPath: null,
        Temperature: 0.7,
        TopP: 0.8,
        TopK: 20,
        MinP: 0.0,
        PresencePenalty: 1.5,
        RepetitionPenalty: 1.0,
        MaxTokens: 15000,
        GpuLayers: DEFAULT_LLAMA_GPU_LAYERS,
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
        ...defaultManagedLlamaPreset,
        Presets: [defaultManagedLlamaPreset],
        ActivePresetId: defaultManagedLlamaPreset.id,
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
  const inputServerLlama = (
    input
    && typeof input === 'object'
    && !Array.isArray(input)
    && (input as Dict).Server
    && typeof (input as Dict).Server === 'object'
    && !Array.isArray((input as Dict).Server)
    && ((input as Dict).Server as Dict).LlamaCpp
    && typeof ((input as Dict).Server as Dict).LlamaCpp === 'object'
    && !Array.isArray(((input as Dict).Server as Dict).LlamaCpp)
  ) ? (((input as Dict).Server as Dict).LlamaCpp as Dict) : null;
  const preferManagedPresetValues = Boolean(
    inputServerLlama
    && (
      Object.prototype.hasOwnProperty.call(inputServerLlama, 'Presets')
      || Object.prototype.hasOwnProperty.call(inputServerLlama, 'ActivePresetId')
    )
  );
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
  const defaultServerLlama = ((getDefaultConfig().Server as Dict).LlamaCpp || {}) as Dict;
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
  const legacyStartupScript = typeof serverLlama.StartupScript === 'string' && serverLlama.StartupScript.trim()
    ? serverLlama.StartupScript.trim()
    : null;
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ExecutablePath')) {
    serverLlama.ExecutablePath = (
      legacyStartupScript
      && !isLegacyManagedStartupScriptPath(legacyStartupScript)
      && normalizeWindowsPath(legacyStartupScript) !== normalizeWindowsPath(DEFAULT_LLAMA_STARTUP_SCRIPT)
    )
      ? legacyStartupScript
      : null;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'BaseUrl')) {
    serverLlama.BaseUrl = runtimeLlama.BaseUrl ?? DEFAULT_LLAMA_BASE_URL;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'BindHost')) {
    serverLlama.BindHost = DEFAULT_LLAMA_BIND_HOST;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'Port')) {
    serverLlama.Port = DEFAULT_LLAMA_PORT;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ModelPath')) {
    serverLlama.ModelPath = runtimeLlama.ModelPath ?? null;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'NumCtx')) {
    serverLlama.NumCtx = runtimeLlama.NumCtx ?? 150000;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'GpuLayers')) {
    serverLlama.GpuLayers = runtimeLlama.GpuLayers ?? DEFAULT_LLAMA_GPU_LAYERS;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'Threads')) {
    serverLlama.Threads = runtimeLlama.Threads ?? -1;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'FlashAttention')) {
    serverLlama.FlashAttention = runtimeLlama.FlashAttention ?? true;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ParallelSlots')) {
    serverLlama.ParallelSlots = runtimeLlama.ParallelSlots ?? 1;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'BatchSize')) {
    serverLlama.BatchSize = DEFAULT_LLAMA_BATCH_SIZE;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'UBatchSize')) {
    serverLlama.UBatchSize = DEFAULT_LLAMA_UBATCH_SIZE;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'CacheRam')) {
    serverLlama.CacheRam = DEFAULT_LLAMA_CACHE_RAM;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'KvCacheQuantization')) {
    serverLlama.KvCacheQuantization = DEFAULT_LLAMA_KV_CACHE_QUANTIZATION;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'MaxTokens')) {
    serverLlama.MaxTokens = runtimeLlama.MaxTokens ?? 15000;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'Temperature')) {
    serverLlama.Temperature = runtimeLlama.Temperature ?? 0.7;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'TopP')) {
    serverLlama.TopP = runtimeLlama.TopP ?? 0.8;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'TopK')) {
    serverLlama.TopK = runtimeLlama.TopK ?? 20;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'MinP')) {
    serverLlama.MinP = runtimeLlama.MinP ?? 0.0;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'PresencePenalty')) {
    serverLlama.PresencePenalty = runtimeLlama.PresencePenalty ?? 1.5;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'RepetitionPenalty')) {
    serverLlama.RepetitionPenalty = runtimeLlama.RepetitionPenalty ?? 1.0;
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'Reasoning')) {
    serverLlama.Reasoning = runtimeLlama.Reasoning ?? 'off';
  }
  if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ReasoningBudget')) {
    serverLlama.ReasoningBudget = DEFAULT_LLAMA_REASONING_BUDGET;
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
  const managedBlankPlaceholder = (
    getNullableTrimmedString(serverLlama.ExecutablePath) === null
    && getNullableTrimmedString(serverLlama.ModelPath) === null
    && getNullableTrimmedString(serverLlama.BaseUrl) === null
    && getNullableTrimmedString(serverLlama.BindHost) === null
    && (toNullableInteger(serverLlama.Port) === null || Number(serverLlama.Port) <= 0)
    && (toNullableInteger(serverLlama.NumCtx) === null || Number(serverLlama.NumCtx) <= 0)
    && (toNullableInteger(serverLlama.BatchSize) === null || Number(serverLlama.BatchSize) <= 0)
    && (toNullableInteger(serverLlama.UBatchSize) === null || Number(serverLlama.UBatchSize) <= 0)
    && (toNullableInteger(serverLlama.CacheRam) === null || Number(serverLlama.CacheRam) <= 0)
    && getNullableTrimmedString(serverLlama.KvCacheQuantization) === null
    && (toNullableInteger(serverLlama.MaxTokens) === null || Number(serverLlama.MaxTokens) <= 0)
    && (toNullableNumber(serverLlama.Temperature) === null || Number(serverLlama.Temperature) <= 0)
    && (toNullableNumber(serverLlama.TopP) === null || Number(serverLlama.TopP) <= 0)
    && (toNullableInteger(serverLlama.TopK) === null || Number(serverLlama.TopK) <= 0)
    && getNullableTrimmedString(serverLlama.Reasoning) === null
  );
  if (managedBlankPlaceholder) {
    for (const key of MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS) {
      serverLlama[key] = defaultServerLlama[key];
    }
  }
  applyActiveManagedLlamaPreset(serverLlama, preferManagedPresetValues);
  serverLlama.VerboseLogging = Boolean(serverLlama.VerboseLogging);
  delete serverLlama.StartupScript;
  delete serverLlama.ShutdownScript;
  delete serverLlama.VerboseArgs;
  for (const key of MANAGED_LLAMA_RUNTIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(serverLlama, key)) {
      runtimeLlama[key] = serverLlama[key];
    }
  }
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
  server_executable_path: string | null;
  server_base_url: string | null;
  server_bind_host: string | null;
  server_port: number | null;
  server_model_path: string | null;
  server_num_ctx: number | null;
  server_gpu_layers: number | null;
  server_threads: number | null;
  server_flash_attention: number | null;
  server_parallel_slots: number | null;
  server_batch_size: number | null;
  server_ubatch_size: number | null;
  server_cache_ram: number | null;
  server_kv_cache_quant: string | null;
  server_max_tokens: number | null;
  server_temperature: number | null;
  server_top_p: number | null;
  server_top_k: number | null;
  server_min_p: number | null;
  server_presence_penalty: number | null;
  server_repetition_penalty: number | null;
  server_reasoning: string | null;
  server_reasoning_budget: number | null;
  server_startup_timeout_ms: number | null;
  server_healthcheck_timeout_ms: number | null;
  server_healthcheck_interval_ms: number | null;
  server_verbose_logging: number | null;
  server_llama_presets_json: string;
  server_llama_active_preset_id: string | null;
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
    server_executable_path: typeof serverLlama.ExecutablePath === 'string' && serverLlama.ExecutablePath.trim()
      ? serverLlama.ExecutablePath.trim()
      : null,
    server_base_url: typeof serverLlama.BaseUrl === 'string' && serverLlama.BaseUrl.trim()
      ? serverLlama.BaseUrl.trim()
      : null,
    server_bind_host: typeof serverLlama.BindHost === 'string' && serverLlama.BindHost.trim()
      ? serverLlama.BindHost.trim()
      : null,
    server_port: toNullableInteger(serverLlama.Port),
    server_model_path: typeof serverLlama.ModelPath === 'string' && serverLlama.ModelPath.trim()
      ? serverLlama.ModelPath.trim()
      : null,
    server_num_ctx: toNullableInteger(serverLlama.NumCtx),
    server_gpu_layers: toNullableInteger(serverLlama.GpuLayers),
    server_threads: toNullableInteger(serverLlama.Threads),
    server_flash_attention: toNullableBooleanInteger(serverLlama.FlashAttention),
    server_parallel_slots: toNullableInteger(serverLlama.ParallelSlots),
    server_batch_size: toNullableInteger(serverLlama.BatchSize),
    server_ubatch_size: toNullableInteger(serverLlama.UBatchSize),
    server_cache_ram: toNullableInteger(serverLlama.CacheRam),
    server_kv_cache_quant: typeof serverLlama.KvCacheQuantization === 'string' && serverLlama.KvCacheQuantization.trim()
      ? serverLlama.KvCacheQuantization.trim()
      : null,
    server_max_tokens: toNullableInteger(serverLlama.MaxTokens),
    server_temperature: toNullableNumber(serverLlama.Temperature),
    server_top_p: toNullableNumber(serverLlama.TopP),
    server_top_k: toNullableInteger(serverLlama.TopK),
    server_min_p: toNullableNumber(serverLlama.MinP),
    server_presence_penalty: toNullableNumber(serverLlama.PresencePenalty),
    server_repetition_penalty: toNullableNumber(serverLlama.RepetitionPenalty),
    server_reasoning: typeof serverLlama.Reasoning === 'string' && serverLlama.Reasoning.trim() ? serverLlama.Reasoning.trim() : null,
    server_reasoning_budget: toNullableInteger(serverLlama.ReasoningBudget),
    server_startup_timeout_ms: toNullableInteger(serverLlama.StartupTimeoutMs),
    server_healthcheck_timeout_ms: toNullableInteger(serverLlama.HealthcheckTimeoutMs),
    server_healthcheck_interval_ms: toNullableInteger(serverLlama.HealthcheckIntervalMs),
    server_verbose_logging: toNullableBooleanInteger(serverLlama.VerboseLogging),
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
    GpuLayers: row.server_gpu_layers,
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
        ExecutablePath: row.server_executable_path,
        BaseUrl: row.server_base_url,
        BindHost: row.server_bind_host,
        Port: row.server_port,
        ModelPath: row.server_model_path,
        NumCtx: row.server_num_ctx,
        GpuLayers: row.server_gpu_layers,
        Threads: row.server_threads,
        FlashAttention: row.server_flash_attention === null ? null : row.server_flash_attention === 1,
        ParallelSlots: row.server_parallel_slots,
        BatchSize: row.server_batch_size,
        UBatchSize: row.server_ubatch_size,
        CacheRam: row.server_cache_ram,
        KvCacheQuantization: row.server_kv_cache_quant,
        MaxTokens: row.server_max_tokens,
        Temperature: row.server_temperature,
        TopP: row.server_top_p,
        TopK: row.server_top_k,
        MinP: row.server_min_p,
        PresencePenalty: row.server_presence_penalty,
        RepetitionPenalty: row.server_repetition_penalty,
        Reasoning: row.server_reasoning,
        ReasoningBudget: row.server_reasoning_budget,
        StartupTimeoutMs: row.server_startup_timeout_ms,
        HealthcheckTimeoutMs: row.server_healthcheck_timeout_ms,
        HealthcheckIntervalMs: row.server_healthcheck_interval_ms,
        VerboseLogging: row.server_verbose_logging === null ? false : row.server_verbose_logging === 1,
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
      server_executable_path,
      server_base_url,
      server_bind_host,
      server_port,
      server_model_path,
      server_num_ctx,
      server_gpu_layers,
      server_threads,
      server_flash_attention,
      server_parallel_slots,
      server_batch_size,
      server_ubatch_size,
      server_cache_ram,
      server_kv_cache_quant,
      server_max_tokens,
      server_temperature,
      server_top_p,
      server_top_k,
      server_min_p,
      server_presence_penalty,
      server_repetition_penalty,
      server_reasoning,
      server_reasoning_budget,
      server_startup_timeout_ms,
      server_healthcheck_timeout_ms,
      server_healthcheck_interval_ms,
      server_verbose_logging,
      server_llama_presets_json,
      server_llama_active_preset_id,
      operation_mode_allowed_tools_json,
      presets_json
    FROM app_config
    WHERE id = 1
  `).get() as AppConfigRow | undefined;
  return row || null;
}

function writeConfigRow(databasePath: string, row: AppConfigRow): void {
  const database = getRuntimeDatabase(databasePath);
  const hasLegacyVerboseArgsColumn = Boolean(database.prepare(`
    SELECT 1 AS present
    FROM pragma_table_info('app_config')
    WHERE name = 'server_verbose_args_json'
    LIMIT 1
  `).get());
  const columns = [
    'id',
    'version',
    'backend',
    'policy_mode',
    'raw_log_retention',
    'prompt_prefix',
    'runtime_model',
    'llama_base_url',
    'llama_num_ctx',
    'llama_model_path',
    'llama_temperature',
    'llama_top_p',
    'llama_top_k',
    'llama_min_p',
    'llama_presence_penalty',
    'llama_repetition_penalty',
    'llama_max_tokens',
    'llama_threads',
    'llama_flash_attention',
    'llama_parallel_slots',
    'llama_reasoning',
    'thresholds_min_characters_for_summary',
    'thresholds_min_lines_for_summary',
    'interactive_enabled',
    'interactive_wrapped_commands_json',
    'interactive_idle_timeout_ms',
    'interactive_max_transcript_characters',
    'interactive_transcript_retention',
    'server_executable_path',
    'server_base_url',
    'server_bind_host',
    'server_port',
    'server_model_path',
    'server_num_ctx',
    'server_gpu_layers',
    'server_threads',
    'server_flash_attention',
    'server_parallel_slots',
    'server_batch_size',
    'server_ubatch_size',
    'server_cache_ram',
    'server_kv_cache_quant',
    'server_max_tokens',
    'server_temperature',
    'server_top_p',
    'server_top_k',
    'server_min_p',
    'server_presence_penalty',
    'server_repetition_penalty',
    'server_reasoning',
    'server_reasoning_budget',
    'server_startup_timeout_ms',
    'server_healthcheck_timeout_ms',
    'server_healthcheck_interval_ms',
    'server_verbose_logging',
    'server_llama_presets_json',
    'server_llama_active_preset_id',
    ...(hasLegacyVerboseArgsColumn
      ? ['server_startup_script', 'server_shutdown_script', 'server_verbose_args_json']
      : []),
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
    ...(hasLegacyVerboseArgsColumn
      ? {
        server_startup_script: null,
        server_shutdown_script: null,
        server_verbose_args_json: '[]',
      }
      : {}),
    updated_at_utc: new Date().toISOString(),
  });
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

function getFiniteInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNullableTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  ) {
    return normalized;
  }
  return fallback;
}

function copyManagedLlamaFields(target: Dict, source: Dict): void {
  for (const key of MANAGED_LLAMA_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
}

function managedLlamaFieldsDiffer(left: Dict, right: Dict): boolean {
  return MANAGED_LLAMA_FIELD_KEYS.some((key) => left[key] !== right[key]);
}

function normalizeManagedLlamaPresetRecord(input: unknown, fallbackId: string, fallbackLabel: string): Dict {
  const record = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Dict : {};
  const managed = getManagedLlamaConfig({ Server: { LlamaCpp: record } });
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    ...managed,
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

function applyActiveManagedLlamaPreset(serverLlama: Dict, preferPresetValues: boolean): void {
  const presets = normalizeManagedLlamaPresetArray(serverLlama.Presets, serverLlama);
  const activePresetId = getNullableTrimmedString(serverLlama.ActivePresetId);
  const activePreset = presets.find((preset) => preset.id === activePresetId) || presets[0];
  serverLlama.Presets = presets;
  serverLlama.ActivePresetId = String(activePreset.id);
  if (!preferPresetValues && managedLlamaFieldsDiffer(serverLlama, activePreset)) {
    copyManagedLlamaFields(activePreset, serverLlama);
    return;
  }
  copyManagedLlamaFields(serverLlama, activePreset);
}

type ManagedLlamaConfig = {
  ExecutablePath: string | null;
  BaseUrl: string | null;
  BindHost: string;
  Port: number;
  ModelPath: string | null;
  NumCtx: number;
  GpuLayers: number;
  Threads: number;
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
  Reasoning: 'on' | 'off' | 'auto';
  ReasoningBudget: number;
  StartupTimeoutMs: number;
  HealthcheckTimeoutMs: number;
  HealthcheckIntervalMs: number;
  VerboseLogging: boolean;
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
  return getManagedLlamaConfig(config).BaseUrl;
}

export function getManagedLlamaConfig(config: unknown): ManagedLlamaConfig {
  const defaults = (getDefaultConfig().Server as Dict).LlamaCpp as Dict;
  const cfg = (config ?? {}) as Dict;
  const srv = (cfg.Server ?? {}) as Dict;
  const serverLlama = (srv.LlamaCpp ?? {}) as Dict;
  const legacyExecutablePath = getNullableTrimmedString(serverLlama.StartupScript);
  const reasoning = getNullableTrimmedString(serverLlama.Reasoning);
  return {
    ExecutablePath: getNullableTrimmedString(serverLlama.ExecutablePath)
      || (
        legacyExecutablePath
        && !isLegacyManagedStartupScriptPath(legacyExecutablePath)
        && normalizeWindowsPath(legacyExecutablePath) !== normalizeWindowsPath(DEFAULT_LLAMA_STARTUP_SCRIPT)
          ? legacyExecutablePath
          : getNullableTrimmedString(defaults.ExecutablePath)
      ),
    BaseUrl: getNullableTrimmedString(serverLlama.BaseUrl) || getNullableTrimmedString(defaults.BaseUrl),
    BindHost: getNullableTrimmedString(serverLlama.BindHost) || String(defaults.BindHost || DEFAULT_LLAMA_BIND_HOST),
    Port: getFinitePositiveInteger(serverLlama.Port, Number(defaults.Port ?? DEFAULT_LLAMA_PORT)),
    ModelPath: getNullableTrimmedString(serverLlama.ModelPath) || getNullableTrimmedString(defaults.ModelPath),
    NumCtx: getFinitePositiveInteger(serverLlama.NumCtx, Number(defaults.NumCtx ?? 150000)),
    GpuLayers: getFiniteInteger(serverLlama.GpuLayers, Number(defaults.GpuLayers ?? DEFAULT_LLAMA_GPU_LAYERS)),
    Threads: getFiniteInteger(serverLlama.Threads, Number(defaults.Threads ?? -1)),
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
    Reasoning: reasoning === 'on' || reasoning === 'auto' || reasoning === 'off'
      ? reasoning
      : String(defaults.Reasoning || 'off') as 'on' | 'off' | 'auto',
    ReasoningBudget: getFinitePositiveInteger(serverLlama.ReasoningBudget, Number(defaults.ReasoningBudget ?? DEFAULT_LLAMA_REASONING_BUDGET)),
    StartupTimeoutMs: getManagedStartupTimeoutMs(serverLlama.StartupTimeoutMs, Number(defaults.StartupTimeoutMs)),
    HealthcheckTimeoutMs: getFinitePositiveInteger(serverLlama.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs)),
    HealthcheckIntervalMs: getFinitePositiveInteger(serverLlama.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs)),
    VerboseLogging: Boolean(serverLlama.VerboseLogging),
  };
}

export type { ManagedLlamaConfig };
