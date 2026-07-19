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
  getExl3CacheMode,
  getPresetFieldAvailability,
} from '../src/inference-presets/preset-compatibility.js';

function createModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, Backend: 'llama', ...overrides });
}

test('EXL3 adapter translates the shared preset without emitting unsupported fields', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    NumCtx: 84_993,
    ParallelSlots: 1,
    KvCacheQuantization: 'q8_0/q4_0',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
    SpeculativeDraftMax: 3,
  });

  const translated = new Exl3PresetAdapter('D:\\personal\\models\\exl3').buildLoadRequest(preset);

  assert.deepEqual(translated, {
    model_name: '3.6_27B',
    max_seq_len: 84_993,
    cache_size: 85_248,
    cache_mode: '8,4',
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

  assert.deepEqual(new Exl3PresetAdapter('D:\\personal\\models\\exl3').buildLoadRequest(preset), {
    model_name: '3.6_27B',
    max_seq_len: preset.NumCtx,
    cache_size: preset.NumCtx,
    cache_mode: 'FP16',
  });
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

test('EXL3 cache compatibility is exhaustive', () => {
  assert.deepEqual([
    getExl3CacheMode('f32'),
    getExl3CacheMode('f16'),
    getExl3CacheMode('bf16'),
    getExl3CacheMode('q8_0'),
    getExl3CacheMode('q4_0'),
    getExl3CacheMode('q4_1'),
    getExl3CacheMode('iq4_nl'),
    getExl3CacheMode('q5_0'),
    getExl3CacheMode('q5_1'),
    getExl3CacheMode('q8_0/q4_0'),
    getExl3CacheMode('q8_0/q5_0'),
  ], [null, 'FP16', null, '8,8', '4,4', null, null, '5,5', null, '8,4', '8,5']);
});

test('EXL3 availability disables fields without equivalents and keeps wake settings enabled', () => {
  const unsupported = [
    'ExecutablePath',
    'GpuLayers',
    'Threads',
    'NcpuMoe',
    'FlashAttention',
    'BatchSize',
    'UBatchSize',
    'CacheRam',
    'ReasoningBudget',
    'ReasoningBudgetMessage',
    'ParallelSlots',
    'SpeculativeEnabled',
    'SpeculativeType',
    'SpeculativeMtpEnabled',
    'SpeculativeDraftMax',
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
    assert.deepEqual(getPresetFieldAvailability('exl3', field), {
      enabled: false,
      reason: 'Not supported by EXL3',
    });
  }
  assert.deepEqual(getPresetFieldAvailability('exl3', 'SleepIdleSeconds'), { enabled: true, reason: null });
  assert.deepEqual(getPresetFieldAvailability('exl3', 'KvCacheQuantization'), {
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
    assert.deepEqual(getPresetFieldAvailability('exl3', field), { enabled: true, reason: null });
  }
  assert.deepEqual(getPresetFieldAvailability('llama', 'GpuLayers'), { enabled: true, reason: null });
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
