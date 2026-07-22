import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagedLlamaSettingsSchema,
  ModelRuntimePresetSchema,
  type ModelRuntimePreset,
  type ModelPresetField,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { Exl3PresetAdapter } from '../src/inference-presets/exl3-preset-adapter.js';
import { LlamaPresetAdapter } from '../src/inference-presets/llama-preset-adapter.js';
import {
  getExl3CacheModes,
  getPresetFieldAvailability,
} from '../src/inference-presets/preset-compatibility.js';

function createModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, Backend: 'llama', ...overrides });
}

test('EXL3 adapter translates shared batching and MTP settings for managed Tabby', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    NumCtx: 30_000,
    ParallelSlots: 4,
    UBatchSize: 1_024,
    KvCacheQuantization: 'q8_0/q4_0',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
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
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
    TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8',
    EXL3_QC_ATTN: '0',
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
    SpeculativeType: 'ngram-map-k',
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
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'disabled',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
    EXL3_QC_ATTN: '0',
  });
  assert.equal('TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE' in adapter.buildLaunchEnvironment(preset), false);
});

test('EXL3 preset validation rejects MTP with a draft cache quantization Tabby cannot express', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'q5_0',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
  });
  assert.throws(() => adapter.validatePreset(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.throws(() => adapter.buildLoadRequest(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.throws(() => adapter.buildLaunchEnvironment(preset), /KvCacheQuantization=q5_0 has no EXL3 draft cache mode/u);
  assert.deepEqual(
    adapter.buildLoadRequest({ ...preset, SpeculativeEnabled: false }).cache_mode,
    '5,5',
  );
});

test('EXL3 managed launch rejects speculative modes other than MTP', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.throws(
    () => adapter.buildLaunchEnvironment(createModelPreset({
      Backend: 'exl3',
      ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
      SpeculativeEnabled: true,
      SpeculativeType: 'ngram-map-k',
    })),
    /SpeculativeType=ngram-map-k.*draft-mtp/u,
  );
});

test('EXL3 adapter rejects incompatible cache choices', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.throws(
    () => adapter.validatePreset(createModelPreset({
      Backend: 'exl3',
      ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
      KvCacheQuantization: 'bf16',
    })),
    /preset=default.*backend=exl3.*KvCacheQuantization=bf16/u,
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
    getExl3CacheModes('f32'),
    getExl3CacheModes('f16'),
    getExl3CacheModes('bf16'),
    getExl3CacheModes('q8_0'),
    getExl3CacheModes('q4_0'),
    getExl3CacheModes('q4_1'),
    getExl3CacheModes('iq4_nl'),
    getExl3CacheModes('q5_0'),
    getExl3CacheModes('q5_1'),
    getExl3CacheModes('q8_0/q4_0'),
    getExl3CacheModes('q8_0/q5_0'),
  ], [
    null,
    { cache: 'FP16', draft: 'FP16' },
    null,
    { cache: '8,8', draft: 'Q8' },
    { cache: '4,4', draft: 'Q4' },
    null,
    null,
    { cache: '5,5', draft: null },
    null,
    { cache: '8,4', draft: 'Q8' },
    { cache: '8,5', draft: 'Q8' },
  ]);
});

