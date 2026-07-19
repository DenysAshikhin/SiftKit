import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelRuntimePreset } from '../src/config/types.js';
import {
  ManagedInferenceRuntime,
  type BackendCapabilities,
} from '../src/status-server/managed-inference-runtime.js';

const capabilities: BackendCapabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'mtp',
  reusablePrefixCache: 'unknown',
};

class TestRuntime extends ManagedInferenceRuntime {
  constructor() {
    super('exl3', capabilities);
  }

  async startProcess(): Promise<void> {
    this.transitionProcessTo('starting');
    this.transitionProcessTo('ready');
  }

  async stopProcess(): Promise<void> {
    this.transitionProcessTo('stopping');
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  async ensurePresetReady(_preset: ModelRuntimePreset): Promise<void> {
    this.transitionModelTo('loading');
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    this.transitionModelTo('unloading');
    this.transitionModelTo('unloaded');
  }
}

test('managed inference runtime exposes separate process and model state', async () => {
  const runtime = new TestRuntime();

  assert.equal(runtime.id, 'exl3');
  assert.deepEqual(runtime.getCapabilities(), capabilities);
  assert.equal(runtime.getProcessState(), 'stopped');
  assert.equal(runtime.getModelState(), 'unloaded');

  await runtime.startProcess();
  assert.equal(runtime.getProcessState(), 'ready');
  assert.equal(runtime.getModelState(), 'unloaded');
});
