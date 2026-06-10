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
  ManagedLlamaKvCacheQuantization,
  ManagedLlamaSpeculativeType,
  NormalizationInfo,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
} from './types.js';

type JsonRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function getDefaultWebSearchConfig(): WebSearchConfig {
  return getDefaultConfigObject().WebSearch;
}

function getDefaultManagedLlamaPreset(): ServerManagedLlamaPreset {
  const preset = getDefaultConfigObject().Server.LlamaCpp.Presets[0];
  if (!preset) {
    throw new Error('Default managed llama preset is missing.');
  }
  return preset;
}

function clampInteger(value: unknown, fallback: number, minValue: number, maxValue: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, minValue), maxValue);
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

export function getNullableTrimmedString(value: unknown): string | null {
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

function normalizeProviderSettings(value: unknown): WebSearchProviderSettings {
  const record = getRecord(value);
  return {
    Enabled: record.Enabled === true,
    ApiKey: getNullableTrimmedString(record.ApiKey) || '',
  };
}

function normalizeProviderOrder(value: unknown): WebSearchProviderId[] {
  const requested = Array.isArray(value) ? value.map((entry) => String(entry || '').trim()) : [];
  const ordered = requested.filter(
    (id, index): id is WebSearchProviderId =>
      WEB_SEARCH_PROVIDER_IDS.includes(id as WebSearchProviderId) && requested.indexOf(id) === index,
  );
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

export function normalizeWebSearchConfig(value: unknown): WebSearchConfig {
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

function getManagedSpeculativeType(value: unknown, fallback: ManagedLlamaSpeculativeType): ManagedLlamaSpeculativeType {
  return MANAGED_LLAMA_SPECULATIVE_TYPES.includes(String(value || '') as ManagedLlamaSpeculativeType)
    ? String(value) as ManagedLlamaSpeculativeType
    : fallback;
}

function getManagedKvCacheQuantization(value: unknown, fallback: ManagedLlamaKvCacheQuantization): ManagedLlamaKvCacheQuantization {
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

export function mergeConfig(baseValue: unknown, patchValue: unknown): unknown {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }
  if (isRecord(baseValue) && isRecord(patchValue)) {
    const merged: JsonRecord = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      if (key === 'Paths') {
        continue;
      }
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }
  return patchValue;
}

export function normalizeManagedLlamaPresetRecord(
  input: unknown,
  fallbackId: string,
  fallbackLabel: string,
): ServerManagedLlamaPreset {
  const record = getRecord(input);
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    Model: getNullableTrimmedString(record.Model) || deriveModelIdFromPath(record.ModelPath) || SIFT_DEFAULT_LLAMA_MODEL,
    ...resolveManagedLlamaSettings(record),
  };
}

export function normalizeManagedLlamaPresetArray(value: unknown, fallbackSource: unknown): ServerManagedLlamaPreset[] {
  const records = Array.isArray(value) ? value : [];
  const normalized: ServerManagedLlamaPreset[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const candidate = normalizeManagedLlamaPresetRecord(records[index], `preset-${index + 1}`, `Preset ${index + 1}`);
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    normalized.push(candidate);
  }
  if (normalized.length > 0) {
    return normalized;
  }
  return [normalizeManagedLlamaPresetRecord({
    id: 'default',
    label: 'Default',
    ...getRecord(fallbackSource),
  }, 'default', 'Default')];
}

function resolveOperationModeAllowedTools(value: unknown): OperationModeAllowedTools {
  if (!value) {
    return getDefaultOperationModeAllowedTools();
  }
  return normalizeOperationModeAllowedTools(value);
}

function resolveManagedLlamaSettings(input: JsonRecord): ManagedLlamaConfig {
  const defaults = getDefaultManagedLlamaPreset();
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

export function normalizeConfigObject(input: unknown): SiftConfig {
  const merged = getRecord(mergeConfig(getDefaultConfigObject(), input || {}));
  if (merged.Backend === 'ollama') {
    merged.Backend = 'llama.cpp';
  }
  delete merged.Paths;
  delete merged.Ollama;
  delete merged.Model;
  delete merged.LlamaCpp;

  const runtime = getRecord(merged.Runtime);
  delete runtime.PromptPrefix;
  runtime.Model = getNullableTrimmedString(runtime.Model);
  runtime.LlamaCpp = getRecord(runtime.LlamaCpp);
  merged.Runtime = runtime;

  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = getDefaultConfigObject().PromptPrefix;
  }
  merged.ExpandReads = merged.ExpandReads !== false;

  const thresholds = getRecord(merged.Thresholds);
  delete thresholds.MaxInputCharacters;
  delete thresholds.ChunkThresholdRatio;
  merged.Thresholds = thresholds;

  const server = getRecord(merged.Server);
  const serverLlama = getRecord(server.LlamaCpp);
  const presets = normalizeManagedLlamaPresetArray(serverLlama.Presets, {});
  const activeId = getNullableTrimmedString(serverLlama.ActivePresetId);
  const activePreset = presets.find((preset) => preset.id === activeId) || presets[0];
  if (!activePreset) {
    throw new Error('Managed llama preset normalization produced no presets.');
  }
  server.LlamaCpp = { Presets: presets, ActivePresetId: activePreset.id };
  merged.Server = server;

  merged.OperationModeAllowedTools = resolveOperationModeAllowedTools(merged.OperationModeAllowedTools);
  merged.Presets = normalizePresets(merged.Presets) as SiftPreset[];
  merged.WebSearch = normalizeWebSearchConfig(merged.WebSearch);
  return merged as SiftConfig;
}

export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  return { config: normalizeConfigObject(config), info: { changed: false } };
}

export function getRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime.LlamaCpp;
}

export function getActiveManagedLlamaPreset(config: SiftConfig): ServerManagedLlamaPreset {
  const normalized = normalizeConfigObject(config);
  const serverLlama = normalized.Server.LlamaCpp;
  return serverLlama.Presets.find((preset) => preset.id === serverLlama.ActivePresetId) || serverLlama.Presets[0];
}

export function getManagedLlamaConfig(config: SiftConfig): ManagedLlamaConfig {
  const preset = getActiveManagedLlamaPreset(config);
  return {
    Model: getNullableTrimmedString(preset.Model),
    ...resolveManagedLlamaSettings(preset as JsonRecord),
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
  const persisted = { ...config };
  delete (persisted as Partial<SiftConfig>).Paths;
  delete (persisted as Partial<SiftConfig>).Effective;
  return persisted;
}
