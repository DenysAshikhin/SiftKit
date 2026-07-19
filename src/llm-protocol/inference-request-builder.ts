import type { InferenceChatRequest, InferenceRequestInput } from './inference-backend.js';

export class InferenceRequestBuilder {
  build(input: InferenceRequestInput): InferenceChatRequest {
    return input.backend === 'llama'
      ? this.buildLlamaRequest(input)
      : this.buildExl3Request(input);
  }

  private buildCommonRequest(
    input: InferenceRequestInput,
    includeTools: boolean,
    includeResponseFormat: boolean,
  ): InferenceChatRequest {
    const sampling = {
      max_tokens: input.overrides.maxTokens ?? input.defaults.maxTokens,
      temperature: input.overrides.temperature ?? input.defaults.temperature,
      top_p: input.overrides.topP ?? input.defaults.topP,
      top_k: input.overrides.topK ?? input.defaults.topK,
      min_p: input.overrides.minP ?? input.defaults.minP,
      presence_penalty: input.overrides.presencePenalty ?? input.defaults.presencePenalty,
    };
    return {
      model: input.model,
      messages: input.messages,
      ...sampling,
      stream: input.stream,
      ...(includeTools && input.tools.length > 0 ? { tools: input.tools, parallel_tool_calls: true } : {}),
      ...(includeResponseFormat && input.responseFormat ? { response_format: input.responseFormat } : {}),
    };
  }

  private buildLlamaRequest(input: InferenceRequestInput): InferenceChatRequest {
    return {
      ...this.buildCommonRequest(input, true, true),
      repeat_penalty: input.overrides.repetitionPenalty ?? input.defaults.repetitionPenalty,
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
      ...this.buildCommonRequest(input, false, false),
      repetition_penalty: input.overrides.repetitionPenalty ?? input.defaults.repetitionPenalty,
      ...(input.thinking.enabled === undefined ? {} : {
        chat_template_kwargs: {
          enable_thinking: input.thinking.enabled,
          ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
        },
      }),
    };
  }
}
