import { initializeRuntime } from './paths.js';
import {
  SIFT_DEFAULT_LLAMA_BASE_URL,
  SIFT_DEFAULT_LLAMA_BATCH_SIZE,
  SIFT_DEFAULT_LLAMA_BIND_HOST,
  SIFT_DEFAULT_LLAMA_CACHE_RAM,
  SIFT_DEFAULT_LLAMA_GPU_LAYERS,
  SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION,
  SIFT_DEFAULT_LLAMA_MODEL,
  SIFT_DEFAULT_LLAMA_PORT,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
  SIFT_DEFAULT_LLAMA_SLEEP_IDLE_SECONDS,
  SIFT_DEFAULT_LLAMA_UBATCH_SIZE,
} from './constants.js';
import { getDefaultConfigObject } from './defaults.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  type OperationModeAllowedTools,
  type SiftPreset,
} from '../presets.js';
import type {
  Exl3EngineConfig,
  ManagedLlamaKvCacheQuantization,
  ManagedLlamaSpeculativeType,
  ModelRuntimePreset,
  NormalizationInfo,
  InferenceBackendId,
  RuntimeLlamaCppConfig,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
} from './types.js';
import { JsonObjectSchema, JsonValueSchema, type JsonValue, type MutableJsonObject } from '../lib/json-types.js';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { z } from '../lib/zod.js';

const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = ['tavily', 'firecrawl'];
const MANAGED_LLAMA_SPECULATIVE_TYPES: readonly ManagedLlamaSpeculativeType[] = [
  'draft-simple',
  'draft-eagle3',
  'draft-mtp',
  'ngram-simple',
  'ngram-map-k',
  'ngram-map-k4v',
  'ngram-mod',
  'ngram-cache',
];
const MAX_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
const INFERENCE_BACKEND_IDS: readonly InferenceBackendId[] = ['llama', 'exl3'];
const SiftConfigSchema = z.custom<SiftConfig>((value) => JsonObjectSchema.safeParse(value).success);

export type ManagedLlamaConfig = {
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
  KvCacheQuantization: ManagedLlamaKvCacheQuantization;
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
  MaintainPerStepThinking: boolean;
  SpeculativeEnabled: boolean;
  SpeculativeType: ManagedLlamaSpeculativeType;
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

function getRecord(value: JsonValue): MutableJsonObject {
  const record = JsonRecordReader.asObject(value);
  return record ? { ...record } : {};
}

function getDefaultWebSearchConfig(): WebSearchConfig {
  return getDefaultConfigObject().WebSearch;
}

function getDefaultModelPreset(): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Default model preset is missing.');
  }
  return preset;
}

function normalizeInferenceBackend(value: JsonValue): InferenceBackendId {
  const candidate = getNullableTrimmedString(value);
  return INFERENCE_BACKEND_IDS.find((backend) => backend === candidate) ?? 'llama';
}

function normalizeExl3Engine(value: JsonValue): Exl3EngineConfig {
  const input = getRecord(value);
  const defaults = getDefaultConfigObject().Server.Engines.Exl3;
  return {
    Managed: input.Managed !== false,
    WorkingDirectory: getNullableTrimmedString(input.WorkingDirectory) ?? defaults.WorkingDirectory,
    PythonPath: getNullableTrimmedString(input.PythonPath) ?? defaults.PythonPath,
    Entrypoint: getNullableTrimmedString(input.Entrypoint) ?? defaults.Entrypoint,
    ConfigPath: getNullableTrimmedString(input.ConfigPath) ?? defaults.ConfigPath,
    ModelRoot: getNullableTrimmedString(input.ModelRoot) ?? defaults.ModelRoot,
    AdminApiKey: getNullableTrimmedString(input.AdminApiKey) ?? '',
    ShutdownTimeoutMs: getFinitePositiveInteger(input.ShutdownTimeoutMs, defaults.ShutdownTimeoutMs),
  };
}

function clampInteger(value: JsonValue, fallback: number, minValue: number, maxValue: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, minValue), maxValue);
}

