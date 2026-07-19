import assert from 'node:assert/strict';
import test from 'node:test';

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
    super('exl3', 'http://127.0.0.1:8098', '3.6_27B', capabilities);
  }

  async start(): Promise<void> {
    this.transitionTo('starting');
    this.transitionTo('ready');
  }

  async stop(): Promise<void> {
    this.transitionTo('stopping');
    this.transitionTo('stopped');
  }

  async waitUntilReady(): Promise<void> {
    if (this.getState() !== 'ready') {
      throw new Error('Runtime is not ready.');
    }
  }
}

test('managed inference runtime exposes identity, endpoint, model, capabilities, and state', async () => {
  const runtime = new TestRuntime();

  assert.equal(runtime.id, 'exl3');
  assert.equal(runtime.getBaseUrl(), 'http://127.0.0.1:8098');
  assert.equal(runtime.getModelId(), '3.6_27B');
  assert.deepEqual(runtime.getCapabilities(), capabilities);
  assert.equal(runtime.getState(), 'stopped');

  await runtime.start();
  await runtime.waitUntilReady();
  assert.equal(runtime.getState(), 'ready');

  await runtime.stop();
  assert.equal(runtime.getState(), 'stopped');
});
