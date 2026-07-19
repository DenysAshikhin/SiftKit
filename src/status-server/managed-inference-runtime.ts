import type {
  InferenceBackendId,
  InferenceModelState,
  InferenceProcessState,
  ModelRuntimePreset,
} from '../config/types.js';

export type BackendCapabilities = {
  chatTemplateKwargs: boolean;
  reasoningContent: boolean;
  toolCalling: boolean;
  jsonSchema: boolean;
  speculativeMode: 'none' | 'mtp' | 'draft-model' | 'ngram';
  reusablePrefixCache: 'unknown' | 'none' | 'in-process-exact' | 'in-process-partial' | 'persistent';
};

export abstract class ManagedInferenceRuntime {
  private processState: InferenceProcessState = 'stopped';
  private modelState: InferenceModelState = 'unloaded';

  protected constructor(
    readonly id: InferenceBackendId,
    private readonly capabilities: BackendCapabilities,
  ) {}

  abstract startProcess(): Promise<void>;
  abstract stopProcess(): Promise<void>;
  abstract ensurePresetReady(preset: ModelRuntimePreset): Promise<void>;
  abstract unloadPreset(): Promise<void>;

  getProcessState(): InferenceProcessState {
    return this.processState;
  }

  getModelState(): InferenceModelState {
    return this.modelState;
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities;
  }

  protected transitionProcessTo(state: InferenceProcessState): void {
    this.processState = state;
  }

  protected transitionModelTo(state: InferenceModelState): void {
    this.modelState = state;
  }
}
