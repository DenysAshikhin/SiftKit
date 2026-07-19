import type { SiftConfig } from '../config/types.js';
import { getActiveModelPreset } from '../config/getters.js';
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

function resolveLlamaBaseUrl(config: SiftConfig): string {
  return getActiveModelPreset(config).BaseUrl ?? 'http://127.0.0.1:8097';
}

function resolveLlamaModel(config: SiftConfig): string {
  return getActiveModelPreset(config).Model ?? 'llama';
}

export class ManagedLlamaRuntime extends ManagedInferenceRuntime {
  constructor(private readonly ctx: ServerContext, config: SiftConfig) {
    super('llama', resolveLlamaBaseUrl(config), resolveLlamaModel(config), llamaCapabilities);
  }

  async start(): Promise<void> {
    this.transitionTo('starting');
    try {
      await ensureManagedLlamaReady(this.ctx, { allowUnconfigured: true });
      if (!this.ctx.managedLlamaReady) {
        throw new Error(this.ctx.managedLlamaStartupWarning ?? 'Managed llama.cpp did not become ready.');
      }
      this.transitionTo('ready');
    } catch (error) {
      this.transitionTo('failed');
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.transitionTo('stopping');
    try {
      await shutdownManagedLlamaIfNeeded(this.ctx);
      this.transitionTo('stopped');
    } catch (error) {
      this.transitionTo('failed');
      throw error;
    }
  }

  async waitUntilReady(): Promise<void> {
    if (this.getState() !== 'ready') {
      throw new Error('Managed llama.cpp is not ready.');
    }
  }
}
