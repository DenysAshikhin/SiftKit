import { initializeRuntime } from './paths.js';
import {
  CaptureScopeSchema, KeyCustodySchema, ModelIdleActionSchema, ModelKvCacheQuantizationSchema,
  ModelPresetFieldSchema, ReasoningEffortSchema, SiftPresetCollectionSchema,
  type ModelIdleAction, type ReasoningEffort,
} from '@siftkit/contracts';
import {
  SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM,
  SIFT_DEFAULT_ENGINE_CACHE_RAM,
  SIFT_DEFAULT_ENGINE_KV_CACHE_QUANTIZATION,
  SIFT_DEFAULT_ENGINE_REASONING_BUDGET,
  SIFT_DEFAULT_ENGINE_REASONING_BUDGET_MESSAGE,
  SIFT_DEFAULT_ENGINE_SLEEP_IDLE_SECONDS,
  SIFT_DEFAULT_ENGINE_UBATCH_SIZE,
  SIFT_DEFAULT_VISION_IMAGE_RETENTION,
  SIFT_DEFAULT_VISION_MAX_IMAGE_PIXELS,
} from './constants.js';
import { DEFAULT_ASSISTANT_CONFIG, getDefaultConfigObject } from './defaults.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
  type OperationModeAllowedTools,
} from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import { InferenceBackendIdSchema } from './types.js';
import type {
  Exl3EngineConfig,
  AssistantConfig,
  ModelKvCacheQuantization,
  ModelPresetSettings,
  ModelRuntimePreset,
  NormalizationInfo,
  InferenceBackendId,
  RuntimeEngineConfig,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
} from './types.js';
import { JsonObjectSchema, JsonValueSchema, type JsonValue, type MutableJsonObject } from '../lib/json-types.js';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { z } from '../lib/zod.js';

const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = ['tavily', 'firecrawl'];
const MAX_ENGINE_STARTUP_TIMEOUT_MS = 600_000;
const SiftConfigSchema = z.custom<SiftConfig>((value) => JsonObjectSchema.safeParse(value).success);

function getRecord(value: JsonValue): MutableJsonObject {
  const record = JsonRecordReader.asObject(value);
  return record ? { ...record } : {};
}

