import type { ReasoningEffort } from '@siftkit/contracts';
import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';

export type { JsonObject, JsonValue } from '../lib/json-types.js';

export const INFERENCE_PROTOCOL_FORMAT = 'openai-compatible' as const;

export type InferenceChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type InferenceContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
};

export type InferenceReasoningPart = {
  type?: string;
  text?: string;
};

export type InferenceToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type InferenceChatMessage = {
  role: InferenceChatRole;
  content: string | InferenceContentPart[] | null;
  reasoning_content?: string | InferenceReasoningPart[] | null;
  tool_call_id?: string;
  tool_calls?: InferenceToolCall[];
};

export const InferenceToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string(),
    parameters: JsonObjectSchema,
  }),
});
export const InferenceToolDefinitionsSchema = z.array(InferenceToolDefinitionSchema);
export type InferenceToolDefinition = z.infer<typeof InferenceToolDefinitionSchema>;

export type InferenceResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: JsonObject };

export type InferenceChatTemplateKwargs = {
  enable_thinking?: boolean;
  reasoning_content?: boolean;
  preserve_thinking?: boolean;
  reasoning_effort?: ReasoningEffort;
};

export type InferenceChatRequest = {
  model: string;
  messages: InferenceChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
  repetition_penalty?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: InferenceToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  response_format?: InferenceResponseFormat;
  chat_template_kwargs?: InferenceChatTemplateKwargs;
  response_prefix?: string;
};

export type InferenceUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
};

export type LiveContentClassification = 'undecided' | 'narration' | 'tool_control';

export type LiveContentResult = {
  /** Safe ordinary content. Kept as the provider-facing compatibility name for consumers. */
  text: string;
  rawText: string;
  narrationText: string;
  classification: LiveContentClassification;
};

/** Backend `eos_reason` reported when the backend cut a repetition loop. */
export const LOOP_DETECTED_EOS_REASON = 'loop_detected';
/** OpenAI-style `finish_reason` reported when the max-token cap was hit. */
export const LENGTH_FINISH_REASON = 'length';
/** Client early-stop reason set when streamed thinking exceeds the preset ReasoningBudget on exl3. */
export const THINKING_BUDGET_EARLY_STOP_REASON = 'thinking budget exhausted';

/**
 * How generation ended: the raw wire signals plus the client's own cut. Produced once by the
 * client and carried unchanged to `describeStreamTruncation`, the only interpreter. Nothing is
 * normalized here, so a clean OpenAI-style stream still carries `finishReason: 'stop'`.
 */
export const StreamStopSchema = z.strictObject({
  /** Set when the client itself cut the stream (thinking budget). */
  earlyStopReason: z.string().nullable(),
  /** Backend `choices[].eos_reason` (TabbyAPI/exl3); the last non-empty frame wins. */
  backendEosReason: z.string().nullable(),
  /** OpenAI-style `choices[].finish_reason`; the last non-empty frame wins. */
  finishReason: z.string().nullable(),
});
export type StreamStop = z.infer<typeof StreamStopSchema>;

/** No stop signal at all: mock responses and producers that have no stream behind them. */
export const CLEAN_STREAM_STOP: StreamStop = Object.freeze(StreamStopSchema.parse({
  earlyStopReason: null,
  backendEosReason: null,
  finishReason: null,
}));

export type NormalizedInferenceChatResponse = LiveContentResult & {
  reasoningText: string;
  toolCalls: InferenceToolCall[];
  usage: InferenceUsage;
  raw: JsonObject;
  stop: StreamStop;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};