export function getFinitePositiveInteger(value: JsonValue, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getManagedStartupTimeoutMs(value: JsonValue, fallback: number): number {
  return Math.min(getFinitePositiveInteger(value, fallback), MAX_LLAMA_STARTUP_TIMEOUT_MS);
}

function getFiniteInteger(value: JsonValue, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSpeculativeInteger(value: JsonValue, fallback: number, requirePositive: boolean): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed === -1) {
    return -1;
  }
  return !requirePositive || parsed > 0 ? parsed : fallback;
}

function getFiniteNumber(value: JsonValue, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getNullableTrimmedString(value: JsonValue): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deriveModelIdFromPath(value: JsonValue): string | null {
  const normalized = getNullableTrimmedString(value);
  if (!normalized) {
    return null;
  }
  const lastSeparatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return lastSeparatorIndex >= 0 ? normalized.slice(lastSeparatorIndex + 1) : normalized;
}

function normalizeProviderSettings(value: JsonValue): WebSearchProviderSettings {
  const record = getRecord(value);
  return {
    Enabled: record.Enabled === true,
    ApiKey: getNullableTrimmedString(record.ApiKey) || '',
  };
}

function getWebSearchProviderId(value: string): WebSearchProviderId | null {
  switch (value) {
    case 'tavily':
      return 'tavily';
    case 'firecrawl':
      return 'firecrawl';
    default:
      return null;
  }
}

function normalizeProviderOrder(value: JsonValue): WebSearchProviderId[] {
  const requested = Array.isArray(value) ? value.map((entry) => String(entry || '').trim()) : [];
  const ordered: WebSearchProviderId[] = [];
  for (const requestedId of requested) {
    const id = getWebSearchProviderId(requestedId);
    if (id && !ordered.includes(id)) {
      ordered.push(id);
    }
  }
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

export function normalizeWebSearchConfig(value: JsonValue): WebSearchConfig {
  const defaults = getDefaultWebSearchConfig();
  const record = getRecord(value);
  const providersInput = getRecord(record.Providers);
  return {
    EnabledDefault: typeof record.EnabledDefault === 'boolean'
      ? record.EnabledDefault
      : defaults.EnabledDefault,
    Providers: {
      tavily: normalizeProviderSettings(providersInput.tavily),
      firecrawl: normalizeProviderSettings(providersInput.firecrawl),
    },
    ProviderOrder: normalizeProviderOrder(record.ProviderOrder),
    ResultCount: clampInteger(record.ResultCount, defaults.ResultCount, 1, 20),
    FetchMaxPages: clampInteger(record.FetchMaxPages, defaults.FetchMaxPages, 1, 8),
    TimeoutMs: clampInteger(record.TimeoutMs, defaults.TimeoutMs, 1000, 60_000),
    FetchMaxCharacters: clampInteger(record.FetchMaxCharacters, defaults.FetchMaxCharacters, 1000, 50_000),
  };
}

function getManagedSpeculativeType(value: JsonValue, fallback: ManagedLlamaSpeculativeType): ManagedLlamaSpeculativeType {
  switch (String(value || '')) {
    case 'draft-simple':
      return 'draft-simple';
    case 'draft-eagle3':
      return 'draft-eagle3';
    case 'draft-mtp':
      return 'draft-mtp';
    case 'ngram-simple':
      return 'ngram-simple';
    case 'ngram-map-k':
      return 'ngram-map-k';
    case 'ngram-map-k4v':
      return 'ngram-map-k4v';
    case 'ngram-mod':
      return 'ngram-mod';
    case 'ngram-cache':
      return 'ngram-cache';
    default:
      return fallback;
  }
}

function getManagedKvCacheQuantization(value: JsonValue, fallback: ManagedLlamaKvCacheQuantization): ManagedLlamaKvCacheQuantization {
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
    || normalized === 'q8_0/q4_0'
    || normalized === 'q8_0/q5_0'
  ) {
    return normalized;
  }
  return fallback;
}

export function mergeConfig(baseValue: JsonValue, patchValue: JsonValue): JsonValue {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return JsonValueSchema.parse(patchValue.slice());
  }
  const baseRecord = JsonRecordReader.asObject(baseValue);
  const patchRecord = JsonRecordReader.asObject(patchValue);
  if (baseRecord && patchRecord) {
    const merged: MutableJsonObject = { ...baseRecord };
    for (const [key, value] of Object.entries(patchRecord)) {
      if (key === 'Paths') {
        continue;
      }
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }
  return JsonValueSchema.parse(patchValue ?? null);
}

export function normalizeModelRuntimePresetRecord(
  input: JsonValue,
  fallbackId: string,
  fallbackLabel: string,
): ModelRuntimePreset {
  const record = getRecord(input);
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    Backend: normalizeInferenceBackend(record.Backend),
    Model: getNullableTrimmedString(record.Model) || deriveModelIdFromPath(record.ModelPath) || SIFT_DEFAULT_LLAMA_MODEL,
    ...resolveManagedLlamaSettings(record),
  };
}

