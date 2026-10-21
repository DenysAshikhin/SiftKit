import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Exl3EngineConfigSchema,
  InferenceModelStateSchema,
  InferenceRuntimeErrorPhaseSchema,
  ModelIdleActionSchema,
  ModelLifecycleActionSchema,
  ModelLifecycleRequestSchema,
  ModelLifecycleResponseSchema,
  InferenceRuntimeStatusSchema,
  ModelPresetFieldSchema,
  ModelRuntimePresetSchema,
  ReasoningEffortSchema,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  RestartBackendResponseSchema,
  ServerModelPresetsConfigSchema,
  SiftConfigSchema,
  SiftPresetCollectionSchema,
  SiftPresetSchema,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.ts';

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
    assistantMemory: false,
    autoloadFiles: [],
    repoRootRequired: false,
    maxTurns: null,
    modelPresetId: null,
  };
}

test('repo-agent turn default is shared through the contracts package', () => {
  assert.equal(REPO_AGENT_DEFAULT_MAX_TURNS, 100);
});

test('SiftConfigSchema accepts the default config (conformance)', () => {
  assert.doesNotThrow(() => SiftConfigSchema.parse(getDefaultConfigObject()));
});

test('EXL3 CPU threads accepts positive integers and automatic selection', () => {
  const engine = getDefaultConfigObject().Server.Engines.Exl3;
  for (const value of ['1', '8', '128']) {
    const parsed = Exl3EngineConfigSchema.parse({
      ...engine, Environment: { EXL3_MOE_CPU_THREADS: value, OTHER_SETTING: 'keep' },
    });
    assert.equal(parsed.Environment.EXL3_MOE_CPU_THREADS, value);
    assert.equal(parsed.Environment.OTHER_SETTING, 'keep');
  }
  assert.doesNotThrow(() => Exl3EngineConfigSchema.parse({ ...engine, Environment: {} }));
});

test('EXL3 CPU threads rejects invalid explicit counts', () => {
  const engine = getDefaultConfigObject().Server.Engines.Exl3;
  for (const value of ['', '0', '-1', '1.5', 'eight', '1e2', '9007199254740992']) {
    const result = Exl3EngineConfigSchema.safeParse({
      ...engine, Environment: { EXL3_MOE_CPU_THREADS: value },
    });
    assert.equal(result.success, false, `must reject ${JSON.stringify(value)}`);
    if (!result.success) {
      assert.deepEqual(result.error.issues[0]?.path, ['Environment', 'EXL3_MOE_CPU_THREADS']);
    }
  }
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

test('SiftConfigSchema rejects unknown fields at runtime boundaries', () => {
  const defaults = getDefaultConfigObject();
  const result = SiftConfigSchema.safeParse({
    ...defaults,
    Runtime: { ...defaults.Runtime, UnknownRuntimeField: true },
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
    Environment: { EXL3_MOE_PINNED_ARENA: '1' },
  };
  assert.doesNotThrow(() => Exl3EngineConfigSchema.parse(config));
  const { AdminApiKey: _AdminApiKey, ...withoutAdminApiKey } = config;
  assert.equal(Exl3EngineConfigSchema.safeParse(withoutAdminApiKey).success, false);
  const { Environment: _Environment, ...withoutEnvironment } = config;
  assert.equal(Exl3EngineConfigSchema.safeParse(withoutEnvironment).success, false);
  assert.equal(Exl3EngineConfigSchema.safeParse({ ...config, Environment: { EXL3_MOE_PINNED_ARENA: 1 } }).success, false);
});

test('InferenceRuntimeStatusSchema represents process and model residency independently', () => {
  assert.doesNotThrow(() => InferenceRuntimeStatusSchema.parse({
    activePresetId: 'coding',
    activePresetLabel: 'Coding',
    backend: 'exl3',
    idleAction: 'unload',
    processState: 'ready',
    modelState: 'unloaded',
    model: null,
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  }));
});

test('model lifecycle contracts accept only load/unload terminology and valid responses', () => {
  assert.deepEqual(ModelLifecycleActionSchema.options, ['load', 'unload']);
  assert.equal(ModelLifecycleActionSchema.safeParse('freeze').success, false);
  assert.equal(ModelLifecycleActionSchema.safeParse('offload').success, false);
  assert.deepEqual(ModelLifecycleRequestSchema.parse({ action: 'load' }), { action: 'load' });
  assert.deepEqual(ModelLifecycleResponseSchema.parse({ ok: true, status: 'done' }), { ok: true, status: 'done' });
  assert.equal(ModelLifecycleResponseSchema.safeParse({ ok: true, status: 'malformed' }).success, false);
  assert.deepEqual(InferenceModelStateSchema.options, ['unloaded', 'loading', 'ready', 'unloading', 'failed']);
  assert.equal(InferenceModelStateSchema.safeParse('frozen').success, false);
  assert.deepEqual(ModelIdleActionSchema.options, ['none', 'unload']);
  assert.deepEqual(InferenceRuntimeErrorPhaseSchema.options, ['process-start', 'process-stop', 'model-load', 'model-unload', 'preset-switch']);
  assert.equal(Object.hasOwn(InferenceRuntimeStatusSchema.shape, 'freezeSupported'), false);
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

test('operation model selection distinguishes current from an explicit model', () => {
  const source = completePreset();
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: null }).success, true);
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: 'coding-model' }).success, true);
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: '' }).success, false);
  const { modelPresetId, ...missing } = { ...source, modelPresetId: null };
  assert.equal(modelPresetId, null);
  assert.equal(SiftPresetSchema.safeParse(missing).success, false);
});

