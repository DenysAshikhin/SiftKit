export const LLAMA_CPP_PROTOCOL_FORMAT = 'openai-compatible' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

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

export type LlamaCppToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: LlamaCppToolParameterSchema;
  };
};

export type LlamaCppResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: JsonObject };

export type LlamaCppChatTemplateKwargs = {
  enable_thinking?: boolean;
  reasoning_content?: boolean;
  preserve_thinking?: boolean;
};

export type LlamaCppChatRequest = {
  model: string;
  messages: LlamaCppChatMessage[];
  temperature?: number;
  max_tokens?: number;
  cache_prompt?: boolean;
  id_slot?: number;
  stream?: boolean;
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
};

export type NormalizedLlamaCppChatResponse = {
  text: string;
  reasoningText: string;
  toolCalls: LlamaCppToolCall[];
  usage: LlamaCppUsage;
  raw: JsonObject;
  stoppedEarly: boolean;
  earlyStopReason?: string;
};
