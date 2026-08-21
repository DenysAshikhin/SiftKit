import type { ReasoningEffort } from '@siftkit/contracts';
import type { InferenceBackendId } from '../config/types.js';
import type { PresetRequestDefaults } from '../inference-presets/preset-compatibility.js';
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
  /** Reasoning depth for the chat template; only sent when thinking is on. */
  effort: ReasoningEffort;
};

export type InferenceRequestInput = {
  backend: InferenceBackendId;
  model: string;
  messages: LlamaCppChatMessage[];
  tools: LlamaCppToolDefinition[];
  defaults: PresetRequestDefaults;
  /** The only per-request sampling value; every other sampler comes from `defaults`. */
  maxTokens: number;
  responseFormat?: LlamaCppResponseFormat;
  /** Rendered after the generation prompt (TabbyAPI `response_prefix`); used to close an exhausted think block. */
  responsePrefix?: string;
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
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
  repetition_penalty?: number;
  max_tokens: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: LlamaCppToolDefinition[];
  parallel_tool_calls?: boolean;
  response_format?: LlamaCppResponseFormat;
  chat_template_kwargs?: LlamaCppChatTemplateKwargs;
  cache_prompt?: boolean;
  id_slot?: number;
  timings_per_token?: boolean;
  response_prefix?: string;
};
