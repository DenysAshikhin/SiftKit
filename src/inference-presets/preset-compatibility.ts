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

export const PresetRequestDefaultsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  minP: z.number(),
  presencePenalty: z.number(),
  repetitionPenalty: z.number(),
  penaltyRange: z.number(),
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
    penaltyRange: preset.PenaltyRange,
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
  /** TabbyAPI-only sampler setting llama.cpp does not accept. */
  | 'exl3-only'
  /** Both accept it, but EXL3 can only apply it to an engine SiftKit launches. */
  | 'exl3-managed-only'
  /** Both accept it; EXL3 narrows the choices to the modes `getExl3CacheModes` can express. */
  | 'exl3-cache-modes';

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
  CacheRam: 'llama-only',
  KvCacheQuantization: 'exl3-cache-modes',
  MaxTokens: 'both',
  Temperature: 'both',
  TopP: 'both',
  TopK: 'both',
  MinP: 'both',
  PresencePenalty: 'both',
  RepetitionPenalty: 'both',
  PenaltyRange: 'exl3-only',
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
  SpeculativeDraftMin: 'llama-only',
  ReasoningBudget: 'llama-only',
  ReasoningBudgetMessage: 'llama-only',
  StartupTimeoutMs: 'both',
  HealthcheckTimeoutMs: 'both',
  HealthcheckIntervalMs: 'both',
  SleepIdleSeconds: 'both',
  VerboseLogging: 'llama-only',
} as const satisfies Record<ModelPresetField, PresetFieldSupport>;

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
    case 'exl3-only':
      return preset.Backend === 'exl3'
        ? { enabled: true, reason: null }
        : { enabled: false, reason: 'Not supported by llama.cpp' };
    case 'exl3-managed-only':
      return preset.Backend === 'llama' || !preset.ExternalServerEnabled
        ? { enabled: true, reason: null }
        : { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' };
    case 'exl3-cache-modes':
      return preset.Backend === 'llama'
        ? { enabled: true, reason: null }
        : { enabled: true, reason: 'Only EXL3-compatible cache modes are available' };
  }
}
