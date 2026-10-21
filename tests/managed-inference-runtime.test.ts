import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelRuntimePreset } from '../src/config/types.ts';
import { ManagedInferenceRuntime } from '../src/status-server/managed-inference-runtime.ts';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.ts';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.ts';
import { createPresetRoutingConfig } from './helpers/preset-routing-config.ts';
import { NEVER_LAUNCHING_ENGINE_HOST } from './helpers/in-process-tabby.ts';

class TestRuntime extends ManagedInferenceRuntime {
  constructor() {
    super('exl3');
  }

  replaceEngineConfig(): never { throw new Error('Engine replacement is not used by this fixture.'); }

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

  getPresetResidencyKey(preset: ModelRuntimePreset): string {
    return JSON.stringify({ model: preset.Model, numCtx: preset.NumCtx });
  }

}

test('managed inference runtime exposes separate process and model state', async () => {
  const runtime = new TestRuntime();

  assert.equal(runtime.id, 'exl3');
  assert.equal('getCapabilities' in runtime, false);
  assert.equal(runtime.getProcessState(), 'stopped');
  assert.equal(runtime.getModelState(), 'unloaded');

  await runtime.startProcess();
  assert.equal(runtime.getProcessState(), 'ready');
  assert.equal(runtime.getModelState(), 'unloaded');
});

test('Tabby residency identity includes load inputs and excludes request-only settings', () => {
  const config = createPresetRoutingConfig();
  const [source] = config.Server.ModelPresets.Presets;
  assert.ok(source);
  const preset = { ...source, VisionEnabled: false, VisionOffload: false, SpeculativeEnabled: false };
  const runtime = new ManagedTabbyRuntime(
    { ...config.Server.Engines.Exl3, Managed: true }, new InferenceRunFlushQueue(), NEVER_LAUNCHING_ENGINE_HOST,
  );
  const key = runtime.getPresetResidencyKey(preset);
  assert.equal(runtime.getPresetResidencyKey({
    ...preset, id: 'alias', label: 'Alias', Temperature: 0.125, SleepIdleSeconds: preset.SleepIdleSeconds + 1,
  }), key);
  for (const changed of [
    { ...preset, Model: 'different-model' },
    { ...preset, NumCtx: preset.NumCtx + 1024 },
    { ...preset, UBatchSize: preset.UBatchSize + 256 },
    { ...preset, ParallelSlots: preset.ParallelSlots + 1 },
    { ...preset, BaseUrl: 'http://127.0.0.1:19876' },
  ]) {
    assert.notEqual(runtime.getPresetResidencyKey(changed), key);
  }
});

test('Tabby residency identity ignores environment key order and external-only launch differences', () => {
  const config = createPresetRoutingConfig();
  const [source] = config.Server.ModelPresets.Presets;
  assert.ok(source);
  const preset = { ...source, VisionEnabled: false, VisionOffload: false, SpeculativeEnabled: false };
  const engine = { ...config.Server.Engines.Exl3, Managed: true, Environment: { FIRST: '1', SECOND: '2' } };
  const queue = new InferenceRunFlushQueue();
  const first = new ManagedTabbyRuntime(engine, queue, NEVER_LAUNCHING_ENGINE_HOST);
  const reordered = new ManagedTabbyRuntime(
    { ...engine, Environment: { SECOND: '2', FIRST: '1' } }, queue, NEVER_LAUNCHING_ENGINE_HOST,
  );
  const different = new ManagedTabbyRuntime(
    { ...engine, PythonPath: `${engine.PythonPath}.different` }, queue, NEVER_LAUNCHING_ENGINE_HOST,
  );
  assert.equal(first.getPresetResidencyKey(preset), reordered.getPresetResidencyKey(preset));
  const overridden = new ManagedTabbyRuntime({
    ...engine, Environment: { ...engine.Environment, TABBY_MODEL_MAX_SEQ_LEN: 'ignored' },
  }, queue, NEVER_LAUNCHING_ENGINE_HOST);
  assert.equal(first.getPresetResidencyKey(preset), overridden.getPresetResidencyKey(preset));
  assert.notEqual(first.getPresetResidencyKey(preset), different.getPresetResidencyKey(preset));
  const external = { ...preset, ExternalServerEnabled: true };
  assert.equal(first.getPresetResidencyKey(external), different.getPresetResidencyKey(external));
  assert.notEqual(first.getPresetResidencyKey(external), first.getPresetResidencyKey(preset));
});

test('Tabby residency normalizes the endpoint the HTTP client actually uses', () => {
  const config = createPresetRoutingConfig();
  const [source] = config.Server.ModelPresets.Presets;
  assert.ok(source);
  const preset = { ...source, VisionEnabled: false, VisionOffload: false, SpeculativeEnabled: false };
  const runtime = new ManagedTabbyRuntime(config.Server.Engines.Exl3, new InferenceRunFlushQueue(), NEVER_LAUNCHING_ENGINE_HOST);
  assert.equal(
    runtime.getPresetResidencyKey({ ...preset, BaseUrl: 'HTTP://EXAMPLE.invalid:80/ignored?unused=1#fragment' }),
    runtime.getPresetResidencyKey({ ...preset, BaseUrl: 'http://example.invalid' }),
  );
});

test('Tabby engine replacement updates complete launch identity without mutating configuration snapshots', () => {
  const config = createPresetRoutingConfig();
  const [source] = config.Server.ModelPresets.Presets;
  assert.ok(source);
  const preset = { ...source, ModelPath: 'Z:\\different-model-root\\model-a' };
  const initial = structuredClone(config.Server.Engines.Exl3);
  const runtime = new ManagedTabbyRuntime(initial, new InferenceRunFlushQueue(), NEVER_LAUNCHING_ENGINE_HOST);
  const next = {
    ...initial, Entrypoint: 'new-tabby.py', ModelRoot: 'Z:\\different-model-root',
    Environment: { EXL3_MOE_CPU_THREADS: '8' },
  };
  const previous = runtime.replaceEngineConfig(next);
  assert.deepEqual(previous, config.Server.Engines.Exl3);
  assert.deepEqual(initial, config.Server.Engines.Exl3);
  const expected = new ManagedTabbyRuntime(next, new InferenceRunFlushQueue(), NEVER_LAUNCHING_ENGINE_HOST);
  const key = runtime.getPresetResidencyKey(preset);
  assert.equal(key, expected.getPresetResidencyKey(preset));
  next.Environment.EXL3_MOE_CPU_THREADS = '16';
  previous.Environment.EXL3_MOE_CPU_THREADS = '32';
  assert.equal(runtime.getPresetResidencyKey(preset), key);
});
