import { z } from 'zod';
import { ReasoningEffortSchema } from '@siftkit/contracts';
import type {
  ModelKvCacheQuantization,
  ModelPresetField,
  ModelRuntimePreset,
} from '@siftkit/contracts';

/** How SiftKit shapes OpenAI-style chat requests for TabbyAPI. */
export const INFERENCE_REQUEST_COMPATIBILITY = {
  repetitionPenaltyKey: 'repetition_penalty',
  /** llama.cpp-era request fields TabbyAPI rejects; stripped from passthrough requests. */
  removedFields: ['repeat_penalty', 'cache_prompt', 'id_slot', 'timings_per_token'],
  /** TabbyAPI templates do not accept a `reasoning_content` kwarg. */
  reasoningContent: false,
} as const;

/**
 * Whether a field belongs on the active backend's form at all and, when it does, whether it can be
 * edited. A field the backend can never use is simply not there, so there is no disabled state to
 * explain; a field it can use only through a SiftKit-launched engine stays visible with the reason.
 */
export type PresetFieldAvailability =
  | { visible: false }
  | { visible: true; enabled: boolean; reason: string | null };

export const PresetRequestDefaultsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  minP: z.number(),
  presencePenalty: z.number(),
  repetitionPenalty: z.number(),
  reasoning: z.enum(['on', 'off']),
  reasoningEffort: ReasoningEffortSchema,
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
    reasoningEffort: preset.ReasoningEffort,
    reasoningContent: preset.ReasoningContent,
    preserveThinking: preset.PreserveThinking,
    maintainPerStepThinking: preset.MaintainPerStepThinking,
  };
}

export interface Exl3CacheModes {
  /** TabbyAPI `cache_mode`. */
  cache: string;
  /** TabbyAPI `draft_cache_mode`; null when EXL3 has no draft equivalent for the quantization. */
  draft: string | null;
}

export function getExl3CacheModes(value: ModelKvCacheQuantization): Exl3CacheModes {
  switch (value) {
    case 'f16': return { cache: 'FP16', draft: 'FP16' };
    case 'q8_0': return { cache: '8,8', draft: 'Q8' };
    case 'q4_0': return { cache: '4,4', draft: 'Q4' };
    case 'q5_0': return { cache: '5,5', draft: null };
    case 'q8_0/q4_0': return { cache: '8,4', draft: 'Q8' };
    case 'q8_0/q5_0': return { cache: '8,5', draft: 'Q8' };
  }
}

/**
 * How one preset field's support is decided. Every field names exactly one of these, so a field's
 * availability is stated in a single place.
 */
type PresetFieldSupport =
  /** Applies to any TabbyAPI endpoint. */
  | 'always'
  /** A launch setting; only an engine SiftKit launches can apply it. */
  | 'managed-only';

const PRESET_FIELD_SUPPORT = {
  Model: 'always',
  ExternalServerEnabled: 'always',
  BaseUrl: 'always',
  ModelPath: 'always',
  NumCtx: 'always',
  ParallelSlots: 'managed-only',
  UBatchSize: 'always',
  CacheRam: 'managed-only',
  CacheRecurrentRam: 'managed-only',
  KvCacheQuantization: 'always',
  MaxTokens: 'always',
  Temperature: 'always',
  TopP: 'always',
  TopK: 'always',
  MinP: 'always',
  PresencePenalty: 'always',
  RepetitionPenalty: 'always',
  Reasoning: 'always',
  ReasoningEffort: 'always',
  ReasoningContent: 'always',
  PreserveThinking: 'always',
  MaintainPerStepThinking: 'always',
  SpeculativeEnabled: 'managed-only',
  SpeculativeDraftMax: 'managed-only',
  SpeculativeDynamic: 'managed-only',
  ReasoningBudget: 'always',
  ReasoningBudgetMessage: 'always',
  StartupTimeoutMs: 'always',
  HealthcheckTimeoutMs: 'always',
  HealthcheckIntervalMs: 'always',
  SleepIdleSeconds: 'always',
  IdleAction: 'always',
  VisionEnabled: 'managed-only',
  VisionOffload: 'managed-only',
  VisionImageRetention: 'managed-only',
  VisionMaxImagePixels: 'managed-only',
} as const satisfies Record<ModelPresetField, PresetFieldSupport>;

const AVAILABLE = { visible: true, enabled: true, reason: null } as const;
const NEEDS_MANAGED_TABBY = {
  visible: true,
  enabled: false,
  reason: 'Requires SiftKit-managed TabbyAPI',
} as const;

/**
 * Single source of truth for how a field appears on the settings form. Every decision the form
 * makes about a field comes from here, so the form never carries its own copy of the rules.
 */
export function getPresetFieldAvailability(
  preset: ModelRuntimePreset,
  field: ModelPresetField,
): PresetFieldAvailability {
  switch (PRESET_FIELD_SUPPORT[field]) {
    case 'always':
      return AVAILABLE;
    case 'managed-only':
      return preset.ExternalServerEnabled ? NEEDS_MANAGED_TABBY : AVAILABLE;
  }
}
