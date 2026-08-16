import type {
  InferenceBackendId,
  InferenceModelState,
  InferenceProcessState,
  ModelRuntimePreset,
} from '../config/types.js';

export abstract class ManagedInferenceRuntime {
  private processState: InferenceProcessState = 'stopped';
  private modelState: InferenceModelState = 'unloaded';
  private generation = 0;

  protected constructor(readonly id: InferenceBackendId) {}

  abstract stopProcess(): Promise<void>;
  abstract ensurePresetReady(preset: ModelRuntimePreset): Promise<void>;
  abstract unloadPreset(): Promise<void>;
  abstract freezePreset(): Promise<void>;
  abstract restorePreset(): Promise<void>;

  getProcessState(): InferenceProcessState {
    return this.processState;
  }

  getModelState(): InferenceModelState {
    return this.modelState;
  }

  /**
   * Counts real state changes. A caller that admitted work against one loaded model can compare
   * this before dispatching and know whether it is still talking to the same one.
   */
  getGeneration(): number {
    return this.generation;
  }

  protected transitionProcessTo(state: InferenceProcessState): void {
    if (this.processState === state) return;
    this.processState = state;
    this.generation += 1;
  }

  protected transitionModelTo(state: InferenceModelState): void {
    if (this.modelState === state) return;
    this.modelState = state;
    this.generation += 1;
  }
}
