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

export function getPresetFieldAvailability(
  preset: ModelRuntimePreset,
  field: ModelPresetField,
): PresetFieldAvailability {
  if (preset.Backend === 'llama') return { enabled: true, reason: null };

  if (field === 'UBatchSize') return { enabled: true, reason: null };
  if (
    field === 'ParallelSlots'
    || field === 'SpeculativeEnabled'
    || field === 'SpeculativeType'
    || field === 'SpeculativeDraftMax'
  ) {
    return preset.ExternalServerEnabled
      ? { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' }
      : { enabled: true, reason: null };
  }

  switch (field) {
    case 'ExecutablePath':
    case 'BindHost':
    case 'Port':
    case 'GpuLayers':
    case 'Threads':
    case 'NcpuMoe':
    case 'FlashAttention':
    case 'BatchSize':
    case 'CacheRam':
    case 'ReasoningBudget':
    case 'ReasoningBudgetMessage':
    case 'SpeculativeMtpEnabled':
    case 'SpeculativeDraftMin':
    case 'SpeculativeNgramSizeN':
    case 'SpeculativeNgramSizeM':
    case 'SpeculativeNgramMinHits':
    case 'SpeculativeNgramModNMatch':
    case 'SpeculativeNgramModNMin':
    case 'SpeculativeNgramModNMax':
    case 'VerboseLogging':
      return { enabled: false, reason: 'Not supported by EXL3' };
    case 'KvCacheQuantization':
      return { enabled: true, reason: 'Only EXL3-compatible cache modes are available' };
    case 'Model':
    case 'ExternalServerEnabled':
    case 'BaseUrl':
    case 'ModelPath':
    case 'NumCtx':
    case 'MaxTokens':
    case 'Temperature':
    case 'TopP':
    case 'TopK':
    case 'MinP':
    case 'PresencePenalty':
    case 'RepetitionPenalty':
    case 'Reasoning':
    case 'ReasoningContent':
    case 'PreserveThinking':
    case 'MaintainPerStepThinking':
    case 'StartupTimeoutMs':
    case 'HealthcheckTimeoutMs':
    case 'HealthcheckIntervalMs':
    case 'SleepIdleSeconds':
      return { enabled: true, reason: null };
  }
}