export function normalizeModelRuntimePresetArray(value: JsonValue, fallbackSource: JsonValue): ModelRuntimePreset[] {
  const records = Array.isArray(value) ? value : [];
  const normalized: ModelRuntimePreset[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const candidate = normalizeModelRuntimePresetRecord(records[index], `preset-${index + 1}`, `Preset ${index + 1}`);
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    normalized.push(candidate);
  }
  if (normalized.length > 0) {
    return normalized;
  }
  return [normalizeModelRuntimePresetRecord({
    id: 'default',
    label: 'Default',
    ...getRecord(fallbackSource),
  }, 'default', 'Default')];
}

function resolveOperationModeAllowedTools(value: JsonValue): OperationModeAllowedTools {
  if (!value) {
    return getDefaultOperationModeAllowedTools();
  }
  return normalizeOperationModeAllowedTools(value);
}

function resolveManagedLlamaSettings(input: MutableJsonObject): ManagedLlamaConfig {
  const defaults = getDefaultModelPreset();
  const reasoning = getNullableTrimmedString(input.Reasoning);
  const reasoningEnabled = reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && input.ReasoningContent === true;
  return {
    ExternalServerEnabled: input.ExternalServerEnabled === true,
    ExecutablePath: getNullableTrimmedString(input.ExecutablePath)
      || getNullableTrimmedString(defaults.ExecutablePath),
    BaseUrl: getNullableTrimmedString(input.BaseUrl) || getNullableTrimmedString(defaults.BaseUrl),
    BindHost: getNullableTrimmedString(input.BindHost) || String(defaults.BindHost || SIFT_DEFAULT_LLAMA_BIND_HOST),
    Port: getFinitePositiveInteger(input.Port, Number(defaults.Port ?? SIFT_DEFAULT_LLAMA_PORT)),
    ModelPath: getNullableTrimmedString(input.ModelPath) || getNullableTrimmedString(defaults.ModelPath),
    NumCtx: getFinitePositiveInteger(input.NumCtx, Number(defaults.NumCtx ?? 150_000)),
    GpuLayers: getFiniteInteger(input.GpuLayers, Number(defaults.GpuLayers ?? SIFT_DEFAULT_LLAMA_GPU_LAYERS)),
    Threads: getFiniteInteger(input.Threads, Number(defaults.Threads ?? -1)),
    NcpuMoe: getFiniteInteger(input.NcpuMoe, Number(defaults.NcpuMoe ?? 0)),
    FlashAttention: input.FlashAttention === null || input.FlashAttention === undefined
      ? Boolean(defaults.FlashAttention)
      : Boolean(input.FlashAttention),
    ParallelSlots: getFinitePositiveInteger(input.ParallelSlots, Number(defaults.ParallelSlots ?? 1)),
    BatchSize: getFinitePositiveInteger(input.BatchSize, Number(defaults.BatchSize ?? SIFT_DEFAULT_LLAMA_BATCH_SIZE)),
    UBatchSize: getFinitePositiveInteger(input.UBatchSize, Number(defaults.UBatchSize ?? SIFT_DEFAULT_LLAMA_UBATCH_SIZE)),
    CacheRam: getFinitePositiveInteger(input.CacheRam, Number(defaults.CacheRam ?? SIFT_DEFAULT_LLAMA_CACHE_RAM)),
    KvCacheQuantization: getManagedKvCacheQuantization(
      input.KvCacheQuantization,
      defaults.KvCacheQuantization ?? SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION,
    ),
    MaxTokens: getFinitePositiveInteger(input.MaxTokens, Number(defaults.MaxTokens ?? 15_000)),
    Temperature: getFiniteNumber(input.Temperature, Number(defaults.Temperature ?? 0.7)),
    TopP: getFiniteNumber(input.TopP, Number(defaults.TopP ?? 0.8)),
    TopK: getFiniteInteger(input.TopK, Number(defaults.TopK ?? 20)),
    MinP: getFiniteNumber(input.MinP, Number(defaults.MinP ?? 0.0)),
    PresencePenalty: getFiniteNumber(input.PresencePenalty, Number(defaults.PresencePenalty ?? 1.5)),
    RepetitionPenalty: getFiniteNumber(input.RepetitionPenalty, Number(defaults.RepetitionPenalty ?? 1.0)),
    Reasoning: reasoning === 'on' || reasoning === 'off'
      ? reasoning
      : defaults.Reasoning || 'off',
    ReasoningContent: reasoningContentEnabled,
    PreserveThinking: reasoningContentEnabled && input.PreserveThinking === true,
    MaintainPerStepThinking: reasoningEnabled && input.MaintainPerStepThinking !== false,
    SpeculativeEnabled: input.SpeculativeEnabled === true,
    SpeculativeType: getManagedSpeculativeType(input.SpeculativeType, defaults.SpeculativeType || 'ngram-map-k'),
    SpeculativeMtpEnabled: input.SpeculativeMtpEnabled === true,
    SpeculativeNgramSizeN: getSpeculativeInteger(input.SpeculativeNgramSizeN, Number(defaults.SpeculativeNgramSizeN ?? 8), true),
    SpeculativeNgramSizeM: getSpeculativeInteger(input.SpeculativeNgramSizeM, Number(defaults.SpeculativeNgramSizeM ?? 16), true),
    SpeculativeNgramMinHits: getSpeculativeInteger(input.SpeculativeNgramMinHits, Number(defaults.SpeculativeNgramMinHits ?? 2), true),
    SpeculativeNgramModNMatch: getSpeculativeInteger(input.SpeculativeNgramModNMatch, Number(defaults.SpeculativeNgramModNMatch ?? 24), true),
    SpeculativeNgramModNMin: getSpeculativeInteger(input.SpeculativeNgramModNMin, Number(defaults.SpeculativeNgramModNMin ?? 4), true),
    SpeculativeNgramModNMax: getSpeculativeInteger(input.SpeculativeNgramModNMax, Number(defaults.SpeculativeNgramModNMax ?? 16), true),
    SpeculativeDraftMax: getSpeculativeInteger(input.SpeculativeDraftMax, Number(defaults.SpeculativeDraftMax ?? 16), true),
    SpeculativeDraftMin: getSpeculativeInteger(input.SpeculativeDraftMin, Number(defaults.SpeculativeDraftMin ?? 4), false),
    ReasoningBudget: getFinitePositiveInteger(input.ReasoningBudget, Number(defaults.ReasoningBudget ?? SIFT_DEFAULT_LLAMA_REASONING_BUDGET)),
    ReasoningBudgetMessage: getNullableTrimmedString(input.ReasoningBudgetMessage)
      || getNullableTrimmedString(defaults.ReasoningBudgetMessage)
      || SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
    StartupTimeoutMs: getManagedStartupTimeoutMs(input.StartupTimeoutMs, Number(defaults.StartupTimeoutMs ?? 600_000)),
    HealthcheckTimeoutMs: getFinitePositiveInteger(input.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs ?? 2_000)),
    HealthcheckIntervalMs: getFinitePositiveInteger(input.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs ?? 1_000)),
    SleepIdleSeconds: getFinitePositiveInteger(input.SleepIdleSeconds, Number(defaults.SleepIdleSeconds ?? SIFT_DEFAULT_LLAMA_SLEEP_IDLE_SECONDS)),
    VerboseLogging: Boolean(input.VerboseLogging),
  };
}

