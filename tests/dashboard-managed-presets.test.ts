import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addManagedLlamaPreset,
  applyManagedLlamaPresetSelection,
  deleteManagedLlamaPreset,
  getActiveModelPreset,
  type DashboardModelRuntimePreset,
} from '../dashboard/src/managed-llama-presets.js';
import type { DashboardConfig, DashboardLlamaCppConfig } from '../dashboard/src/types.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getTestExl3Engine, getTestInferenceConfig } from './helpers/runtime-config.js';

function createPreset(overrides: Partial<DashboardModelRuntimePreset> = {}): DashboardModelRuntimePreset {
  return {
    id: 'default',
    label: 'Default',
    Backend: 'llama',
    Model: 'default.gguf',
    ExternalServerEnabled: false,
    ExecutablePath: null,
    BaseUrl: 'http://127.0.0.1:8097',
    BindHost: '127.0.0.1',
    Port: 8097,
    ModelPath: null,
    NumCtx: 150000,
    GpuLayers: 999,
    Threads: -1,
    NcpuMoe: 0,
    FlashAttention: true,
    ParallelSlots: 1,
    BatchSize: 512,
    UBatchSize: 512,
    CacheRam: 8192,
    KvCacheQuantization: 'f16',
    MaxTokens: 15000,
    Temperature: 0.7,
    TopP: 0.8,
    TopK: 20,
    MinP: 0,
    PresencePenalty: 1.5,
    RepetitionPenalty: 1,
    Reasoning: 'off',
    ReasoningContent: false,
    PreserveThinking: false,
    MaintainPerStepThinking: false,
    SpeculativeEnabled: false,
    SpeculativeType: 'ngram-map-k',
    SpeculativeMtpEnabled: false,
    SpeculativeNgramSizeN: 8,
    SpeculativeNgramSizeM: 16,
    SpeculativeNgramMinHits: 2,
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 4,
    SpeculativeNgramModNMax: 16,
    SpeculativeDraftMax: 16,
    SpeculativeDraftMin: 4,
    ReasoningBudget: 10000,
    ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
    StartupTimeoutMs: 600000,
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 1000,
    SleepIdleSeconds: 600,
    VerboseLogging: false,
    ...overrides,
  };
}

function presetToLlamaCpp(preset: DashboardModelRuntimePreset): DashboardLlamaCppConfig {
  return {
    BaseUrl: preset.BaseUrl,
    NumCtx: preset.NumCtx,
    ModelPath: preset.ModelPath,
    Temperature: preset.Temperature,
    TopP: preset.TopP,
    TopK: preset.TopK,
    MinP: preset.MinP,
    PresencePenalty: preset.PresencePenalty,
    RepetitionPenalty: preset.RepetitionPenalty,
    MaxTokens: preset.MaxTokens,
    GpuLayers: preset.GpuLayers,
    Threads: preset.Threads,
    NcpuMoe: preset.NcpuMoe,
    FlashAttention: preset.FlashAttention,
    ParallelSlots: preset.ParallelSlots,
    Reasoning: preset.Reasoning,
  };
}

function createConfig(): DashboardConfig {
  const defaultPreset = createPreset();
  const qwenPreset = createPreset({
    id: 'qwen-27b',
    label: 'Qwen 27B',
    Model: 'qwen-27b.gguf',
    ModelPath: 'D:\\models\\qwen-27b.gguf',
    Threads: 0,
    Port: 8098,
    SleepIdleSeconds: 120,
  });
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    IncludeAgentsMd: true,
    IncludeRepoFileListing: true,
    ExpandReads: true,
    PromptPrefix: 'prompt',
    Inference: getTestInferenceConfig(),
    OperationModeAllowedTools: {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': [],
      full: [],
    },
    Presets: [],
    Runtime: {
      LlamaCpp: presetToLlamaCpp(defaultPreset),
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: false, ApiKey: '' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
    Server: {
      ModelPresets: {
        Presets: [defaultPreset, qwenPreset],
        ActivePresetId: 'default',
      },
      Engines: { Exl3: getTestExl3Engine() },
    },
  };
}

