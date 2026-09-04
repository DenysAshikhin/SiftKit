import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ModelPresetSettingsSchema,
  ModelPresetFieldSchema,
  ModelRuntimePresetSchema,
  type ModelRuntimePreset,
  type ModelPresetField,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { Exl3PresetAdapter } from '../src/inference-presets/exl3-preset-adapter.js';
import {
  buildPresetRequestDefaults,
  getExl3CacheModes,
  getPresetFieldAvailability,
  type PresetFieldAvailability,
} from '../src/inference-presets/preset-compatibility.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function createModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, Backend: 'exl3', ...overrides });
}

test('model preset contracts reject the removed MaxTokens field', () => {
  const defaultPreset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  assert.ok(defaultPreset);
  assert.equal(Object.hasOwn(defaultPreset, 'MaxTokens'), false);
  assert.equal(ModelPresetFieldSchema.safeParse('MaxTokens').success, false);
  const { id: _id, label: _label, Backend: _backend, Model: _model, ...settings } = defaultPreset;
  assert.equal(ModelPresetSettingsSchema.safeParse(settings).success, true);
  assert.equal(
    ModelPresetSettingsSchema.safeParse({ ...settings, MaxTokens: 512 })
      .success,
    false,
  );
});

test('EXL3 adapter translates shared batching and MTP settings for managed Tabby', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    NumCtx: 30_000,
    ParallelSlots: 4,
    UBatchSize: 1_024,
    KvCacheQuantization: 'q8_0/q4_0',
    SpeculativeEnabled: true,
    SpeculativeDraftMax: 5,
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');

  const translated = adapter.buildLoadRequest(preset);

  assert.deepEqual(translated, {
    model_name: '3.6_27B',
    max_seq_len: 30_000,
    cache_size: 30_208,
    cache_mode: '8,4',
    chunk_size: 1_024,
  });
  assert.deepEqual(adapter.buildLaunchEnvironment(preset), {
    TABBY_MODEL_MODEL_DIR: 'D:\\personal\\models\\exl3',
    TABBY_MODEL_MODEL_NAME: '3.6_27B',
    TABBY_MODEL_MAX_SEQ_LEN: '30000',
    TABBY_MODEL_CACHE_SIZE: '30208',
    TABBY_MODEL_CACHE_MODE: '8,4',
    TABBY_MODEL_MAX_BATCH_SIZE: '4',
    TABBY_MODEL_CHUNK_SIZE: '1024',
    TABBY_MEMORY_SYSMEM_KV_CACHE: String(preset.CacheRam),
    TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(preset.CacheRecurrentRam),
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
    TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8',
    TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: 'true',
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
  });
  assert.equal('gpu_layers' in translated, false);
  assert.equal('batch_size' in translated, false);
});

test('EXL3 adapter emits disabled speculative decoding without a token count', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'f16',
    SpeculativeEnabled: false,
  });

  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.deepEqual(adapter.buildLoadRequest(preset), {
    model_name: '3.6_27B',
    max_seq_len: preset.NumCtx,
    cache_size: preset.NumCtx,
    cache_mode: 'FP16',
    chunk_size: preset.UBatchSize,
  });
  assert.deepEqual(adapter.buildLaunchEnvironment(preset), {
    TABBY_MODEL_MODEL_DIR: 'D:\\personal\\models\\exl3',
    TABBY_MODEL_MODEL_NAME: '3.6_27B',
    TABBY_MODEL_MAX_SEQ_LEN: String(preset.NumCtx),
    TABBY_MODEL_CACHE_SIZE: String(preset.NumCtx),
    TABBY_MODEL_CACHE_MODE: 'FP16',
    TABBY_MODEL_MAX_BATCH_SIZE: String(preset.ParallelSlots),
    TABBY_MODEL_CHUNK_SIZE: String(preset.UBatchSize),
    TABBY_MEMORY_SYSMEM_KV_CACHE: String(preset.CacheRam),
    TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(preset.CacheRecurrentRam),
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'disabled',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
    TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: 'false',
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
  });
  assert.equal('TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE' in adapter.buildLaunchEnvironment(preset), false);
});

test('EXL3 adapter disables dynamic drafting when the preset opts out', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'f16',
    SpeculativeEnabled: true,
    SpeculativeDynamic: false,
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.equal(adapter.buildLaunchEnvironment(preset).TABBY_DRAFT_MODEL_DYNAMIC_DRAFT, 'false');
});

