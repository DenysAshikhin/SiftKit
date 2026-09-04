import type { ImageDataUrl } from '@siftkit/contracts';

import {
  getActiveInferenceBackend, getConfiguredModel,
  type ModelRuntimePreset, type SiftConfig,
} from '../../config/index.js';
import type { JsonObject } from '../../lib/json-types.js';
import { buildUserContent } from '../../llm-protocol/image-attachments.js';
import { InferenceClient, type InferenceChatOptions } from '../../llm-protocol/inference-client.js';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.js';
import { buildInferenceJsonSchemaResponseFormat } from '../../providers/structured-output-schema.js';
import type { InferenceContentPart, NormalizedInferenceChatResponse } from '../../llm-protocol/types.js';
import type { AssistantInferenceRole } from './roles.js';

interface AssistantInferenceRequestBase {
  readonly role: AssistantInferenceRole;
  readonly systemPrompt: string;
  /** Untrusted evidence text. */
  readonly userText: string;
  readonly responseSchemaName: string;
  readonly responseJsonSchema: JsonObject;
  readonly abortSignal: AbortSignal | null;
}

/**
 * The text variant carries no image field at all, so a caller cannot smuggle pixels into a text
 * role by accident — the shape itself refuses it.
 */
export interface AssistantTextInferenceRequest extends AssistantInferenceRequestBase {
  readonly kind: 'text';
}

export interface AssistantImageInferenceRequest extends AssistantInferenceRequestBase {
  readonly kind: 'image';
  readonly images: readonly ImageDataUrl[];
}

export type AssistantInferenceRequest =
  AssistantTextInferenceRequest | AssistantImageInferenceRequest;

export interface AssistantInferenceResult {
  readonly text: string;
  readonly backendId: string;
  readonly modelId: string;
}

export interface AssistantInferenceClient {
  complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult>;
}

/** The narrow slice of `InferenceClient` the assistant uses, so tests can supply a recorder. */
export interface AssistantChatBackend {
  chat(options: InferenceChatOptions): Promise<NormalizedInferenceChatResponse>;
}

/**
 * The preset the runtime is currently *running* — `AppliedModelPresetState` in the status server.
 * Image admission reads it rather than the config so it cannot disagree with the capability gate
 * that decided to enqueue the extraction in the first place (spec §5).
 */
export interface ActiveModelPresetSource {
  getPreset(): ModelRuntimePreset;
}

/** Assistant extraction never needs a long answer; JSON candidates are small. */
const ASSISTANT_MAX_OUTPUT_TOKENS = 2_048;

const ASSISTANT_IDLE_TIMEOUT_SECONDS = 120;

/**
 * The assistant's only path to a model. It shares SiftKit's GPU-locked runtime, sends no tools,
 * and always pins a JSON schema on the answer — for text and image roles alike (§20.1). Images
 * pass through the same admission the chat surface uses; nothing here re-implements those limits.
 */
export class DefaultAssistantInferenceClient implements AssistantInferenceClient {
  constructor(
    private readonly config: SiftConfig,
    private readonly presets: ActiveModelPresetSource,
    private readonly backend: AssistantChatBackend = new InferenceClient(),
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
        { role: 'user', content: this.buildUserMessage(request) },
      ],
      tools: [],
      allowedToolNames: [],
      maxTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      responseFormat: buildInferenceJsonSchemaResponseFormat({
        name: request.responseSchemaName,
        schema: request.responseJsonSchema,
      }),
      idleTimeoutSeconds: ASSISTANT_IDLE_TIMEOUT_SECONDS,
      reasoningOverride: 'off',
      ...(request.abortSignal === null ? {} : { abortSignal: request.abortSignal }),
    });
    return {
      text: response.text,
      backendId: getActiveInferenceBackend(this.config),
      modelId: getConfiguredModel(this.config),
    };
  }

  private buildUserMessage(
    request: AssistantInferenceRequest,
  ): string | InferenceContentPart[] {
    if (request.kind === 'text') return request.userText;
    if (request.images.length === 0) {
      throw new Error('An image inference request must carry at least one image.');
    }
    const admitted = admitImagesForPreset(this.presets.getPreset(), request.images);
    return buildUserContent(request.userText, admitted.map((image) => image.dataUrl));
  }
}