test('applyManagedLlamaPresetSelection switches the active managed preset', () => {
  const config = createConfig();
  Object.assign(config.Server.ModelPresets.Presets[1], {
    NcpuMoe: 8,
    ReasoningContent: true,
    PreserveThinking: true,
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-simple',
    SpeculativeDraftMax: 32,
  });

  applyManagedLlamaPresetSelection(config, 'qwen-27b');

  assert.equal(config.Server.ModelPresets.ActivePresetId, 'qwen-27b');
  const active = getActiveModelPreset(config);
  assert.equal(active.ModelPath, 'D:\\models\\qwen-27b.gguf');
  assert.equal(active.Threads, 0);
  assert.equal(active.NcpuMoe, 8);
  assert.equal(active.Port, 8098);
  assert.equal(active.ReasoningContent, true);
  assert.equal(active.PreserveThinking, true);
  assert.equal(active.MaintainPerStepThinking, false);
  assert.equal(active.SpeculativeEnabled, true);
  assert.equal(active.SpeculativeType, 'ngram-simple');
  assert.equal(active.SpeculativeDraftMax, 32);
  assert.equal(active.SleepIdleSeconds, 120);
});

test('managed llama preset defaults MaintainPerStepThinking on when reasoning is enabled', () => {
  const config = normalizeConfigObject({
    Server: {
      ModelPresets: {
        Presets: [{
          id: 'thinking-on',
          label: 'Thinking On',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
        }],
        ActivePresetId: 'thinking-on',
      },
    },
  });

  const preset = config.Server.ModelPresets.Presets[0];
  assert.equal(preset.Reasoning, 'on');
  assert.equal(preset.MaintainPerStepThinking, true);
});

test('managed llama preset honors explicit MaintainPerStepThinking false when reasoning is enabled', () => {
  const config = normalizeConfigObject({
    Server: {
      ModelPresets: {
        Presets: [{
          id: 'thinking-on-last-only',
          label: 'Thinking On Last Only',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
          MaintainPerStepThinking: false,
        }],
        ActivePresetId: 'thinking-on-last-only',
      },
    },
  });

  assert.equal(config.Server.ModelPresets.Presets[0].MaintainPerStepThinking, false);
});

test('managed llama preset disables MaintainPerStepThinking when reasoning is disabled', () => {
  const config = normalizeConfigObject({
    Server: {
      ModelPresets: {
        Presets: [{
          id: 'thinking-off',
          label: 'Thinking Off',
          Reasoning: 'off',
          MaintainPerStepThinking: true,
        }],
        ActivePresetId: 'thinking-off',
      },
    },
  });

  assert.equal(config.Server.ModelPresets.Presets[0].MaintainPerStepThinking, false);
});

test('applyManagedLlamaPresetSelection exposes ngram-mod MTP fields of the selected preset', () => {
  const config = createConfig();
  Object.assign(config.Server.ModelPresets.Presets[1], {
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: true,
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 12,
    SpeculativeNgramModNMax: 48,
  });

  applyManagedLlamaPresetSelection(config, 'qwen-27b');

  const active = getActiveModelPreset(config);
  assert.equal(active.SpeculativeMtpEnabled, true);
  assert.equal(active.SpeculativeNgramModNMatch, 24);
  assert.equal(active.SpeculativeNgramModNMin, 12);
  assert.equal(active.SpeculativeNgramModNMax, 48);
});

test('addManagedLlamaPreset clones the active preset and creates a unique id', () => {
  const config = createConfig();

  const addedPresetId = addManagedLlamaPreset(config);

  assert.equal(addedPresetId, 'default-2');
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'default-2');
  assert.equal(config.Server.ModelPresets.Presets.some((preset) => preset.id === 'default-2'), true);
});

test('deleteManagedLlamaPreset removes the preset and falls back to another preset', () => {
  const config = createConfig();

  deleteManagedLlamaPreset(config, 'default');

  assert.equal(config.Server.ModelPresets.Presets.some((preset) => preset.id === 'default'), false);
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'qwen-27b');
  assert.equal(getActiveModelPreset(config).ModelPath, 'D:\\models\\qwen-27b.gguf');
});
