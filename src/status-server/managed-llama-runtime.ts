import type { ModelRuntimePreset } from '../config/types.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import {
  ensureManagedLlamaPresetReady,
  shutdownManagedLlamaPresetIfNeeded,
} from './managed-llama.js';
import type { ServerContext } from './server-types.js';

export class ManagedLlamaRuntime extends ManagedInferenceRuntime {
  private residentPresetId: string | null = null;
  private currentPreset: ModelRuntimePreset | null = null;
  private readinessPromise: Promise<void> | null = null;

  constructor(private readonly ctx: ServerContext) {
    super('llama');
  }

  private async startProcess(preset: ModelRuntimePreset): Promise<void> {
    if (this.getProcessState() === 'ready') return;
    this.transitionProcessTo('starting');
    try {
      await ensureManagedLlamaPresetReady(this.ctx, preset, { allowUnconfigured: true });
      if (!this.ctx.managedLlama.ready) {
        throw new Error(this.ctx.managedLlama.startupWarning ?? 'Managed llama.cpp did not become ready.');
      }
      this.transitionProcessTo('ready');
    } catch (error) {
      this.transitionProcessTo('failed');
      throw error;
    }
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (preset.Backend !== 'llama') {
      throw new Error(`Preset '${preset.id}' cannot be loaded by the llama.cpp runtime.`);
    }
    if (this.readinessPromise) {
      await this.readinessPromise;
      if (this.residentPresetId === preset.id) return;
    }
    const readinessPromise = this.ensurePresetReadyOnce(preset);
    this.readinessPromise = readinessPromise;
    try {
      await readinessPromise;
    } finally {
      if (this.readinessPromise === readinessPromise) this.readinessPromise = null;
    }
  }

  private async ensurePresetReadyOnce(preset: ModelRuntimePreset): Promise<void> {
    if (this.residentPresetId !== null && this.residentPresetId !== preset.id) {
      await this.stopProcess();
    }
    this.currentPreset = preset;
    if (this.getProcessState() !== 'ready') await this.startProcess(preset);
    this.residentPresetId = preset.id;
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    if (this.currentPreset?.ExternalServerEnabled) {
      throw new Error(
        `Cannot unload llama.cpp preset '${this.currentPreset.id}' because it uses an external server owned outside SiftKit.`,
      );
    }
    await this.stopProcess();
  }

  supportsFreeze(): boolean {
    return false;
  }

  async freezePreset(): Promise<void> {
    throw new Error('llama.cpp cannot freeze model weights; use a full unload instead.');
  }

  async restorePreset(): Promise<void> {
    throw new Error('llama.cpp cannot restore a frozen model; use a full load instead.');
  }

  async stopProcess(): Promise<void> {
    const preset = this.currentPreset;
    if (!preset && this.getProcessState() === 'stopped') return;
    if (!preset) throw new Error('Cannot stop llama.cpp without its current preset.');
    this.transitionProcessTo('stopping');
    try {
      await shutdownManagedLlamaPresetIfNeeded(this.ctx, preset);
      this.residentPresetId = null;
      this.currentPreset = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('stopped');
    } catch (error) {
      this.transitionProcessTo('failed');
      throw error;
    }
  }
}