test('EXL3 adapter emits TABBY_MODEL_VISION true when vision is enabled', () => {
  const baseDir = createManagedTempDir('exl3-vision-');
  try {
    const modelDir = join(baseDir, '3.6_27B');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), JSON.stringify({ vision_config: {} }), { encoding: 'utf8' });
    const preset = createModelPreset({
      Backend: 'exl3',
      ModelPath: modelDir,
      KvCacheQuantization: 'q8_0/q4_0',
      VisionEnabled: true,
    });
    const adapter = new Exl3PresetAdapter(baseDir);

    const env = adapter.buildLaunchEnvironment(preset);
    assert.equal(env.TABBY_MODEL_VISION, 'true');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('EXL3 adapter emits TABBY_MODEL_VISION_OFFLOAD true when the preset offloads the vision tower', () => {
  const baseDir = createManagedTempDir('exl3-vision-offload-');
  try {
    const modelDir = join(baseDir, '3.6_27B');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), JSON.stringify({ vision_config: {} }), { encoding: 'utf8' });
    const preset = createModelPreset({
      Backend: 'exl3',
      ModelPath: modelDir,
      KvCacheQuantization: 'q8_0/q4_0',
      VisionEnabled: true,
      VisionOffload: true,
    });
    const adapter = new Exl3PresetAdapter(baseDir);

    const env = adapter.buildLaunchEnvironment(preset);
    assert.equal(env.TABBY_MODEL_VISION, 'true');
    assert.equal(env.TABBY_MODEL_VISION_OFFLOAD, 'true');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('EXL3 adapter rejects vision offload when vision is disabled', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    VisionEnabled: false,
    VisionOffload: true,
  });

  assert.throws(
    () => adapter.validatePreset(preset),
    /VisionOffload=true requires VisionEnabled=true/u,
  );
});

test('EXL3 adapter maps NcpuMoe onto TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    NcpuMoe: 12,
  });

  assert.equal(adapter.buildLaunchEnvironment(preset).TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS, '12');
});

test('EXL3 preset validation rejects a negative NcpuMoe', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
  });
  preset.NcpuMoe = -1;

  assert.throws(
    () => adapter.validatePreset(preset),
    /NcpuMoe=-1 must not be negative/u,
  );
});

