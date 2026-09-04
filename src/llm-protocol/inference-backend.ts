import type { ReasoningEffort } from '@siftkit/contracts';
import type { InferenceBackendId } from '../config/types.js';
import type { PresetRequestDefaults } from '../inference-presets/preset-compatibility.js';
import type {
  InferenceChatMessage,
  InferenceChatRequest,
  InferenceResponseFormat,
  InferenceToolDefinition,
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
  messages: InferenceChatMessage[];
  tools: InferenceToolDefinition[];
  defaults: PresetRequestDefaults;
  /** The only per-request sampling value; every other sampler comes from `defaults`. */
  maxTokens: number;
  toolChoice?: InferenceChatRequest['tool_choice'];
  responseFormat?: InferenceResponseFormat;
  /** Rendered after the generation prompt (TabbyAPI `response_prefix`); used to close an exhausted think block. */
  responsePrefix?: string;
  thinking: InferenceThinkingPolicy;
};
