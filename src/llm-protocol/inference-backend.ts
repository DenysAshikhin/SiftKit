import type { InferenceBackendId } from '../config/types.js';
import type {
  LlamaCppChatMessage,
  LlamaCppChatTemplateKwargs,
  LlamaCppResponseFormat,
  LlamaCppToolDefinition,
} from './types.js';

export type InferenceThinkingPolicy = {
  enabled?: boolean;
  preserve: boolean;
  reasoningContent: boolean;
};

export type InferenceRequestInput = {
  backend: InferenceBackendId;
  model: string;
  messages: LlamaCppChatMessage[];
  tools: LlamaCppToolDefinition[];
  maxTokens: number;
  temperature?: number;
  stream: boolean;
  responseFormat?: LlamaCppResponseFormat;
  thinking: InferenceThinkingPolicy;
  llama: {
    cachePrompt: boolean;
    slotId?: number;
  };
};

export type InferenceChatRequest = {
  model: string;
  messages: LlamaCppChatMessage[];
  temperature?: number;
  max_tokens: number;
  stream: boolean;
  tools?: LlamaCppToolDefinition[];
  parallel_tool_calls?: boolean;
  response_format?: LlamaCppResponseFormat;
  chat_template_kwargs?: LlamaCppChatTemplateKwargs;
  cache_prompt?: boolean;
  id_slot?: number;
  timings_per_token?: boolean;
};