export function normalizeConfigObject(input: JsonValue): SiftConfig {
  const inputRecord = getRecord(input);
  const inputInference = getRecord(inputRecord.Inference);
  if ('SelectedBackend' in inputInference) {
    throw new Error('Unsupported configuration field Inference.SelectedBackend; select Backend on each model preset.');
  }
  const inputRuntime = getRecord(inputRecord.Runtime);
  if ('Model' in inputRuntime) {
    throw new Error('Unsupported configuration field Runtime.Model; use the active model preset Model field.');
  }
  const inputServer = getRecord(inputRecord.Server);
  if ('LlamaCpp' in inputServer) {
    throw new Error('Unsupported configuration field Server.LlamaCpp; use Server.ModelPresets.');
  }
  if ('Exl3' in inputServer) {
    throw new Error('Unsupported configuration field Server.Exl3; use Server.Engines.Exl3.');
  }

  const merged = getRecord(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), input ?? {}));
  if (merged.Backend === 'ollama') {
    merged.Backend = 'llama.cpp';
  }
  delete merged.Paths;
  delete merged.Ollama;
  delete merged.Model;
  delete merged.LlamaCpp;

  const runtime = getRecord(merged.Runtime);
  delete runtime.PromptPrefix;
  runtime.LlamaCpp = getRecord(runtime.LlamaCpp);
  merged.Runtime = runtime;

  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = getDefaultConfigObject().PromptPrefix ?? null;
  }
  merged.ExpandReads = merged.ExpandReads !== false;

  const inference = getRecord(merged.Inference);
  const thinking = getRecord(inference.Thinking);
  merged.Inference = {
    Thinking: {
      Enabled: Boolean(thinking.Enabled),
      Preserve: Boolean(thinking.Preserve),
    },
  };

  const thresholds = getRecord(merged.Thresholds);
  delete thresholds.MaxInputCharacters;
  delete thresholds.ChunkThresholdRatio;
  merged.Thresholds = thresholds;

  const server = getRecord(merged.Server);
  const modelPresets = getRecord(server.ModelPresets);
  const presets = normalizeModelRuntimePresetArray(modelPresets.Presets, {});
  const activeId = getNullableTrimmedString(modelPresets.ActivePresetId);
  const activePreset = presets.find((preset) => preset.id === activeId) || presets[0];
  if (!activePreset) {
    throw new Error('Model preset normalization produced no presets.');
  }
  const engines = getRecord(server.Engines);
  server.ModelPresets = { Presets: presets, ActivePresetId: activePreset.id };
  server.Engines = { Exl3: normalizeExl3Engine(engines.Exl3) };
  merged.Server = server;

  merged.OperationModeAllowedTools = resolveOperationModeAllowedTools(merged.OperationModeAllowedTools);
  merged.Presets = normalizePresets(merged.Presets);
  merged.WebSearch = normalizeWebSearchConfig(merged.WebSearch);
  return SiftConfigSchema.parse(merged);
}