test('EXL3 preset validation rejects MTP with a draft cache quantization Tabby cannot express', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'q5_0',
    SpeculativeEnabled: true,
  });
  assert.throws(() => adapter.validatePreset(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.throws(() => adapter.buildLoadRequest(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.throws(() => adapter.buildLaunchEnvironment(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.deepEqual(
    adapter.buildLoadRequest({ ...preset, SpeculativeEnabled: false }).cache_mode,
    '5,5',
  );
});

test('EXL3 adapter rejects a missing model path and paths outside the model root', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.throws(
    () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', ModelPath: null })),
    /ModelPath is required/u,
  );
  assert.throws(
    () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', ModelPath: 'D:\\personal\\models\\other\\model' })),
    /must be inside ModelRoot/u,
  );
  assert.throws(
    () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', ModelPath: '   ' })),
    /ModelPath is required/u,
  );
  for (const modelPath of [
    'D:\\personal\\models\\exl3',
    'D:\\personal\\models',
    'E:\\models\\3.6_27B',
  ]) {
    assert.throws(
      () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', ModelPath: modelPath })),
      /must be inside ModelRoot/u,
    );
  }
});

test('EXL3 cache compatibility resolves model and draft modes together', () => {
  assert.deepEqual([
    getExl3CacheModes('f16'),
    getExl3CacheModes('q8_0'),
    getExl3CacheModes('q4_0'),
    getExl3CacheModes('q5_0'),
    getExl3CacheModes('q8_0/q4_0'),
    getExl3CacheModes('q8_0/q5_0'),
  ], [
    { cache: 'FP16', draft: 'FP16' },
    { cache: '8,8', draft: 'Q8' },
    { cache: '4,4', draft: 'Q4' },
    { cache: '5,5', draft: null },
    { cache: '8,4', draft: 'Q8' },
    { cache: '8,5', draft: 'Q8' },
  ]);
});

/**
 * One expectation per preset field per engine state, so adding a field forces a deliberate
 * availability decision here before `getPresetFieldAvailability` can compile against it.
 */
interface PresetFieldExpectation {
  managed: PresetFieldAvailability;
  external: PresetFieldAvailability;
}

const AVAILABLE = { visible: true, enabled: true, reason: null } as const;
const NEEDS_MANAGED_TABBY = {
  visible: true,
  enabled: false,
  reason: 'Requires SiftKit-managed TabbyAPI',
} as const;

/** Any TabbyAPI endpoint accepts it. */
const ALWAYS = { managed: AVAILABLE, external: AVAILABLE } as const;
/** A launch setting; only an engine SiftKit launches can apply it. */
const MANAGED_ONLY = { managed: AVAILABLE, external: NEEDS_MANAGED_TABBY } as const;

const PRESET_FIELD_EXPECTATIONS = {
  Model: ALWAYS,
  ExternalServerEnabled: ALWAYS,
  BaseUrl: ALWAYS,
  ModelPath: ALWAYS,
  NumCtx: ALWAYS,
  NcpuMoe: MANAGED_ONLY,
  ParallelSlots: MANAGED_ONLY,
  UBatchSize: ALWAYS,
  CacheRam: MANAGED_ONLY,
  CacheRecurrentRam: MANAGED_ONLY,
  KvCacheQuantization: ALWAYS,

  Temperature: ALWAYS,
  TopP: ALWAYS,
  TopK: ALWAYS,
  MinP: ALWAYS,
  PresencePenalty: ALWAYS,
  RepetitionPenalty: ALWAYS,
  Reasoning: ALWAYS,
  ReasoningEffort: ALWAYS,
  ReasoningContent: ALWAYS,
  PreserveThinking: ALWAYS,
  MaintainPerStepThinking: ALWAYS,
  SpeculativeEnabled: MANAGED_ONLY,
  SpeculativeDraftMax: MANAGED_ONLY,
  SpeculativeDynamic: MANAGED_ONLY,
  ReasoningBudget: ALWAYS,
  ReasoningBudgetMessage: ALWAYS,
  StartupTimeoutMs: ALWAYS,
  HealthcheckTimeoutMs: ALWAYS,
  HealthcheckIntervalMs: ALWAYS,
  SleepIdleSeconds: ALWAYS,
  IdleAction: ALWAYS,
  VisionEnabled: MANAGED_ONLY,
  VisionOffload: MANAGED_ONLY,
  VisionImageRetention: MANAGED_ONLY,
  VisionMaxImagePixels: MANAGED_ONLY,
} satisfies Record<ModelPresetField, PresetFieldExpectation>;

test('every preset field states its availability for managed and external engines', () => {
  const managed = createModelPreset({ ExternalServerEnabled: false });
  const external = createModelPreset({ ExternalServerEnabled: true });

  for (const field of ModelPresetFieldSchema.options) {
    const expected = PRESET_FIELD_EXPECTATIONS[field];
    assert.deepEqual(getPresetFieldAvailability(managed, field), expected.managed, `managed/${field}`);
    assert.deepEqual(getPresetFieldAvailability(external, field), expected.external, `external/${field}`);
  }
});

test('EXL3 adapter returns common request defaults', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    Reasoning: 'on',
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');

  assert.deepEqual(adapter.buildRequestDefaults(preset), {
    temperature: preset.Temperature,
    topP: preset.TopP,
    topK: preset.TopK,
    minP: preset.MinP,
    presencePenalty: preset.PresencePenalty,
    repetitionPenalty: preset.RepetitionPenalty,
    reasoning: 'on',
    reasoningEffort: preset.ReasoningEffort,
    reasoningContent: preset.ReasoningContent,
    preserveThinking: preset.PreserveThinking,
    maintainPerStepThinking: preset.MaintainPerStepThinking,
  });
});

test('exl3 buildLoadRequest rounds a 140k context up to the next 256-token cache page', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    NumCtx: 140_000,
    KvCacheQuantization: 'q8_0/q4_0',
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const request = adapter.buildLoadRequest(preset);
  assert.equal(request.max_seq_len, 140_000);
  assert.equal(request.cache_size, 140_032);
});

test('buildPresetRequestDefaults carries the preset reasoning effort', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');

  assert.equal(buildPresetRequestDefaults(preset).reasoningEffort, 'xhigh');
  assert.equal(buildPresetRequestDefaults({ ...preset, ReasoningEffort: 'low' }).reasoningEffort, 'low');
});
