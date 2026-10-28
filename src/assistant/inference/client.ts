import { randomUUID } from 'node:crypto';
import type { ImageDataUrl } from '@siftkit/contracts';

import {
  getConfiguredContextTokens, getConfiguredModel,
  type ModelRuntimePreset, type SiftConfig,
} from '../../config/index.ts';
import { buildUserContent } from '../../llm-protocol/image-attachments.ts';
import { InferenceClient, type InferenceChatOptions } from '../../llm-protocol/inference-client.ts';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.ts';
import type {
  InferenceChatMessage, InferenceToolDefinition, NormalizedInferenceChatResponse,
} from '../../llm-protocol/types.ts';

/** One note-writer agent turn: the whole history, the offered tools, and the source's images. */
export interface AssistantAgentTurnRequest {
  readonly messages: readonly InferenceChatMessage[];
  /** Attached to the first user message; empty for text-only sources. */
  readonly images: readonly ImageDataUrl[];
  readonly tools: readonly InferenceToolDefinition[];
  readonly abortSignal: AbortSignal;
}

/** The note-writer agent's path to the model: tool-calling turns on the running preset. */
export interface AssistantInferenceClient {
  chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse>;
  /** The running preset's context window, which the agent forces its final turn against. */
  contextTokens(): number;
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

const ASSISTANT_IDLE_TIMEOUT_SECONDS = 120;

/** One agent turn may submit up to 30 operations. */
const AGENT_MAX_OUTPUT_TOKENS = 4_096;

/**
 * The assistant's only path to a model, on SiftKit's GPU-locked runtime. Images pass through the
 * same admission the chat surface uses; nothing here re-implements those limits.
 */
export class DefaultAssistantInferenceClient implements AssistantInferenceClient {
  private readonly config: SiftConfig;
  private readonly presets: ActiveModelPresetSource;
  private readonly backend: AssistantChatBackend;

  constructor(
    config: SiftConfig,
    presets: ActiveModelPresetSource,
    backend: AssistantChatBackend = new InferenceClient(),
  ) {
    this.config = config;
    this.presets = presets;
    this.backend = backend;
  }

  async chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse> {
    if (request.abortSignal.aborted) throw new Error('Assistant inference aborted before the request was issued.');
    const messages = this.withImages(request.messages, request.images);
    const operationId = randomUUID();
    const model = getConfiguredModel(this.config);
    return this.backend.chat({
      config: this.config,
      model,
      messages,
      tools: [...request.tools],
      allowedToolNames: request.tools.map((tool) => tool.function.name),
      maxTokens: AGENT_MAX_OUTPUT_TOKENS,
      idleTimeoutSeconds: ASSISTANT_IDLE_TIMEOUT_SECONDS,
      reasoningOverride: 'off',
      throughputAudit: {
        operationType: 'assistant', operationId, requestId: operationId, stage: 'agent_vault_writer', model, presetId: this.presets.getPreset().id,
      },
      abortSignal: request.abortSignal,
    });
  }

  contextTokens(): number {
    return getConfiguredContextTokens(this.config).totalContextTokens;
  }

  /** Images go through the same preset admission as chat, onto the first user message. */
  private withImages(messages: readonly InferenceChatMessage[], images: readonly ImageDataUrl[]): InferenceChatMessage[] {
    if (images.length === 0) return [...messages];
    const admitted = admitImagesForPreset(this.presets.getPreset(), images).map((image) => image.dataUrl);
    const first = messages.findIndex((message) => message.role === 'user');
    return messages.map((message, index) => (index === first && typeof message.content === 'string'
      ? { ...message, content: buildUserContent(message.content, admitted) } : message));
  }
}
