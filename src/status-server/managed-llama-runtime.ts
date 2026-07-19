import type { ModelRuntimePreset, SiftConfig } from '../config/types.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import {
  ensureManagedLlamaReady,
  shutdownManagedLlamaIfNeeded,
} from './managed-llama.js';
import type { ServerContext } from './server-types.js';

const llamaCapabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'ngram',
  reusablePrefixCache: 'in-process-partial',
} as const;

export class ManagedLlamaRuntime extends ManagedInferenceRuntime {
  private residentPresetId: string | null = null;

  constructor(private readonly ctx: ServerContext, _config: SiftConfig) {
    super('llama', llamaCapabilities);
  }

  async startProcess(): Promise<void> {
    if (this.getProcessState() === 'ready') return;
    this.transitionProcessTo('starting');
    try {
      await ensureManagedLlamaReady(this.ctx, { allowUnconfigured: true });
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
    if (this.getProcessState() !== 'ready') await this.startProcess();
    this.residentPresetId = preset.id;
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    // llama.cpp owns sleep-idle residency and transparently reloads its configured model.
  }

  async stopProcess(): Promise<void> {
    this.transitionProcessTo('stopping');
    try {
      await shutdownManagedLlamaIfNeeded(this.ctx);
      this.residentPresetId = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('stopped');
    } catch (error) {
      this.transitionProcessTo('failed');
      throw error;
    }
  }
}