export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  return { config: normalizeConfigObject(JsonValueSchema.parse(config)), info: { changed: false } };
}

export function getRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime.LlamaCpp;
}

export function getManagedLlamaConfig(config: SiftConfig): ManagedLlamaConfig {
  const normalized = normalizeConfigObject(JsonValueSchema.parse(config));
  const modelPresets = normalized.Server.ModelPresets;
  const preset = modelPresets.Presets.find((entry) => entry.id === modelPresets.ActivePresetId)
    ?? modelPresets.Presets[0];
  if (!preset) throw new Error('Model preset list is empty.');
  if (preset.Backend !== 'llama') {
    throw new Error(
      `getManagedLlamaConfig requires an active llama-backed preset, but preset '${preset.id}' is '${preset.Backend}'.`,
    );
  }
  return {
    Model: getNullableTrimmedString(preset.Model),
    ...resolveManagedLlamaSettings(getRecord(preset)),
  };
}

export function getLlamaBaseUrl(config: SiftConfig): string | null {
  return getManagedLlamaConfig(config).BaseUrl;
}

export function getManagedLlamaInternalBaseUrl(config: SiftConfig): string | null {
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

export function updateRuntimePaths(config: SiftConfig): SiftConfig {
  return {
    ...config,
    Paths: initializeRuntime(),
  };
}

/** Strips derived fields (`Paths`, `Effective`) before persisting via PUT /config. */
export function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'> {
  const { Paths: _Paths, Effective: _Effective, ...persisted } = config;
  return persisted;
}
