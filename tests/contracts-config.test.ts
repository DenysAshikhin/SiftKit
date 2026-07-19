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

test('SiftConfigSchema preserves typed inference and EXL3 configuration', () => {
  const defaults = getDefaultConfigObject();
  const parsed = SiftConfigSchema.parse({
    ...defaults,
    Inference: {
      SelectedBackend: 'exl3',
      Thinking: { Enabled: true, Preserve: true },
    },
    Server: {
      ...defaults.Server,
      Exl3: {
        Managed: true,
        BaseUrl: 'http://127.0.0.1:8098',
        WorkingDirectory: 'C:\\Users\\denys\\Documents\\GitHub\\TabbyAPI',
        PythonPath: 'C:\\envs\\rl310\\Scripts\\python.exe',
        Entrypoint: 'main.py',
        ConfigPath: 'config.yml',
        ModelId: '3.6_27B',
        StartupTimeoutMs: 600_000,
        HealthcheckTimeoutMs: 2_000,
        HealthcheckIntervalMs: 1_000,
        ShutdownTimeoutMs: 30_000,
      },
    },
  });

  assert.match(JSON.stringify(parsed), /"SelectedBackend":"exl3"/u);
  assert.match(JSON.stringify(parsed), /"ModelId":"3\.6_27B"/u);
});

test('SiftConfigSchema rejects an invalid selected inference backend', () => {
  const defaults = getDefaultConfigObject();
  const result = SiftConfigSchema.safeParse({
    ...defaults,
    Inference: {
      SelectedBackend: 'unknown-backend',
      Thinking: { Enabled: true, Preserve: true },
    },
  });

  assert.equal(result.success, false);
});

test('ModelRuntimePresetSchema requires a backend on every preset', () => {
  const preset = getDefaultConfigObject().Server.LlamaCpp.Presets[0];
  assert.equal(ModelRuntimePresetSchema.safeParse(preset).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, Backend: 'exl3' }).success, true);
});

test('ServerModelPresetsConfigSchema requires at least one preset', () => {
  assert.equal(ServerModelPresetsConfigSchema.safeParse({ Presets: [], ActivePresetId: 'default' }).success, false);
});

test('Exl3EngineConfigSchema accepts process-level configuration', () => {
  assert.doesNotThrow(() => Exl3EngineConfigSchema.parse({
    Managed: true,
    WorkingDirectory: 'C:\\TabbyAPI',
    PythonPath: 'C:\\envs\\tabby\\python.exe',
    Entrypoint: 'main.py',
    ConfigPath: 'config.yml',
    ModelRoot: 'D:\\models\\exl3',
    ShutdownTimeoutMs: 30_000,
  }));
});

test('InferenceRuntimeStatusSchema represents process and model residency independently', () => {
  assert.doesNotThrow(() => InferenceRuntimeStatusSchema.parse({
    activePresetId: 'coding',
    activePresetLabel: 'Coding',
    backend: 'exl3',
    processState: 'ready',
    modelState: 'unloaded',
    modelId: null,
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  }));
});
