import assert from 'node:assert/strict';
import test from 'node:test';

import { getActiveModelPreset } from '../src/config/getters.js';
import type { ModelRuntimePreset } from '../src/config/types.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { ManagedInferenceRuntime } from '../src/status-server/managed-inference-runtime.js';
import { ManagedRuntimeImageCapabilityProvider } from '../src/status-server/runtime-image-capability.js';

/** Records lifecycle calls so a read can be proven never to start or switch a model. */
class FakeRuntime extends ManagedInferenceRuntime {
  ensureCalls = 0;

  constructor() {
    super('exl3');
  }

  async stopProcess(): Promise<void> {
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  async ensurePresetReady(): Promise<void> {
    this.ensureCalls += 1;
    this.transitionProcessTo('ready');
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    this.transitionModelTo('unloaded');
  }

  supportsFreeze(): boolean {
    return true;
  }

  async freezePreset(): Promise<void> {
    this.transitionModelTo('frozen');
  }

  async restorePreset(): Promise<void> {
    this.transitionModelTo('ready');
  }
}

class FixedRuntimeSource {
  constructor(private readonly runtime: ManagedInferenceRuntime) {}

  getActiveRuntime(): ManagedInferenceRuntime {
    return this.runtime;
  }
}

function visionPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  return {
    ...getActiveModelPreset(getDefaultConfig()),
    Backend: 'exl3',
    VisionEnabled: true,
    VisionImageRetention: 1,
    ...overrides,
  };
}

function buildProvider(preset: ModelRuntimePreset): {
  runtime: FakeRuntime;
  applied: AppliedModelPresetState;
  provider: ManagedRuntimeImageCapabilityProvider;
} {
  const runtime = new FakeRuntime();
  const applied = new AppliedModelPresetState(preset);
  return {
    runtime,
    applied,
    provider: new ManagedRuntimeImageCapabilityProvider(new FixedRuntimeSource(runtime), applied),
  };
}

test('capability requires a ready process, a ready model, and an image-capable preset', async () => {
  const { runtime, provider } = buildProvider(visionPreset());
  assert.deepEqual(provider.read(), {
    instanceId: null, visionCapable: false, healthy: false,
  });

  await runtime.ensurePresetReady();
  const capable = provider.read();
  assert.equal(capable.visionCapable, true);
  assert.equal(capable.healthy, true);
  assert.equal(typeof capable.instanceId, 'string');
});

test('every runtime state transition changes the instance id', async () => {
  const { runtime, provider } = buildProvider(visionPreset());
  await runtime.ensurePresetReady();
  const before = provider.read().instanceId;

  await runtime.unloadPreset();
  assert.deepEqual(provider.read(), {
    instanceId: null, visionCapable: false, healthy: false,
  });

  await runtime.ensurePresetReady();
  assert.notEqual(provider.read().instanceId, before);
});

test('a repeated transition to the same state does not change the instance id', async () => {
  const { runtime, provider } = buildProvider(visionPreset());
  await runtime.ensurePresetReady();
  const before = provider.read().instanceId;
  await runtime.ensurePresetReady();
  assert.equal(provider.read().instanceId, before);
});

test('a preset that cannot accept images is healthy but never vision capable', async () => {
  for (const preset of [
    visionPreset({ Backend: 'llama' }),
    visionPreset({ VisionEnabled: false }),
    visionPreset({ VisionImageRetention: 0 }),
  ]) {
    const { runtime, provider } = buildProvider(preset);
    await runtime.ensurePresetReady();
    const capability = provider.read();
    assert.equal(capability.visionCapable, false);
    assert.equal(capability.healthy, true);
  }
});

test('a capability read never starts or switches a model', () => {
  const { runtime, provider } = buildProvider(visionPreset());
  provider.read();
  provider.read();
  assert.equal(runtime.ensureCalls, 0);
});

test('applying a different preset re-decides capability without a runtime change', async () => {
  const { runtime, applied, provider } = buildProvider(visionPreset());
  await runtime.ensurePresetReady();
  assert.equal(provider.read().visionCapable, true);

  applied.applyPreset(visionPreset({ VisionEnabled: false }));
  assert.equal(provider.read().visionCapable, false);
});
