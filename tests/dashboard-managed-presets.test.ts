import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addManagedLlamaPreset,
  applyManagedLlamaPresetSelection,
  deleteManagedLlamaPreset,
  type DashboardManagedLlamaPreset,
} from '../dashboard/src/managed-llama-presets.ts';
import type { DashboardConfig } from '../dashboard/src/types.ts';

function createPreset(overrides: Partial<DashboardManagedLlamaPreset> = {}): DashboardManagedLlamaPreset {
  return {
    id: 'default',
    label: 'Default',
    Model: 'default.gguf',
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
    ReasoningBudget: 10000,
    ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
    StartupTimeoutMs: 600000,
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 1000,
    VerboseLogging: false,
    ...overrides,
  };
}

function createConfig(): DashboardConfig {
  const preset = createPreset();
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: 'prompt',
    OperationModeAllowedTools: {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': [],
      full: [],
    },
    Presets: [],
    Model: '',
    LlamaCpp: {
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
      ReasoningContent: preset.ReasoningContent,
      PreserveThinking: preset.PreserveThinking,
    },
    Runtime: {
      Model: '',
      LlamaCpp: {
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
        ReasoningContent: preset.ReasoningContent,
        PreserveThinking: preset.PreserveThinking,
      },
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
    Server: {
      LlamaCpp: {
        Model: preset.Model,
        ...preset,
        Presets: [
          preset,
          createPreset({
            id: 'qwen-27b',
            label: 'Qwen 27B',
            ModelPath: 'D:\\models\\qwen-27b.gguf',
            Threads: 0,
            Port: 8098,
          }),
        ],
        ActivePresetId: 'default',
      },
    },
  };
}

test('applyManagedLlamaPresetSelection mirrors the selected managed preset into the active server settings', () => {
  const config = createConfig();
  Object.assign(
    config.Server.LlamaCpp.Presets[1] as {
      Model?: string;
      NcpuMoe?: number;
      ReasoningContent?: boolean;
      PreserveThinking?: boolean;
    },
    {
      Model: 'qwen-27b.gguf',
      NcpuMoe: 8,
      ReasoningContent: true,
      PreserveThinking: true,
    },
  );

  applyManagedLlamaPresetSelection(config, 'qwen-27b');

  assert.equal(config.Server.LlamaCpp.ActivePresetId, 'qwen-27b');
  assert.equal(config.Server.LlamaCpp.ModelPath, 'D:\\models\\qwen-27b.gguf');
  assert.equal(config.Server.LlamaCpp.Threads, 0);
  assert.equal((config.Server.LlamaCpp as { NcpuMoe?: number }).NcpuMoe, 8);
  assert.equal(config.Server.LlamaCpp.Port, 8098);
  assert.equal(config.Server.LlamaCpp.ReasoningContent, true);
  assert.equal(config.Server.LlamaCpp.PreserveThinking, true);
  assert.equal(config.Server.LlamaCpp.ReasoningBudgetMessage, 'Thinking budget exhausted. You have to provide the answer now.');
  assert.equal(config.Runtime.Model, 'qwen-27b.gguf');
  assert.equal(config.Model, 'qwen-27b.gguf');
});

test('addManagedLlamaPreset clones the active preset and creates a unique id', () => {
  const config = createConfig();

  const addedPresetId = addManagedLlamaPreset(config);

  assert.equal(addedPresetId, 'default-2');
  assert.equal(config.Server.LlamaCpp.ActivePresetId, 'default-2');
  assert.equal(config.Server.LlamaCpp.Presets?.some((preset) => preset.id === 'default-2'), true);
});

test('deleteManagedLlamaPreset removes the preset and falls back to another preset', () => {
  const config = createConfig();

  deleteManagedLlamaPreset(config, 'default');

  assert.equal(config.Server.LlamaCpp.Presets?.some((preset) => preset.id === 'default'), false);
  assert.equal(config.Server.LlamaCpp.ActivePresetId, 'qwen-27b');
  assert.equal(config.Server.LlamaCpp.ModelPath, 'D:\\models\\qwen-27b.gguf');
});