test('configuration rejects a dangling operation model reference', () => {
  const config = getDefaultConfigObject();
  const preset = config.Presets.find(entry => entry.id === 'repo-search');
  assert.ok(preset);
  const payload = {
    ...config,
    Presets: config.Presets.map(entry => entry.id === preset.id
      ? { ...entry, modelPresetId: 'deleted-model' } : entry),
  };
  assert.equal(SiftConfigSchema.safeParse(payload).success, false);
});

test('model preset references reject duplicate IDs and an absent active selection', () => {
  const config = getDefaultConfigObject();
  const models = config.Server.ModelPresets;
  const [first] = models.Presets;
  assert.ok(first);
  const duplicate = ServerModelPresetsConfigSchema.safeParse({
    ...models,
    Presets: [first, structuredClone(first)],
  });
  assert.equal(duplicate.success, false);
  if (!duplicate.success) {
    assert.deepEqual(duplicate.error.issues.map((issue) => issue.path), [['Presets', 1, 'id']]);
  }
  for (const activePresetId of ['', 'deleted-model']) {
    const missing = ServerModelPresetsConfigSchema.safeParse({ ...models, ActivePresetId: activePresetId });
    assert.equal(missing.success, false);
    if (!missing.success) {
      assert.deepEqual(missing.error.issues.map((issue) => issue.path), [['ActivePresetId']]);
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

test('ReasoningEffortSchema accepts the union of levels the supported templates distinguish', () => {
  assert.deepEqual(ReasoningEffortSchema.options, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(ReasoningEffortSchema.safeParse('none').success, false);
  assert.equal(ReasoningEffortSchema.safeParse('').success, false);
});

test('ModelRuntimePresetSchema requires ReasoningEffort on every preset', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const { ReasoningEffort: _ReasoningEffort, ...withoutEffort } = preset;
  assert.equal(ModelRuntimePresetSchema.safeParse(withoutEffort).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, ReasoningEffort: 'low' }).success, true);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, ReasoningEffort: 'none' }).success, false);
});

test('ModelRuntimePresetSchema requires UnlockAllSettings on every preset', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const { UnlockAllSettings: _UnlockAllSettings, ...withoutUnlock } = preset;
  assert.equal(preset.UnlockAllSettings, false);
  assert.equal(ModelRuntimePresetSchema.safeParse(withoutUnlock).success, false);
  assert.equal(ModelPresetFieldSchema.safeParse('UnlockAllSettings').success, true);
});

test('ReasoningEffort is an editable model preset field', () => {
  assert.equal(ModelPresetFieldSchema.safeParse('ReasoningEffort').success, true);
});

test('a disk-cache model preset needs an absolute path and a RAM tier', () => {
  const base = getDefaultConfigObject().Server.ModelPresets;
  const preset = base.Presets[0];
  assert.ok(preset);
  const withDisk = (changes: Partial<typeof preset>) => ServerModelPresetsConfigSchema.safeParse({
    ...base, Presets: [{ ...preset, CacheRam: 4096, DiskCacheDir: 'D:\\AI\\exl3-disk-cache', ...changes }],
  });
  assert.equal(withDisk({}).success, true);
  assert.equal(withDisk({ DiskCacheDir: null, CacheRam: 0 }).success, true, 'off needs nothing');
  assert.match(JSON.stringify(withDisk({ DiskCacheDir: 'cache' }).error?.issues), /normalized absolute path/u);
  assert.match(JSON.stringify(withDisk({ DiskCacheDir: 'D:\\AI\\x\\..\\cache' }).error?.issues), /normalized absolute path/u);
  assert.match(JSON.stringify(withDisk({ DiskCacheDir: 'D:\\AI\\.\\cache' }).error?.issues), /normalized absolute path/u);
  assert.match(JSON.stringify(withDisk({ CacheRam: 0 }).error?.issues), /CacheRam must be above 0/u);
  assert.equal(withDisk({ ExternalServerEnabled: true }).success, true, 'the runtime, not the schema, rejects an external disk preset');
});

test('model presets that share a disk-cache directory must share its size budget', () => {
  const base = getDefaultConfigObject().Server.ModelPresets;
  const preset = base.Presets[0];
  assert.ok(preset);
  const disk = { ...preset, CacheRam: 4096, DiskCacheDir: 'D:\\AI\\exl3-disk-cache', DiskCacheSizeMiB: 51200 };
  const other = { ...disk, id: 'other', DiskCacheDir: 'd:/ai/EXL3-disk-cache/' };
  assert.equal(ServerModelPresetsConfigSchema.safeParse({ ...base, Presets: [disk, other] }).success, true);
  const result = ServerModelPresetsConfigSchema.safeParse({ ...base, Presets: [disk, { ...other, DiskCacheSizeMiB: 1024 }] });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error?.issues), /share DiskCacheSizeMiB/u);
  const variant = { ...disk, id: 'variant', DiskCacheDir: 'd:/AI/exl3-disk-cache/', DiskCacheSizeMiB: 1024 };
  const variantResult = ServerModelPresetsConfigSchema.safeParse({ ...base, Presets: [disk, variant] });
  assert.equal(variantResult.success, false);
  assert.match(JSON.stringify(variantResult.error?.issues), /share DiskCacheSizeMiB/u);
});
