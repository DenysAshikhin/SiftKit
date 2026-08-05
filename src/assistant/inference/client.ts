import { getActiveInferenceBackend, getConfiguredModel, type SiftConfig } from '../../config/index.js';
import type { JsonObject } from '../../lib/json-types.js';
import { LlamaCppClient, type LlamaCppChatOptions } from '../../llm-protocol/llama-cpp-client.js';
import { buildLlamaJsonSchemaResponseFormat } from '../../providers/structured-output-schema.js';
import type { NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';
import type { AssistantInferenceRole } from './roles.js';

export interface AssistantInferenceRequest {
  readonly role: AssistantInferenceRole;
  readonly systemPrompt: string;
  /** Untrusted evidence text. A string, always — this is the no-image invariant (§12.6). */
  readonly userText: string;
  readonly responseSchemaName: string;
  readonly responseJsonSchema: JsonObject;
  readonly abortSignal: AbortSignal | null;
}

export interface AssistantInferenceResult {
  readonly text: string;
  readonly backendId: string;
  readonly modelId: string;
}

export interface AssistantInferenceClient {
  complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult>;
}

/** The narrow slice of `LlamaCppClient` the assistant uses, so tests can supply a recorder. */
export interface AssistantChatBackend {
  chat(options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse>;
}

/** Assistant extraction never needs a long answer; JSON candidates are small. */
const ASSISTANT_MAX_OUTPUT_TOKENS = 2_048;

const ASSISTANT_REQUEST_TIMEOUT_SECONDS = 120;

/**
 * The assistant's only path to a model. It shares SiftKit's GPU-locked runtime, sends no tools,
 * and has no branch that can emit an image part (§12.6, §20.1).
 */
export class LlamaCppAssistantInference implements AssistantInferenceClient {
  constructor(
    private readonly config: SiftConfig,
    private readonly backend: AssistantChatBackend = new LlamaCppClient(),
  ) {}

  async complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult> {
    if (request.abortSignal?.aborted === true) {
      throw new Error('Assistant inference aborted before the request was issued.');
    }
    const response = await this.backend.chat({
      config: this.config,
      model: getConfiguredModel(this.config),
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userText },
      ],
      tools: [],
      allowedToolNames: [],
      maxTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      stream: false,
      responseFormat: buildLlamaJsonSchemaResponseFormat({
        name: request.responseSchemaName,
        schema: request.responseJsonSchema,
      }),
      requestTimeoutSeconds: ASSISTANT_REQUEST_TIMEOUT_SECONDS,
      reasoningOverride: 'off',
      ...(request.abortSignal === null ? {} : { abortSignal: request.abortSignal }),
    });
    return {
      text: response.text,
      backendId: getActiveInferenceBackend(this.config),
      modelId: getConfiguredModel(this.config),
    };
  }
}