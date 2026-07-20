import type {
  InferenceBackendId,
  InferenceModelState,
  InferenceProcessState,
  ModelRuntimePreset,
} from '../config/types.js';

export abstract class ManagedInferenceRuntime {
  private processState: InferenceProcessState = 'stopped';
  private modelState: InferenceModelState = 'unloaded';

  protected constructor(readonly id: InferenceBackendId) {}

  abstract stopProcess(): Promise<void>;
  abstract ensurePresetReady(preset: ModelRuntimePreset): Promise<void>;
  abstract unloadPreset(): Promise<void>;

  getProcessState(): InferenceProcessState {
    return this.processState;
  }

  getModelState(): InferenceModelState {
    return this.modelState;
  }

  protected transitionProcessTo(state: InferenceProcessState): void {
    this.processState = state;
  }

  protected transitionModelTo(state: InferenceModelState): void {
    this.modelState = state;
  }
}
