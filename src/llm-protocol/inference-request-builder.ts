import type { InferenceChatRequest, InferenceRequestInput } from './inference-backend.js';
import { getInferenceRequestCompatibility } from '../inference-presets/request-compatibility.js';

export class InferenceRequestBuilder {
  build(input: InferenceRequestInput): InferenceChatRequest {
    const compatibility = getInferenceRequestCompatibility(input.backend);
    return {
      ...this.buildCommonRequest(input),
      [compatibility.repetitionPenaltyKey]: input.overrides.repetitionPenalty ?? input.defaults.repetitionPenalty,
      ...(input.backend === 'llama' ? {
        cache_prompt: input.llama.cachePrompt,
        ...(Number.isInteger(input.llama.slotId) ? { id_slot: input.llama.slotId } : {}),
        ...(input.stream ? { timings_per_token: true } : {}),
      } : {}),
      ...(input.thinking.enabled === undefined ? {} : {
        chat_template_kwargs: {
          enable_thinking: input.thinking.enabled,
          ...(compatibility.reasoningContent && input.thinking.reasoningContent ? { reasoning_content: true } : {}),
          ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
        },
      }),
    };
  }

  private buildCommonRequest(input: InferenceRequestInput): InferenceChatRequest {
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
      ...(input.tools.length > 0 ? { tools: input.tools, parallel_tool_calls: true } : {}),
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    };
  }
}
