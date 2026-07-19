import type { InferenceBackendId, InferenceRuntimeState } from '../config/types.js';

export type BackendCapabilities = {
  chatTemplateKwargs: boolean;
  reasoningContent: boolean;
  toolCalling: boolean;
  jsonSchema: boolean;
  speculativeMode: 'none' | 'mtp' | 'draft-model' | 'ngram';
  reusablePrefixCache: 'unknown' | 'none' | 'in-process-exact' | 'in-process-partial' | 'persistent';
};

export abstract class ManagedInferenceRuntime {
  private state: InferenceRuntimeState = 'stopped';

  protected constructor(
    readonly id: InferenceBackendId,
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly capabilities: BackendCapabilities,
  ) {}

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract waitUntilReady(): Promise<void>;

  getState(): InferenceRuntimeState {
    return this.state;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getModelId(): string {
    return this.modelId;
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities;
  }

  protected transitionTo(state: InferenceRuntimeState): void {
    this.state = state;
  }
}
