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

export type LlamaCppToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
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
