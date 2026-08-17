import type { InferenceBackendId, ModelRuntimePreset } from '../../src/config/types.js';
import { ManagedInferenceRuntime } from '../../src/status-server/managed-inference-runtime.js';

/**
 * Stand-in backend that records lifecycle calls instead of spawning a process, so
 * coordinator-driven tests can assert the exact stop/start/load ordering.
 */
export class RecordingInferenceRuntime extends ManagedInferenceRuntime {
  /** Mutable so a test can model a venv whose exllamav3 lacks the host-RAM freeze patch. */
  freezeSupported = true;

  constructor(
    id: InferenceBackendId,
    private readonly events: string[],
    private readonly failingPresetIds = new Set<string>(),
  ) {
    super(id);
  }

  async startProcess(): Promise<void> {
    this.events.push(`start:${this.id}`);
    this.transitionProcessTo('ready');
  }

  async stopProcess(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (this.getProcessState() !== 'ready') await this.startProcess();
    this.events.push(`load:${preset.id}`);
    if (this.failingPresetIds.has(preset.id)) {
      this.failingPresetIds.delete(preset.id);
      this.transitionModelTo('failed');
      throw new Error(`load failed: ${preset.id}`);
    }
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    this.events.push(`unload:${this.id}`);
    if (this.getModelState() === 'failed') throw new Error(`nothing loaded: ${this.id}`);
    this.transitionModelTo('unloaded');
  }

  supportsFreeze(): boolean {
    return this.freezeSupported;
  }

  async freezePreset(): Promise<void> {
    this.events.push(`freeze:${this.id}`);
    this.transitionModelTo('frozen');
  }

  async restorePreset(): Promise<void> {
    this.events.push(`restore:${this.id}`);
    this.transitionModelTo('ready');
  }
}