function booleanOrDefault(value: JsonValue, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integerOrDefault(value: JsonValue, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : fallback;
}

function positiveNumberOrDefault(value: JsonValue, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringOrDefault(value: JsonValue, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function memberOrDefault<T extends string>(value: JsonValue, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

/** A malformed list falls back whole; a valid list keeps only its string entries. */
function stringListOrDefault(value: JsonValue, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function normalizeAssistantConfig(value: JsonValue): AssistantConfig {
  const input = getRecord(value);
  const owner = getRecord(input.Owner);
  const memory = getRecord(input.Memory);
  const tier1 = getRecord(memory.Tier1);
  const tier2 = getRecord(memory.Tier2);
  const tier3 = getRecord(memory.Tier3);
  const retrieval = getRecord(input.Retrieval);
  const questions = getRecord(input.Questions);
  const observation = getRecord(input.Observation);
  const retention = getRecord(input.Retention);
  const background = getRecord(input.Background);
  const priorities = getRecord(background.JobPriorities);
  const privateMode = getRecord(input.PrivateMode);
  const mobile = getRecord(input.Mobile);
  const maximum = Number.MAX_SAFE_INTEGER;

  return {
    Enabled: booleanOrDefault(input.Enabled, DEFAULT_ASSISTANT_CONFIG.Enabled),
    Owner: {
      Id: DEFAULT_ASSISTANT_CONFIG.Owner.Id,
      DisplayName: stringOrDefault(owner.DisplayName, DEFAULT_ASSISTANT_CONFIG.Owner.DisplayName),
    },
    Memory: {
      Tier1: {
        MaxTokens: integerOrDefault(tier1.MaxTokens, DEFAULT_ASSISTANT_CONFIG.Memory.Tier1.MaxTokens, 1, maximum),
        TargetTokens: integerOrDefault(tier1.TargetTokens, DEFAULT_ASSISTANT_CONFIG.Memory.Tier1.TargetTokens, 1, maximum),
      },
      Tier2: {
        MaxDocuments: integerOrDefault(tier2.MaxDocuments, DEFAULT_ASSISTANT_CONFIG.Memory.Tier2.MaxDocuments, 1, maximum),
        MaxTokensPerDocument: integerOrDefault(tier2.MaxTokensPerDocument, DEFAULT_ASSISTANT_CONFIG.Memory.Tier2.MaxTokensPerDocument, 1, maximum),
        TargetTokensPerDocument: integerOrDefault(tier2.TargetTokensPerDocument, DEFAULT_ASSISTANT_CONFIG.Memory.Tier2.TargetTokensPerDocument, 1, maximum),
      },
      Tier3: {
        MaxDocuments: integerOrDefault(tier3.MaxDocuments, DEFAULT_ASSISTANT_CONFIG.Memory.Tier3.MaxDocuments, 1, maximum),
        MaxTokensPerDocument: integerOrDefault(tier3.MaxTokensPerDocument, DEFAULT_ASSISTANT_CONFIG.Memory.Tier3.MaxTokensPerDocument, 1, maximum),
        TargetTokensPerDocument: integerOrDefault(tier3.TargetTokensPerDocument, DEFAULT_ASSISTANT_CONFIG.Memory.Tier3.TargetTokensPerDocument, 1, maximum),
      },
    },
    Retrieval: {
      MaxContextTokens: integerOrDefault(retrieval.MaxContextTokens, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxContextTokens, 1, maximum),
      MaxHops: integerOrDefault(retrieval.MaxHops, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxHops, 1, 3),
      MaxSeedNodes: integerOrDefault(retrieval.MaxSeedNodes, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxSeedNodes, 1, maximum),
      MaxNodes: integerOrDefault(retrieval.MaxNodes, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxNodes, 1, maximum),
      MaxAssertions: integerOrDefault(retrieval.MaxAssertions, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxAssertions, 1, maximum),
      MaxFanoutPerNodePredicate: integerOrDefault(retrieval.MaxFanoutPerNodePredicate, DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxFanoutPerNodePredicate, 1, maximum),
    },
    Questions: {
      Enabled: booleanOrDefault(questions.Enabled, DEFAULT_ASSISTANT_CONFIG.Questions.Enabled),
      MaxPerDay: integerOrDefault(questions.MaxPerDay, DEFAULT_ASSISTANT_CONFIG.Questions.MaxPerDay, 0, maximum),
      MaxPerWeek: integerOrDefault(questions.MaxPerWeek, DEFAULT_ASSISTANT_CONFIG.Questions.MaxPerWeek, 0, maximum),
      MinimumHoursBetweenQuestions: integerOrDefault(questions.MinimumHoursBetweenQuestions, DEFAULT_ASSISTANT_CONFIG.Questions.MinimumHoursBetweenQuestions, 0, maximum),
      AllowedLocalTimeStart: stringOrDefault(questions.AllowedLocalTimeStart, DEFAULT_ASSISTANT_CONFIG.Questions.AllowedLocalTimeStart),
      AllowedLocalTimeEnd: stringOrDefault(questions.AllowedLocalTimeEnd, DEFAULT_ASSISTANT_CONFIG.Questions.AllowedLocalTimeEnd),
      DismissedCooldownDays: integerOrDefault(questions.DismissedCooldownDays, DEFAULT_ASSISTANT_CONFIG.Questions.DismissedCooldownDays, 0, maximum),
      UnansweredExpiryDays: integerOrDefault(questions.UnansweredExpiryDays, DEFAULT_ASSISTANT_CONFIG.Questions.UnansweredExpiryDays, 1, maximum),
      SuppressDuringFullscreen: booleanOrDefault(questions.SuppressDuringFullscreen, DEFAULT_ASSISTANT_CONFIG.Questions.SuppressDuringFullscreen),
      SuppressDuringDoNotDisturb: booleanOrDefault(questions.SuppressDuringDoNotDisturb, DEFAULT_ASSISTANT_CONFIG.Questions.SuppressDuringDoNotDisturb),
      ActiveInputSuppressionSeconds: integerOrDefault(questions.ActiveInputSuppressionSeconds, DEFAULT_ASSISTANT_CONFIG.Questions.ActiveInputSuppressionSeconds, 0, maximum),
    },
    Observation: {
      ActivityMetadataEnabled: booleanOrDefault(observation.ActivityMetadataEnabled, DEFAULT_ASSISTANT_CONFIG.Observation.ActivityMetadataEnabled),
      ScreenshotsEnabled: booleanOrDefault(observation.ScreenshotsEnabled, DEFAULT_ASSISTANT_CONFIG.Observation.ScreenshotsEnabled),
      FixedCadenceSeconds: integerOrDefault(observation.FixedCadenceSeconds, DEFAULT_ASSISTANT_CONFIG.Observation.FixedCadenceSeconds, 1, maximum),
      WindowChangeCapture: booleanOrDefault(observation.WindowChangeCapture, DEFAULT_ASSISTANT_CONFIG.Observation.WindowChangeCapture),
      MinimumForegroundDwellSeconds: integerOrDefault(observation.MinimumForegroundDwellSeconds, DEFAULT_ASSISTANT_CONFIG.Observation.MinimumForegroundDwellSeconds, 0, maximum),
      DuplicateSimilarityPercent: integerOrDefault(observation.DuplicateSimilarityPercent, DEFAULT_ASSISTANT_CONFIG.Observation.DuplicateSimilarityPercent, 0, 100),
      CaptureScope: memberOrDefault(observation.CaptureScope, CaptureScopeSchema.options, DEFAULT_ASSISTANT_CONFIG.Observation.CaptureScope),
      CaptureOnlyWhileActive: booleanOrDefault(observation.CaptureOnlyWhileActive, DEFAULT_ASSISTANT_CONFIG.Observation.CaptureOnlyWhileActive),
      SkipFullscreen: booleanOrDefault(observation.SkipFullscreen, DEFAULT_ASSISTANT_CONFIG.Observation.SkipFullscreen),
      SkipWhileLocked: booleanOrDefault(observation.SkipWhileLocked, DEFAULT_ASSISTANT_CONFIG.Observation.SkipWhileLocked),
      RawRetentionHours: integerOrDefault(observation.RawRetentionHours, DEFAULT_ASSISTANT_CONFIG.Observation.RawRetentionHours, 1, maximum),
      RawStorageLimitGb: positiveNumberOrDefault(observation.RawStorageLimitGb, DEFAULT_ASSISTANT_CONFIG.Observation.RawStorageLimitGb),
      AccessibilityExtractionEnabled: booleanOrDefault(observation.AccessibilityExtractionEnabled, DEFAULT_ASSISTANT_CONFIG.Observation.AccessibilityExtractionEnabled),
      OcrFallbackEnabled: booleanOrDefault(observation.OcrFallbackEnabled, DEFAULT_ASSISTANT_CONFIG.Observation.OcrFallbackEnabled),
      ProcessDenyList: stringListOrDefault(observation.ProcessDenyList, DEFAULT_ASSISTANT_CONFIG.Observation.ProcessDenyList),
      TitleDenyPatterns: stringListOrDefault(observation.TitleDenyPatterns, DEFAULT_ASSISTANT_CONFIG.Observation.TitleDenyPatterns),
      StartOnSignIn: booleanOrDefault(observation.StartOnSignIn, DEFAULT_ASSISTANT_CONFIG.Observation.StartOnSignIn),
    },
    Retention: {
      OcrTextDays: integerOrDefault(retention.OcrTextDays, DEFAULT_ASSISTANT_CONFIG.Retention.OcrTextDays, 1, maximum),
      UnpromotedObservationDays: integerOrDefault(retention.UnpromotedObservationDays, DEFAULT_ASSISTANT_CONFIG.Retention.UnpromotedObservationDays, 1, maximum),
      RejectedCandidateDays: integerOrDefault(retention.RejectedCandidateDays, DEFAULT_ASSISTANT_CONFIG.Retention.RejectedCandidateDays, 1, maximum),
    },
    Background: {
      IdleSecondsBeforeProcessing: integerOrDefault(background.IdleSecondsBeforeProcessing, DEFAULT_ASSISTANT_CONFIG.Background.IdleSecondsBeforeProcessing, 0, maximum),
      MaxJobsPerIdleSession: integerOrDefault(background.MaxJobsPerIdleSession, DEFAULT_ASSISTANT_CONFIG.Background.MaxJobsPerIdleSession, -1, maximum),
      MaxGpuMinutesPerDay: integerOrDefault(background.MaxGpuMinutesPerDay, DEFAULT_ASSISTANT_CONFIG.Background.MaxGpuMinutesPerDay, -1, maximum),
      MinimumBatteryPercent: integerOrDefault(background.MinimumBatteryPercent, DEFAULT_ASSISTANT_CONFIG.Background.MinimumBatteryPercent, 0, 100),
      AllowOnBattery: booleanOrDefault(background.AllowOnBattery, DEFAULT_ASSISTANT_CONFIG.Background.AllowOnBattery),
      JobPriorities: {
        ConversationIngestion: integerOrDefault(priorities.ConversationIngestion, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.ConversationIngestion, -maximum, maximum),
        QuestionAnswerIngestion: integerOrDefault(priorities.QuestionAnswerIngestion, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.QuestionAnswerIngestion, -maximum, maximum),
        QuestionPlanning: integerOrDefault(priorities.QuestionPlanning, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.QuestionPlanning, -maximum, maximum),
        CandidateConsolidation: integerOrDefault(priorities.CandidateConsolidation, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.CandidateConsolidation, -maximum, maximum),
        ImageExtraction: integerOrDefault(priorities.ImageExtraction, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.ImageExtraction, -maximum, maximum),
        CaptureRetention: integerOrDefault(priorities.CaptureRetention, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.CaptureRetention, -maximum, maximum),
        ProjectionMaintenance: integerOrDefault(priorities.ProjectionMaintenance, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.ProjectionMaintenance, -maximum, maximum),
      },
    },
    PrivateMode: {
      Active: booleanOrDefault(privateMode.Active, DEFAULT_ASSISTANT_CONFIG.PrivateMode.Active),
      ExpiresAtUtc: privateMode.ExpiresAtUtc === null || typeof privateMode.ExpiresAtUtc === 'string'
        ? privateMode.ExpiresAtUtc
        : DEFAULT_ASSISTANT_CONFIG.PrivateMode.ExpiresAtUtc,
    },
    Mobile: { Enabled: booleanOrDefault(mobile.Enabled, DEFAULT_ASSISTANT_CONFIG.Mobile.Enabled) },
    KeyCustody: memberOrDefault(input.KeyCustody, KeyCustodySchema.options, DEFAULT_ASSISTANT_CONFIG.KeyCustody),
  };
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
  const backend = getNullableTrimmedString(value);
  if (backend === null) {
    return 'exl3';
  }
  const parsed = InferenceBackendIdSchema.safeParse(backend);
  if (!parsed.success) {
    throw new Error(
      `Unsupported model preset Backend '${backend}'; only ${InferenceBackendIdSchema.options.join(', ')} is supported. `
      + 'Delete the preset from the stored configuration.',
    );
  }
  return parsed.data;
}

function normalizeExl3Engine(value: JsonValue): Exl3EngineConfig {
  const input = getRecord(value);
  const defaults = getDefaultConfigObject().Server.Engines.Exl3;
  return {
    Managed: input.Managed !== false,
    WorkingDirectory: getNullableTrimmedString(input.WorkingDirectory) ?? defaults.WorkingDirectory,
    PythonPath: getNullableTrimmedString(input.PythonPath) ?? defaults.PythonPath,
    Entrypoint: getNullableTrimmedString(input.Entrypoint) ?? defaults.Entrypoint,
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

function getModelIdleAction(value: JsonValue): ModelIdleAction {
  const parsed = ModelIdleActionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid IdleAction '${String(value)}'; expected none, freeze, or unload.`);
  }
  return parsed.data;
}

function getFiniteNonNegativeInteger(value: JsonValue, fallback: number): number {
  const text = String(value ?? '').trim();
  if (!text) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getBooleanWithDefault(value: JsonValue, fallback: JsonValue): boolean {
  return value === null || value === undefined ? Boolean(fallback) : Boolean(value);
}

export function getManagedStartupTimeoutMs(value: JsonValue, fallback: number): number {
  return Math.min(getFinitePositiveInteger(value, fallback), MAX_ENGINE_STARTUP_TIMEOUT_MS);
}

function getFiniteInteger(value: JsonValue, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSpeculativeInteger(value: JsonValue, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed === -1 || parsed > 0 ? parsed : fallback;
}

function getVisionImageRetention(value: JsonValue): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= -1
    ? value
    : SIFT_DEFAULT_VISION_IMAGE_RETENTION;
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

function getReasoningEffort(value: JsonValue, fallback: ReasoningEffort): ReasoningEffort {
  const parsed = ReasoningEffortSchema.safeParse(getNullableTrimmedString(value));
  return parsed.success ? parsed.data : fallback;
}

function getModelKvCacheQuantization(value: JsonValue, fallback: ModelKvCacheQuantization): ModelKvCacheQuantization {
  const normalized = getNullableTrimmedString(value);
  if (normalized === null) {
    return fallback;
  }
  const parsed = ModelKvCacheQuantizationSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(
      `Unsupported KvCacheQuantization '${normalized}'; expected one of ${ModelKvCacheQuantizationSchema.options.join(', ')}.`,
    );
  }
  return parsed.data;
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

/**
 * `ModelPresetFieldSchema` is the single source of truth for what a preset may carry; `id`, `label`
 * and `Backend` are the identity keys it deliberately omits. Anything else is a field this repo has
 * removed (or never had), and rebuilding the settings key-by-key below would silently swallow it.
 */
const MODEL_RUNTIME_PRESET_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'Backend',
  ...ModelPresetFieldSchema.options,
]);

export function normalizeModelRuntimePresetRecord(
  input: JsonValue,
  fallbackId: string,
  fallbackLabel: string,
): ModelRuntimePreset {
  const record = getRecord(input);
  for (const key of Object.keys(record)) {
    if (!MODEL_RUNTIME_PRESET_FIELDS.has(key)) {
      throw new Error(
        `Unsupported model preset field ${key}; it is not part of ModelPresetFieldSchema. `
        + 'Delete it from the stored preset — SiftKit never migrates or repairs configuration automatically.',
      );
    }
  }
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    Backend: normalizeInferenceBackend(record.Backend),
    Model: getNullableTrimmedString(record.Model) || deriveModelIdFromPath(record.ModelPath),
    ...resolveModelPresetSettings(record),
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

function resolveModelPresetSettings(input: MutableJsonObject): ModelPresetSettings {
  const defaults = getDefaultModelPreset();
  const reasoning = getNullableTrimmedString(input.Reasoning);
  const reasoningEnabled = reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && input.ReasoningContent === true;
  return {
    ExternalServerEnabled: input.ExternalServerEnabled === true,
    BaseUrl: getNullableTrimmedString(input.BaseUrl) || getNullableTrimmedString(defaults.BaseUrl),
    ModelPath: getNullableTrimmedString(input.ModelPath) || getNullableTrimmedString(defaults.ModelPath),
    NumCtx: getFinitePositiveInteger(input.NumCtx, Number(defaults.NumCtx ?? 150_000)),
    NcpuMoe: getFiniteNonNegativeInteger(input.NcpuMoe, defaults.NcpuMoe),
    ParallelSlots: getFinitePositiveInteger(input.ParallelSlots, Number(defaults.ParallelSlots ?? 1)),
    UBatchSize: getFinitePositiveInteger(input.UBatchSize, Number(defaults.UBatchSize ?? SIFT_DEFAULT_ENGINE_UBATCH_SIZE)),
    CacheRam: getFiniteNonNegativeInteger(input.CacheRam, Number(defaults.CacheRam ?? SIFT_DEFAULT_ENGINE_CACHE_RAM)),
    CacheRecurrentRam: getFiniteNonNegativeInteger(
      input.CacheRecurrentRam,
      Number(defaults.CacheRecurrentRam ?? SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM),
    ),
    KvCacheQuantization: getModelKvCacheQuantization(
      input.KvCacheQuantization,
      defaults.KvCacheQuantization ?? SIFT_DEFAULT_ENGINE_KV_CACHE_QUANTIZATION,
    ),
    Temperature: getFiniteNumber(input.Temperature, Number(defaults.Temperature ?? 0.7)),
    TopP: getFiniteNumber(input.TopP, Number(defaults.TopP ?? 0.8)),
    TopK: getFiniteInteger(input.TopK, Number(defaults.TopK ?? 20)),
    MinP: getFiniteNumber(input.MinP, Number(defaults.MinP ?? 0.0)),
    PresencePenalty: getFiniteNumber(input.PresencePenalty, Number(defaults.PresencePenalty ?? 1.5)),
    RepetitionPenalty: getFiniteNumber(input.RepetitionPenalty, Number(defaults.RepetitionPenalty ?? 1.0)),
    Reasoning: reasoning === 'on' || reasoning === 'off'
      ? reasoning
      : defaults.Reasoning || 'off',
    // Effort is not zeroed when reasoning is off: the value is inert while thinking is off and
    // must survive a round trip through the toggle rather than silently losing the user's choice.
    ReasoningEffort: getReasoningEffort(input.ReasoningEffort, defaults.ReasoningEffort),
    ReasoningContent: reasoningContentEnabled,
    PreserveThinking: reasoningContentEnabled && input.PreserveThinking === true,
    MaintainPerStepThinking: reasoningEnabled && input.MaintainPerStepThinking !== false,
    SpeculativeEnabled: input.SpeculativeEnabled === true,
    SpeculativeDraftMax: getSpeculativeInteger(input.SpeculativeDraftMax, Number(defaults.SpeculativeDraftMax ?? 16)),
    SpeculativeDynamic: getBooleanWithDefault(input.SpeculativeDynamic, defaults.SpeculativeDynamic),
    ReasoningBudget: getFinitePositiveInteger(input.ReasoningBudget, Number(defaults.ReasoningBudget ?? SIFT_DEFAULT_ENGINE_REASONING_BUDGET)),
    ReasoningBudgetMessage: getNullableTrimmedString(input.ReasoningBudgetMessage)
      || getNullableTrimmedString(defaults.ReasoningBudgetMessage)
      || SIFT_DEFAULT_ENGINE_REASONING_BUDGET_MESSAGE,
    StartupTimeoutMs: getManagedStartupTimeoutMs(input.StartupTimeoutMs, Number(defaults.StartupTimeoutMs ?? 600_000)),
    HealthcheckTimeoutMs: getFinitePositiveInteger(input.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs ?? 2_000)),
    HealthcheckIntervalMs: getFinitePositiveInteger(input.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs ?? 1_000)),
    SleepIdleSeconds: getFinitePositiveInteger(input.SleepIdleSeconds, Number(defaults.SleepIdleSeconds ?? SIFT_DEFAULT_ENGINE_SLEEP_IDLE_SECONDS)),
    IdleAction: getModelIdleAction(input.IdleAction),
    VisionEnabled: getBooleanWithDefault(input.VisionEnabled, defaults.VisionEnabled),
    VisionOffload: getBooleanWithDefault(input.VisionOffload, defaults.VisionOffload),
    VisionImageRetention: getVisionImageRetention(input.VisionImageRetention),
    VisionMaxImagePixels: getFiniteNonNegativeInteger(
      input.VisionMaxImagePixels,
      Number(defaults.VisionMaxImagePixels ?? SIFT_DEFAULT_VISION_MAX_IMAGE_PIXELS),
    ),
  };
}

export function normalizeConfigObject(input: JsonValue): SiftConfig {
  const inputRecord = getRecord(input);
  const presetResult = SiftPresetCollectionSchema.safeParse(inputRecord.Presets);
  if (!presetResult.success) {
    throw new z.ZodError(presetResult.error.issues.map((issue) => ({
      ...issue,
      path: ['Presets', ...issue.path],
    })));
  }
  const presetCatalog = PresetCatalog.fromPresets(presetResult.data);
  const inputInference = getRecord(inputRecord.Inference);
  if ('SelectedBackend' in inputInference) {
    throw new Error('Unsupported configuration field Inference.SelectedBackend; select Backend on each model preset.');
  }
  const inputRuntime = getRecord(inputRecord.Runtime);
  if ('Model' in inputRuntime) {
    throw new Error('Unsupported configuration field Runtime.Model; use the active model preset Model field.');
  }
  const inputServer = getRecord(inputRecord.Server);
  if ('Exl3' in inputServer) {
    throw new Error('Unsupported configuration field Server.Exl3; use Server.Engines.Exl3.');
  }

  const merged = getRecord(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), input ?? {}));
  delete merged.Backend;
  delete merged.Paths;
  delete merged.Model;

  const runtime = getRecord(merged.Runtime);
  delete runtime.PromptPrefix;
  runtime.Engine = getRecord(runtime.Engine);
  merged.Runtime = runtime;

  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = getDefaultConfigObject().PromptPrefix ?? null;
  }

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
  merged.Presets = presetCatalog.list();
  merged.WebSearch = normalizeWebSearchConfig(merged.WebSearch);
  merged.Assistant = normalizeAssistantConfig(merged.Assistant);
  return SiftConfigSchema.parse(merged);
}

export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  return { config: normalizeConfigObject(JsonValueSchema.parse(config)), info: { changed: false } };
}

export function getRuntimeEngine(config: SiftConfig): RuntimeEngineConfig {
  return config.Runtime.Engine;
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
