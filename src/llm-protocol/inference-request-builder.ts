import type { InferenceChatRequest, InferenceRequestInput } from './inference-backend.js';
import { getInferenceRequestCompatibility } from '../inference-presets/request-compatibility.js';
import { lowerResponseFormatForBackend } from '../providers/formatron-schema-lowering.js';

export class InferenceRequestBuilder {
  build(input: InferenceRequestInput): InferenceChatRequest {
    const compatibility = getInferenceRequestCompatibility(input.backend);
    return {
      ...this.buildCommonRequest(input),
      [compatibility.repetitionPenaltyKey]: input.defaults.repetitionPenalty,
      ...(input.backend === 'llama'
        ? {
            cache_prompt: input.llama.cachePrompt,
            ...(Number.isInteger(input.llama.slotId) ? { id_slot: input.llama.slotId } : {}),
            ...(input.stream ? { timings_per_token: true } : {}),
          }
        : {}),
      ...(input.thinking.enabled === undefined
        ? {}
        : {
            chat_template_kwargs: {
              enable_thinking: input.thinking.enabled,
              ...(compatibility.reasoningContent && input.thinking.reasoningContent ? { reasoning_content: true } : {}),
              ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
              // The template only reads effort while thinking is on, so sending it otherwise
              // would change nothing while still breaking prompt-prefix reuse.
              ...(input.thinking.enabled ? { reasoning_effort: input.thinking.effort } : {}),
            },
          }),
    };
  }

  private buildCommonRequest(input: InferenceRequestInput): InferenceChatRequest {
    const sampling = {
      max_tokens: input.maxTokens,
      temperature: input.defaults.temperature,
      top_p: input.defaults.topP,
      top_k: input.defaults.topK,
      min_p: input.defaults.minP,
      presence_penalty: input.defaults.presencePenalty,
    };
    return {
      model: input.model,
      messages: input.messages,
      ...sampling,
      stream: input.stream,
      ...(input.stream ? { stream_options: { include_usage: true } } : {}),
      ...(input.tools.length > 0 ? { tools: input.tools, parallel_tool_calls: true } : {}),
      ...(input.responseFormat
        ? {
            response_format: lowerResponseFormatForBackend(input.backend, input.responseFormat),
          }
        : {}),
      ...(input.responsePrefix ? { response_prefix: input.responsePrefix } : {}),
    };
  }
}
