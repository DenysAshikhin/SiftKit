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

  constructor(private readonly ctx: ServerContext) {
    super('llama');
  }

  private async startProcess(preset: ModelRuntimePreset): Promise<void> {
    if (this.getProcessState() === 'ready') return;
    this.transitionProcessTo('starting');
    try {
      await ensureManagedLlamaPresetReady(this.ctx, preset, { allowUnconfigured: true });
      if (!this.ctx.managedLlamaReady) {
        throw new Error(this.ctx.managedLlamaStartupWarning ?? 'Managed llama.cpp did not become ready.');
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
    if (this.residentPresetId !== null && this.residentPresetId !== preset.id) {
      await this.stopProcess();
    }
    this.currentPreset = preset;
    if (this.getProcessState() !== 'ready') await this.startProcess(preset);
    this.residentPresetId = preset.id;
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    // llama.cpp owns sleep-idle residency and transparently reloads its configured model.
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
