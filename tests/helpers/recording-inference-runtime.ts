import type { InferenceBackendId, ModelRuntimePreset } from '../../src/config/types.ts';
import { ManagedInferenceRuntime } from '../../src/status-server/managed-inference-runtime.ts';

/**
 * Stand-in backend that records lifecycle calls instead of spawning a process, so
 * coordinator-driven tests can assert the exact stop/start/load ordering.
 */
export class RecordingInferenceRuntime extends ManagedInferenceRuntime {
  preparedPreset: ModelRuntimePreset | null = null;
  private residentResidencyKey: string | null = null;

  private readonly events: string[];
  private readonly failingPresetIds: Set<string>;

  constructor(
    id: InferenceBackendId,
    events: string[],
    failingPresetIds = new Set<string>(),
  ) {
    super(id);
    this.events = events;
    this.failingPresetIds = failingPresetIds;
  }

  async startProcess(): Promise<void> {
    this.events.push(`start:${this.id}`);
    this.transitionProcessTo('ready');
  }

  async stopProcess(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.residentResidencyKey = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    this.preparedPreset = structuredClone(preset);
    const residencyKey = this.getPresetResidencyKey(preset);
    if (this.getModelState() === 'ready' && this.residentResidencyKey === residencyKey) return;
    if (this.getProcessState() !== 'ready') await this.startProcess();
    this.events.push(`load:${preset.id}`);
    if (this.failingPresetIds.has(preset.id)) {
      this.failingPresetIds.delete(preset.id);
      this.residentResidencyKey = null;
      this.transitionModelTo('failed');
      throw new Error(`load failed: ${preset.id}`);
    }
    this.residentResidencyKey = residencyKey;
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    this.events.push(`unload:${this.id}`);
    if (this.getModelState() === 'failed') throw new Error(`nothing loaded: ${this.id}`);
    this.residentResidencyKey = null;
    this.transitionModelTo('unloaded');
  }

  /**
   * Stable over id/label and sampler/idle fields; changes when model, NumCtx,
   * UBatchSize, KvCacheQuantization, or ParallelSlots change.
   */
  getPresetResidencyKey(preset: ModelRuntimePreset): string {
    return JSON.stringify({
      model: preset.Model,
      numCtx: preset.NumCtx,
      uBatchSize: preset.UBatchSize,
      kvCacheQuantization: preset.KvCacheQuantization,
      parallelSlots: preset.ParallelSlots,
    });
  }
}
