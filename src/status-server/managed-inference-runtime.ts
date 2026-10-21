import type {
  InferenceBackendId,
  InferenceModelState,
  InferenceProcessState,
  Exl3EngineConfig,
  ModelRuntimePreset,
} from '../config/types.ts';

export abstract class ManagedInferenceRuntime {
  private processState: InferenceProcessState = 'stopped';
  private modelState: InferenceModelState = 'unloaded';
  private generation = 0;

  readonly id: InferenceBackendId;

  protected constructor(id: InferenceBackendId) {
    this.id = id;
  }

  abstract stopProcess(): Promise<void>;
  abstract replaceEngineConfig(engine: Exl3EngineConfig): Exl3EngineConfig;
  abstract ensurePresetReady(preset: ModelRuntimePreset): Promise<void>;
  abstract unloadPreset(): Promise<void>;

  // Loading identity excludes profile metadata, sampler settings, and idle timers.
  abstract getPresetResidencyKey(preset: ModelRuntimePreset): string;

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
