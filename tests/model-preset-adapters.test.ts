import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ManagedLlamaSettingsSchema,
  ModelPresetFieldSchema,
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
  type PresetFieldAvailability,
} from '../src/inference-presets/preset-compatibility.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

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
    TABBY_MEMORY_SYSMEM_PAGE_CACHE: String(preset.CacheRam),
    TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(preset.CacheRecurrentRam),
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
    TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: 'Q8',
    TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: 'true',
    TABBY_MODEL_VISION: 'false',
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
    TABBY_MEMORY_SYSMEM_PAGE_CACHE: String(preset.CacheRam),
    TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(preset.CacheRecurrentRam),
    TABBY_DRAFT_MODEL_DRAFT_MODE: 'disabled',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
    TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: 'false',
    TABBY_MODEL_VISION: 'false',
    EXL3_QC_ATTN: '0',
  });
  assert.equal('TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE' in adapter.buildLaunchEnvironment(preset), false);
});

test('EXL3 adapter disables dynamic drafting when the preset opts out', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'f16',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
    SpeculativeDynamic: false,
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.equal(adapter.buildLaunchEnvironment(preset).TABBY_DRAFT_MODEL_DRAFT_DYNAMIC, 'false');
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

/**
 * One expectation per preset field per backend state, so adding a field forces a deliberate
 * visibility decision here before `getPresetFieldAvailability` can compile against it.
 */
interface PresetFieldExpectation {
  llama: PresetFieldAvailability;
  managedExl3: PresetFieldAvailability;
  externalExl3: PresetFieldAvailability;
}

const AVAILABLE = { visible: true, enabled: true, reason: null } as const;
const HIDDEN = { visible: false } as const;
const NEEDS_MANAGED_TABBY = {
  visible: true,
  enabled: false,
  reason: 'Requires SiftKit-managed TabbyAPI',
} as const;
const EXL3_CACHE_MODES = {
  visible: true,
  enabled: true,
  reason: 'Only EXL3-compatible cache modes are available',
} as const;

/** Both backends accept it in every state. */
const ON_BOTH_BACKENDS = { llama: AVAILABLE, managedExl3: AVAILABLE, externalExl3: AVAILABLE } as const;
/** llama.cpp has it; EXL3 has no equivalent, so EXL3 never shows it. */
const LLAMA_ONLY = { llama: AVAILABLE, managedExl3: HIDDEN, externalExl3: HIDDEN } as const;
/** Both accept it, but EXL3 can only apply it to an engine SiftKit launches. */
const EXL3_MANAGED_ONLY = { llama: AVAILABLE, managedExl3: AVAILABLE, externalExl3: NEEDS_MANAGED_TABBY } as const;
/** EXL3 has it; llama.cpp has no equivalent, so llama never shows it. */
const EXL3_ONLY = { llama: HIDDEN, managedExl3: AVAILABLE, externalExl3: NEEDS_MANAGED_TABBY } as const;
/** Both accept it; EXL3 narrows the choices and says so. */
const EXL3_NARROWED = { llama: AVAILABLE, managedExl3: EXL3_CACHE_MODES, externalExl3: EXL3_CACHE_MODES } as const;

const PRESET_FIELD_EXPECTATIONS = {
  Model: ON_BOTH_BACKENDS,
  ExternalServerEnabled: ON_BOTH_BACKENDS,
  ExecutablePath: LLAMA_ONLY,
  BaseUrl: ON_BOTH_BACKENDS,
  BindHost: LLAMA_ONLY,
  Port: LLAMA_ONLY,
  ModelPath: ON_BOTH_BACKENDS,
  NumCtx: ON_BOTH_BACKENDS,
  GpuLayers: LLAMA_ONLY,
  Threads: LLAMA_ONLY,
  NcpuMoe: LLAMA_ONLY,
  FlashAttention: LLAMA_ONLY,
  ParallelSlots: EXL3_MANAGED_ONLY,
  BatchSize: LLAMA_ONLY,
  UBatchSize: ON_BOTH_BACKENDS,
  CacheRam: EXL3_MANAGED_ONLY,
  CacheRecurrentRam: EXL3_ONLY,
  KvCacheQuantization: EXL3_NARROWED,
  MaxTokens: ON_BOTH_BACKENDS,
  Temperature: ON_BOTH_BACKENDS,
  TopP: ON_BOTH_BACKENDS,
  TopK: ON_BOTH_BACKENDS,
  MinP: ON_BOTH_BACKENDS,
  PresencePenalty: ON_BOTH_BACKENDS,
  RepetitionPenalty: ON_BOTH_BACKENDS,
  Reasoning: ON_BOTH_BACKENDS,
  ReasoningContent: ON_BOTH_BACKENDS,
  PreserveThinking: ON_BOTH_BACKENDS,
  MaintainPerStepThinking: ON_BOTH_BACKENDS,
  SpeculativeEnabled: EXL3_MANAGED_ONLY,
  SpeculativeType: EXL3_MANAGED_ONLY,
  SpeculativeMtpEnabled: LLAMA_ONLY,
  SpeculativeNgramSizeN: LLAMA_ONLY,
  SpeculativeNgramSizeM: LLAMA_ONLY,
  SpeculativeNgramMinHits: LLAMA_ONLY,
  SpeculativeNgramModNMatch: LLAMA_ONLY,
  SpeculativeNgramModNMin: LLAMA_ONLY,
  SpeculativeNgramModNMax: LLAMA_ONLY,
  SpeculativeDraftMax: EXL3_MANAGED_ONLY,
  SpeculativeDynamic: EXL3_ONLY,
  SpeculativeDraftMin: LLAMA_ONLY,
  ReasoningBudget: LLAMA_ONLY,
  ReasoningBudgetMessage: LLAMA_ONLY,
  StartupTimeoutMs: ON_BOTH_BACKENDS,
  HealthcheckTimeoutMs: ON_BOTH_BACKENDS,
  HealthcheckIntervalMs: ON_BOTH_BACKENDS,
  SleepIdleSeconds: ON_BOTH_BACKENDS,
  VerboseLogging: LLAMA_ONLY,
  VisionEnabled: EXL3_ONLY,
  VisionImageRetention: EXL3_ONLY,
  VisionMaxImagePixels: EXL3_ONLY,
} satisfies Record<ModelPresetField, PresetFieldExpectation>;

test('every preset field states its visibility and availability for each backend state', () => {
  const llama = createModelPreset({ Backend: 'llama', ExternalServerEnabled: false });
  const externalLlama = createModelPreset({ Backend: 'llama', ExternalServerEnabled: true });
  const managedExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: false });
  const externalExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: true });

  for (const field of ModelPresetFieldSchema.options) {
    const expected = PRESET_FIELD_EXPECTATIONS[field];
    assert.deepEqual(getPresetFieldAvailability(llama, field), expected.llama, `llama/${field}`);
    assert.deepEqual(getPresetFieldAvailability(externalLlama, field), expected.llama, `external-llama/${field}`);
    assert.deepEqual(getPresetFieldAvailability(managedExl3, field), expected.managedExl3, `managed-exl3/${field}`);
    assert.deepEqual(getPresetFieldAvailability(externalExl3, field), expected.externalExl3, `external-exl3/${field}`);
  }
});

test('hidden fields carry no availability the form could render', () => {
  const llama = createModelPreset({ Backend: 'llama' });
  const managedExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: false });

  assert.deepEqual(getPresetFieldAvailability(managedExl3, 'GpuLayers'), { visible: false });
  assert.deepEqual(getPresetFieldAvailability(llama, 'CacheRecurrentRam'), { visible: false });
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
