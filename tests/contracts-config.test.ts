import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Exl3EngineConfigSchema,
  InferenceRuntimeStatusSchema,
  ModelRuntimePresetSchema,
  RestartBackendResponseSchema,
  ServerModelPresetsConfigSchema,
  SiftConfigSchema,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';

test('SiftConfigSchema accepts the default config (conformance)', () => {
  assert.doesNotThrow(() => SiftConfigSchema.parse(getDefaultConfigObject()));
});

test('RestartBackendResponseSchema accepts ok with no config', () => {
  assert.doesNotThrow(() => RestartBackendResponseSchema.parse({ ok: true, restarted: false }));
});

test('SiftConfigSchema preserves per-preset backend and EXL3 engine configuration', () => {
  const defaults = getDefaultConfigObject();
  const preset = defaults.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const parsed = SiftConfigSchema.parse({
    ...defaults,
    Inference: {
      Thinking: { Enabled: true, Preserve: true },
    },
    Server: {
      ...defaults.Server,
      ModelPresets: {
        ActivePresetId: preset.id,
        Presets: [{ ...preset, Backend: 'exl3', BaseUrl: 'http://127.0.0.1:8098', Model: '3.6_27B' }],
      },
    },
  });

  assert.equal(parsed.Server.ModelPresets.Presets[0]?.Backend, 'exl3');
  assert.equal(parsed.Server.ModelPresets.Presets[0]?.Model, '3.6_27B');
});

test('SiftConfigSchema rejects an invalid preset backend', () => {
  const defaults = getDefaultConfigObject();
  const preset = defaults.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const result = SiftConfigSchema.safeParse({
    ...defaults,
    Server: {
      ...defaults.Server,
      ModelPresets: { ActivePresetId: preset.id, Presets: [{ ...preset, Backend: 'unknown-backend' }] },
    },
  });

  assert.equal(result.success, false);
});

test('ModelRuntimePresetSchema requires a backend on every preset', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const { Backend: _Backend, ...withoutBackend } = preset;
  assert.equal(ModelRuntimePresetSchema.safeParse(withoutBackend).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, Backend: 'exl3' }).success, true);
});

test('ServerModelPresetsConfigSchema requires at least one preset', () => {
  assert.equal(ServerModelPresetsConfigSchema.safeParse({ Presets: [], ActivePresetId: 'default' }).success, false);
});

test('Exl3EngineConfigSchema accepts process-level configuration', () => {
  const config = {
    Managed: true,
    WorkingDirectory: 'C:\\TabbyAPI',
    PythonPath: 'C:\\envs\\tabby\\python.exe',
    Entrypoint: 'main.py',
    ModelRoot: 'D:\\models\\exl3',
    AdminApiKey: 'secret',
    ShutdownTimeoutMs: 30_000,
  };
  assert.doesNotThrow(() => Exl3EngineConfigSchema.parse(config));
  const { AdminApiKey: _AdminApiKey, ...withoutAdminApiKey } = config;
  assert.equal(Exl3EngineConfigSchema.safeParse(withoutAdminApiKey).success, false);
});

test('InferenceRuntimeStatusSchema represents process and model residency independently', () => {
  assert.doesNotThrow(() => InferenceRuntimeStatusSchema.parse({
    activePresetId: 'coding',
    activePresetLabel: 'Coding',
    backend: 'exl3',
    processState: 'ready',
    modelState: 'unloaded',
    model: null,
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  }));
});
