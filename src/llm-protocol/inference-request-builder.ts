import type { InferenceChatRequest, InferenceRequestInput } from './inference-backend.js';

export class InferenceRequestBuilder {
  build(input: InferenceRequestInput): InferenceChatRequest {
    return input.backend === 'llama'
      ? this.buildLlamaRequest(input)
      : this.buildExl3Request(input);
  }

  private buildCommonRequest(input: InferenceRequestInput): InferenceChatRequest {
    return {
      model: input.model,
      messages: input.messages,
      ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
      max_tokens: input.maxTokens,
      stream: input.stream,
      ...(input.tools.length > 0 ? { tools: input.tools, parallel_tool_calls: true } : {}),
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    };
  }

  private buildLlamaRequest(input: InferenceRequestInput): InferenceChatRequest {
    return {
      ...this.buildCommonRequest(input),
      cache_prompt: input.llama.cachePrompt,
      ...(Number.isInteger(input.llama.slotId) ? { id_slot: input.llama.slotId } : {}),
      ...(input.stream ? { timings_per_token: true } : {}),
      ...(input.thinking.enabled === undefined ? {} : {
        chat_template_kwargs: {
          enable_thinking: input.thinking.enabled,
          ...(input.thinking.reasoningContent ? { reasoning_content: true } : {}),
          ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
        },
      }),
    };
  }

  private buildExl3Request(input: InferenceRequestInput): InferenceChatRequest {
    return {
      ...this.buildCommonRequest(input),
      ...(input.thinking.enabled === undefined ? {} : {
        chat_template_kwargs: {
          enable_thinking: input.thinking.enabled,
          ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
        },
      }),
    };
  }
}
