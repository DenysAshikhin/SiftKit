import type { ReasoningEffort } from '@siftkit/contracts';
import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';

export type { JsonObject, JsonValue } from '../lib/json-types.js';

export const LLAMA_CPP_PROTOCOL_FORMAT = 'openai-compatible' as const;

export type LlamaCppChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlamaCppContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
};

export type LlamaCppReasoningPart = {
  type?: string;
  text?: string;
};

export type LlamaCppToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type LlamaCppChatMessage = {
  role: LlamaCppChatRole;
  content: string | LlamaCppContentPart[] | null;
  reasoning_content?: string | LlamaCppReasoningPart[] | null;
  tool_call_id?: string;
  tool_calls?: LlamaCppToolCall[];
};

export const LlamaCppToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string(),
    parameters: JsonObjectSchema,
  }),
});
export const LlamaCppToolDefinitionsSchema = z.array(LlamaCppToolDefinitionSchema);
export type LlamaCppToolDefinition = z.infer<typeof LlamaCppToolDefinitionSchema>;

export type LlamaCppResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: JsonObject };

export type LlamaCppChatTemplateKwargs = {
  enable_thinking?: boolean;
  reasoning_content?: boolean;
  preserve_thinking?: boolean;
  reasoning_effort?: ReasoningEffort;
};

export type LlamaCppChatRequest = {
  model: string;
  messages: LlamaCppChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
  repetition_penalty?: number;
  max_tokens?: number;
  cache_prompt?: boolean;
  id_slot?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: LlamaCppToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  response_format?: LlamaCppResponseFormat;
  chat_template_kwargs?: LlamaCppChatTemplateKwargs;
};

export type LlamaCppUsage = {
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

export type NormalizedLlamaCppChatResponse = LiveContentResult & {
  reasoningText: string;
  toolCalls: LlamaCppToolCall[];
  usage: LlamaCppUsage;
  raw: JsonObject;
  stop: StreamStop;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};
