import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRuntimeModelId, syncDerivedSettingsFields } from '../dashboard/src/settings-runtime.ts';
import type { DashboardConfig } from '../dashboard/src/types.ts';

test('deriveRuntimeModelId returns the gguf filename from a Windows path', () => {
  assert.equal(
    deriveRuntimeModelId('D:\\personal\\models\\Qwen3.5-27B-Q4_K_M.gguf'),
    'Qwen3.5-27B-Q4_K_M.gguf',
  );
});

test('deriveRuntimeModelId returns the filename from a Unix-style path', () => {
  assert.equal(
    deriveRuntimeModelId('/models/Qwen3.5-9B-Q8_0.gguf'),
    'Qwen3.5-9B-Q8_0.gguf',
  );
});

test('deriveRuntimeModelId trims whitespace and returns empty text for empty input', () => {
  assert.equal(deriveRuntimeModelId('   C:\\models\\example.gguf   '), 'example.gguf');
  assert.equal(deriveRuntimeModelId('   '), '');
  assert.equal(deriveRuntimeModelId(null), '');
});

test('syncDerivedSettingsFields uses the active managed preset model when present', () => {
  const config = {
    Model: '',
    Runtime: {
      Model: '',
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        ModelPath: null,
        NumCtx: 4096,
        Temperature: 0.7,
        TopP: 0.9,
        TopK: 40,
        MinP: 0.05,
        PresencePenalty: 0,
        RepetitionPenalty: 1.1,
        MaxTokens: 512,
        GpuLayers: 0,
        Threads: 4,
        FlashAttention: false,
        ParallelSlots: 1,
        Reasoning: 'off',
      },
    },
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      ModelPath: null,
      NumCtx: 4096,
      Temperature: 0.7,
      TopP: 0.9,
      TopK: 40,
      MinP: 0.05,
      PresencePenalty: 0,
      RepetitionPenalty: 1.1,
      MaxTokens: 512,
      GpuLayers: 0,
      Threads: 4,
      FlashAttention: false,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Server: {
      LlamaCpp: {
        Model: '',
        BaseUrl: 'http://127.0.0.1:8080',
        ExecutablePath: null,
        BindHost: '127.0.0.1',
        Port: 8080,
        ModelPath: 'D:\\models\\fallback.gguf',
        NumCtx: 4096,
        GpuLayers: 0,
        Threads: 4,
        FlashAttention: false,
        ParallelSlots: 1,
        BatchSize: 512,
        UBatchSize: 512,
        CacheRam: 2048,
        KvCacheQuantization: 'f16',
        MaxTokens: 512,
        Temperature: 0.7,
        TopP: 0.9,
        TopK: 40,
        MinP: 0.05,
        PresencePenalty: 0,
        RepetitionPenalty: 1.1,
        Reasoning: 'off',
        ReasoningContent: false,
        PreserveThinking: false,
        ReasoningBudget: 128,
        ReasoningBudgetMessage: '',
        StartupTimeoutMs: 1000,
        HealthcheckTimeoutMs: 1000,
        HealthcheckIntervalMs: 500,
        VerboseLogging: false,
        Presets: [
          {
            id: 'preset-a',
            label: 'Preset A',
            Model: 'Managed Model',
            ExecutablePath: null,
            BaseUrl: 'http://127.0.0.1:8080',
            BindHost: '127.0.0.1',
            Port: 8080,
            ModelPath: 'D:\\models\\managed.gguf',
            NumCtx: 4096,
            GpuLayers: 0,
            Threads: 4,
            FlashAttention: false,
            ParallelSlots: 1,
            BatchSize: 512,
            UBatchSize: 512,
            CacheRam: 2048,
            KvCacheQuantization: 'f16',
            MaxTokens: 512,
            Temperature: 0.7,
            TopP: 0.9,
            TopK: 40,
            MinP: 0.05,
            PresencePenalty: 0,
            RepetitionPenalty: 1.1,
            Reasoning: 'off',
            ReasoningContent: false,
            PreserveThinking: false,
            ReasoningBudget: 128,
            ReasoningBudgetMessage: '',
            StartupTimeoutMs: 1000,
            HealthcheckTimeoutMs: 1000,
            HealthcheckIntervalMs: 500,
            VerboseLogging: false,
          },
        ],
        ActivePresetId: 'preset-a',
      },
    },
  } as unknown as DashboardConfig;

  syncDerivedSettingsFields(config);

  assert.equal(config.Runtime.Model, 'Managed Model');
  assert.equal(config.Model, 'Managed Model');
});
