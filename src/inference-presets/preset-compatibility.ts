import { z } from 'zod';
import type {
  ManagedLlamaKvCacheQuantization,
  ModelPresetField,
  ModelRuntimePreset,
} from '@siftkit/contracts';

export interface PresetFieldAvailability {
  enabled: boolean;
  reason: string | null;
}

/** Which backends a field means anything for at all, independent of managed/external. */
export type PresetFieldBackendScope = 'llama-only' | 'exl3-only' | 'both';

export const PresetRequestDefaultsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  minP: z.number(),
  presencePenalty: z.number(),
  repetitionPenalty: z.number(),
  reasoning: z.enum(['on', 'off']),
  reasoningContent: z.boolean(),
  preserveThinking: z.boolean(),
  maintainPerStepThinking: z.boolean(),
});
export type PresetRequestDefaults = z.infer<typeof PresetRequestDefaultsSchema>;

export function buildPresetRequestDefaults(preset: ModelRuntimePreset): PresetRequestDefaults {
  return {
    maxTokens: preset.MaxTokens,
    temperature: preset.Temperature,
    topP: preset.TopP,
    topK: preset.TopK,
    minP: preset.MinP,
    presencePenalty: preset.PresencePenalty,
    repetitionPenalty: preset.RepetitionPenalty,
    reasoning: preset.Reasoning,
    reasoningContent: preset.ReasoningContent,
    preserveThinking: preset.PreserveThinking,
    maintainPerStepThinking: preset.MaintainPerStepThinking,
  };
}

export interface Exl3CacheModes {
  /** TabbyAPI `cache_mode`; null overall when EXL3 cannot express the quantization at all. */
  cache: string;
  /** TabbyAPI `draft_cache_mode`; null when EXL3 has no draft equivalent for the quantization. */
  draft: string | null;
}

export function getExl3CacheModes(value: ManagedLlamaKvCacheQuantization): Exl3CacheModes | null {
  switch (value) {
    case 'f16': return { cache: 'FP16', draft: 'FP16' };
    case 'q8_0': return { cache: '8,8', draft: 'Q8' };
    case 'q4_0': return { cache: '4,4', draft: 'Q4' };
    case 'q5_0': return { cache: '5,5', draft: null };
    case 'q8_0/q4_0': return { cache: '8,4', draft: 'Q8' };
    case 'q8_0/q5_0': return { cache: '8,5', draft: 'Q8' };
    case 'f32':
    case 'bf16':
    case 'q4_1':
    case 'iq4_nl':
    case 'q5_1':
      return null;
  }
}

/**
 * How one preset field's backend support is decided. Every field names exactly one of these, so a
 * field's availability is stated in a single place and no backend gets a blanket enable.
 */
type PresetFieldSupport =
  /** Both backends accept it. */
  | 'both'
  /** llama.cpp launch or sampler setting with no EXL3 equivalent. */
  | 'llama-only'
  /** Both accept it, but EXL3 can only apply it to an engine SiftKit launches. */
  | 'exl3-managed-only'
  /** Both accept it; EXL3 narrows the choices to the modes `getExl3CacheModes` can express. */
  | 'exl3-cache-modes'
  /** EXL3-managed only; llama.cpp has no equivalent at all, so it is disabled there. */
  | 'exl3-managed-only-unsupported-by-llama';

const PRESET_FIELD_SUPPORT = {
  Model: 'both',
  ExternalServerEnabled: 'both',
  ExecutablePath: 'llama-only',
  BaseUrl: 'both',
  BindHost: 'llama-only',
  Port: 'llama-only',
  ModelPath: 'both',
  NumCtx: 'both',
  GpuLayers: 'llama-only',
  Threads: 'llama-only',
  NcpuMoe: 'llama-only',
  FlashAttention: 'llama-only',
  ParallelSlots: 'exl3-managed-only',
  BatchSize: 'llama-only',
  UBatchSize: 'both',
  CacheRam: 'exl3-managed-only',
  CacheRecurrentRam: 'exl3-managed-only-unsupported-by-llama',
  KvCacheQuantization: 'exl3-cache-modes',
  MaxTokens: 'both',
  Temperature: 'both',
  TopP: 'both',
  TopK: 'both',
  MinP: 'both',
  PresencePenalty: 'both',
  RepetitionPenalty: 'both',
  Reasoning: 'both',
  ReasoningContent: 'both',
  PreserveThinking: 'both',
  MaintainPerStepThinking: 'both',
  SpeculativeEnabled: 'exl3-managed-only',
  SpeculativeType: 'exl3-managed-only',
  SpeculativeMtpEnabled: 'llama-only',
  SpeculativeNgramSizeN: 'llama-only',
  SpeculativeNgramSizeM: 'llama-only',
  SpeculativeNgramMinHits: 'llama-only',
  SpeculativeNgramModNMatch: 'llama-only',
  SpeculativeNgramModNMin: 'llama-only',
  SpeculativeNgramModNMax: 'llama-only',
  SpeculativeDraftMax: 'exl3-managed-only',
  SpeculativeDynamic: 'exl3-managed-only-unsupported-by-llama',
  SpeculativeDraftMin: 'llama-only',
  ReasoningBudget: 'llama-only',
  ReasoningBudgetMessage: 'llama-only',
  StartupTimeoutMs: 'both',
  HealthcheckTimeoutMs: 'both',
  HealthcheckIntervalMs: 'both',
  SleepIdleSeconds: 'both',
  VerboseLogging: 'llama-only',
  VisionEnabled: 'exl3-managed-only-unsupported-by-llama',
} as const satisfies Record<ModelPresetField, PresetFieldSupport>;

/**
 * Single source of truth for whether a field belongs on a backend's settings form at all.
 * Fields the active backend can never use are hidden; fields it can use but only when SiftKit
 * launches the engine stay visible and `getPresetFieldAvailability` explains why they are disabled.
 */
export function getPresetFieldBackendScope(field: ModelPresetField): PresetFieldBackendScope {
  switch (PRESET_FIELD_SUPPORT[field]) {
    case 'llama-only':
      return 'llama-only';
    case 'exl3-managed-only-unsupported-by-llama':
      return 'exl3-only';
    case 'both':
    case 'exl3-managed-only':
    case 'exl3-cache-modes':
      return 'both';
  }
}

export function getPresetFieldAvailability(
  preset: ModelRuntimePreset,
  field: ModelPresetField,
): PresetFieldAvailability {
  switch (PRESET_FIELD_SUPPORT[field]) {
    case 'both':
      return { enabled: true, reason: null };
    case 'llama-only':
      return preset.Backend === 'llama'
        ? { enabled: true, reason: null }
        : { enabled: false, reason: 'Not supported by EXL3' };
    case 'exl3-managed-only':
      return preset.Backend === 'llama' || !preset.ExternalServerEnabled
        ? { enabled: true, reason: null }
        : { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' };
    case 'exl3-cache-modes':
      return preset.Backend === 'llama'
        ? { enabled: true, reason: null }
        : { enabled: true, reason: 'Only EXL3-compatible cache modes are available' };
    case 'exl3-managed-only-unsupported-by-llama':
      return preset.Backend === 'llama'
        ? { enabled: false, reason: 'Not supported by llama.cpp' }
        : !preset.ExternalServerEnabled
          ? { enabled: true, reason: null }
          : { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' };
  }
}