test('EXL3 availability disables fields without equivalents and keeps wake settings enabled', () => {
  const managedExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: false });
  const externalExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: true });
  const unsupported = [
    'ExecutablePath',
    'GpuLayers',
    'Threads',
    'NcpuMoe',
    'FlashAttention',
    'BatchSize',
    'CacheRam',
    'ReasoningBudget',
    'ReasoningBudgetMessage',
    'SpeculativeMtpEnabled',
    'SpeculativeDraftMin',
    'SpeculativeNgramSizeN',
    'SpeculativeNgramSizeM',
    'SpeculativeNgramMinHits',
    'SpeculativeNgramModNMatch',
    'SpeculativeNgramModNMin',
    'SpeculativeNgramModNMax',
    'VerboseLogging',
    'BindHost',
    'Port',
  ] satisfies ModelPresetField[];

  for (const field of unsupported) {
    assert.deepEqual(getPresetFieldAvailability(managedExl3, field), {
      enabled: false,
      reason: 'Not supported by EXL3',
    });
  }
  for (const field of [
    'ParallelSlots',
    'UBatchSize',
    'SpeculativeEnabled',
    'SpeculativeType',
    'SpeculativeDraftMax',
  ] satisfies ModelPresetField[]) {
    assert.deepEqual(getPresetFieldAvailability(managedExl3, field), { enabled: true, reason: null });
  }
  assert.deepEqual(getPresetFieldAvailability(externalExl3, 'UBatchSize'), { enabled: true, reason: null });
  for (const field of [
    'ParallelSlots',
    'SpeculativeEnabled',
    'SpeculativeType',
    'SpeculativeDraftMax',
  ] satisfies ModelPresetField[]) {
    assert.deepEqual(getPresetFieldAvailability(externalExl3, field), {
      enabled: false,
      reason: 'Requires SiftKit-managed TabbyAPI',
    });
  }
  assert.deepEqual(getPresetFieldAvailability(managedExl3, 'SleepIdleSeconds'), { enabled: true, reason: null });
  assert.deepEqual(getPresetFieldAvailability(managedExl3, 'KvCacheQuantization'), {
    enabled: true,
    reason: 'Only EXL3-compatible cache modes are available',
  });
  const supported = [
    'Model',
    'ExternalServerEnabled',
    'BaseUrl',
    'ModelPath',
    'NumCtx',
    'MaxTokens',
    'Temperature',
    'TopP',
    'TopK',
    'MinP',
    'PresencePenalty',
    'RepetitionPenalty',
    'Reasoning',
    'ReasoningContent',
    'PreserveThinking',
    'MaintainPerStepThinking',
    'StartupTimeoutMs',
    'HealthcheckTimeoutMs',
    'HealthcheckIntervalMs',
    'SleepIdleSeconds',
  ] satisfies ModelPresetField[];
  for (const field of supported) {
    assert.deepEqual(getPresetFieldAvailability(managedExl3, field), { enabled: true, reason: null });
  }
  assert.deepEqual(getPresetFieldAvailability(createModelPreset(), 'GpuLayers'), { enabled: true, reason: null });
});

test('EXL3 adapter returns common request defaults', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    Reasoning: 'on',
    MaxTokens: 73,
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');

  assert.deepEqual(adapter.buildRequestDefaults(preset), {
    maxTokens: 73,
    temperature: preset.Temperature,
    topP: preset.TopP,
    topK: preset.TopK,
    minP: preset.MinP,
    presencePenalty: preset.PresencePenalty,
    repetitionPenalty: preset.RepetitionPenalty,
    reasoning: 'on',
    reasoningContent: preset.ReasoningContent,
    preserveThinking: preset.PreserveThinking,
    maintainPerStepThinking: preset.MaintainPerStepThinking,
  });
});

test('llama adapter preserves launch settings and common request defaults', () => {
  const preset = createModelPreset({
    Backend: 'llama',
    MaxTokens: 42,
    Temperature: 0.25,
    TopP: 0.9,
    TopK: 17,
    MinP: 0.05,
    PresencePenalty: 0.2,
    RepetitionPenalty: 1.1,
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
    MaintainPerStepThinking: true,
  });
  const adapter = new LlamaPresetAdapter();

  assert.deepEqual(adapter.buildLaunchSettings(preset), ManagedLlamaSettingsSchema.parse(preset));
  assert.deepEqual(adapter.buildRequestDefaults(preset), {
    maxTokens: 42,
    temperature: 0.25,
    topP: 0.9,
    topK: 17,
    minP: 0.05,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    reasoning: 'on',
    reasoningContent: true,
    preserveThinking: true,
    maintainPerStepThinking: true,
  });
});

test('adapters reject presets assigned to the other backend', () => {
  assert.throws(
    () => new LlamaPresetAdapter().validatePreset(createModelPreset({ Backend: 'exl3' })),
    /backend=exl3/u,
  );
  assert.throws(
    () => new Exl3PresetAdapter('D:\\personal\\models\\exl3').validatePreset(createModelPreset({ Backend: 'llama' })),
    /backend=llama/u,
  );
});
