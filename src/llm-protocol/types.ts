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

// JSON-schema fragment describing a single tool parameter (or the parameters object
// itself). The `[key: string]: unknown` index keeps it both precisely typed (callers
// and tests read `.enum`/`.properties.x.type` directly) and a structural supertype of a
// plain JsonObject, so dynamically-built tool schemas assign to it without a cast.
export type LlamaCppToolParameterSchema = {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: LlamaCppToolParameterSchema;
  properties?: Record<string, LlamaCppToolParameterSchema>;
  required?: readonly string[];
  [key: string]: unknown;
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

export type NormalizedLlamaCppChatResponse = {
  text: string;
  reasoningText: string;
  toolCalls: LlamaCppToolCall[];
  usage: LlamaCppUsage;
  raw: JsonObject;
  stoppedEarly: boolean;
  /** Frames that failed JSON parsing and were skipped. Always 0 on a healthy stream. */
  invalidFrameCount: number;
  earlyStopReason?: string;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};
