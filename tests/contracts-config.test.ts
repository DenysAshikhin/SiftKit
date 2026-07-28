import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Exl3EngineConfigSchema,
  InferenceRuntimeStatusSchema,
  ModelRuntimePresetSchema,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  RestartBackendResponseSchema,
  ServerModelPresetsConfigSchema,
  SiftConfigSchema,
  SiftPresetCollectionSchema,
  SiftPresetSchema,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';

function completePreset(options: {
  id?: string;
  presetKind?: 'summary' | 'chat' | 'plan' | 'repo-search' | 'repo-agent';
  useForSummary?: boolean;
} = {}) {
  return {
    id: options.id ?? 'summary',
    label: 'Complete preset',
    description: '',
    presetKind: options.presetKind ?? 'summary',
    operationMode: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text'],
    surfaces: ['cli'],
    useForSummary: options.useForSummary ?? true,
    builtin: options.id === undefined || options.id === 'summary',
    deletable: options.id !== undefined && options.id !== 'summary',
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: false,
    maxTurns: null,
  };
}

test('repo-agent turn default is shared through the contracts package', () => {
  assert.equal(REPO_AGENT_DEFAULT_MAX_TURNS, 100);
});

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

test('SiftPresetSchema rejects removed and unknown fields', () => {
  const valid = completePreset();
  const removedField = ['execution', 'Family'].join('');

  assert.equal(SiftPresetSchema.safeParse({ ...valid, [removedField]: 'summary' }).success, false);
  assert.equal(SiftPresetSchema.safeParse({ ...valid, unexpected: true }).success, false);
});

test('SiftPresetSchema requires every field and a normalized non-empty id', () => {
  const { operationMode: _operationMode, ...missingOperationMode } = completePreset();
  assert.equal(SiftPresetSchema.safeParse(missingOperationMode).success, false);

  for (const id of ['', ' Summary ', 'custom_preset', '-custom', 'custom-']) {
    const result = SiftPresetSchema.safeParse({ ...completePreset(), id });
    assert.equal(result.success, false, `expected id ${JSON.stringify(id)} to fail`);
    if (!result.success) {
      assert.deepEqual(result.error.issues[0]?.path, ['id']);
    }
  }
});

test('SiftPresetCollectionSchema reports duplicate ids at the duplicate record', () => {
  const result = SiftPresetCollectionSchema.safeParse([
    completePreset(),
    { ...completePreset(), useForSummary: false },
  ]);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.error.issues.find((issue) => issue.message.includes('Duplicate'))?.path, [1, 'id']);
  }
});

test('SiftPresetCollectionSchema requires exactly one summary default and names conflicts', () => {
  const none = SiftPresetCollectionSchema.safeParse([
    completePreset({ useForSummary: false }),
  ]);
  assert.equal(none.success, false);
  if (!none.success) {
    assert.match(none.error.issues[0]?.message ?? '', /found 0: <none>/u);
  }

  const multiple = SiftPresetCollectionSchema.safeParse([
    completePreset(),
    completePreset({ id: 'custom-summary', useForSummary: true }),
  ]);
  assert.equal(multiple.success, false);
  if (!multiple.success) {
    assert.match(multiple.error.issues[0]?.message ?? '', /summary, custom-summary/u);
  }
});

test('SiftPresetCollectionSchema requires the summary default to have summary kind', () => {
  const result = SiftPresetCollectionSchema.safeParse([
    completePreset({ presetKind: 'chat' }),
  ]);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.error.issues.find((issue) => issue.message.includes('summary kind'))?.path, [0, 'presetKind']);
  }
});
