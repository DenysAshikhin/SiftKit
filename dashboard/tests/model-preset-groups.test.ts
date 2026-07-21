import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeIdentity,
  summarizeMemory,
  summarizeSampling,
  summarizeReasoning,
  summarizeSpeculative,
  summarizeLifecycle,
  summarizeModelPresetGroup,
  MODEL_PRESET_GROUPS,
} from '../src/tabs/settings/model-preset-groups';
import { MANAGED_PRESET } from './fixtures';
import type { DashboardModelRuntimePreset } from '../src/types';

function llama(overrides: Partial<DashboardModelRuntimePreset>): DashboardModelRuntimePreset {
  return {
    ...MANAGED_PRESET,
    Backend: 'llama', Model: 'Qwen3.5-35B Q4_K_L', BindHost: '127.0.0.1', Port: 8097,
    NumCtx: 128000, GpuLayers: 999, BatchSize: 512, UBatchSize: 512, KvCacheQuantization: 'f16',
    Temperature: 0.7, TopP: 0.8, TopK: 20, MaxTokens: 15000,
    Reasoning: 'off', MaintainPerStepThinking: true, ReasoningBudget: 10000,
    SpeculativeEnabled: true, SpeculativeType: 'ngram-map-k', SpeculativeNgramSizeN: 12, SpeculativeNgramSizeM: 4,
    SpeculativeDraftMin: 2, SpeculativeDraftMax: 8,
    StartupTimeoutMs: 120000, HealthcheckTimeoutMs: 5000, HealthcheckIntervalMs: 1000, SleepIdleSeconds: 600,
    ...overrides,
  };
}

test('identity summary shows model, management and endpoint', () => {
  assert.equal(summarizeIdentity(llama({})), 'Qwen3.5-35B Q4_K_L · managed · 127.0.0.1:8097');
  assert.equal(
    summarizeIdentity(llama({ Backend: 'exl3', ModelPath: 'Qwen3.5-35B-exl3-4.0bpw' })),
    'Qwen3.5-35B-exl3-4.0bpw · managed · 127.0.0.1:8097',
  );
});

test('memory summary branches on backend', () => {
  assert.equal(summarizeMemory(llama({})), 'ctx 128k · GPU 999 · batch 512/512 · KV f16');
  assert.equal(summarizeMemory(llama({ Backend: 'exl3' })), 'ctx 128k · chunk 512 · KV f16');
});

test('sampling / reasoning / lifecycle summaries', () => {
  assert.equal(summarizeSampling(llama({})), 'temp 0.7 · top-p 0.8 · top-k 20 · max 15k');
  assert.equal(summarizeReasoning(llama({})), 'off · per-step thinking on · budget 10k');
  assert.equal(summarizeLifecycle(llama({})), 'startup 120s · probe 5s/1s · idle unload 600s');
});

test('speculative summary covers ngram, draft and off', () => {
  assert.equal(summarizeSpeculative(llama({})), 'on · ngram-map-k · N12 M4');
  assert.equal(summarizeSpeculative(llama({ Backend: 'exl3', SpeculativeType: 'draft-mtp' })), 'on · draft-mtp · 2–8');
  assert.equal(summarizeSpeculative(llama({ SpeculativeEnabled: false })), 'off');
});

test('summarizeModelPresetGroup dispatches by id and groups are complete', () => {
  assert.equal(MODEL_PRESET_GROUPS.length, 6);
  assert.equal(summarizeModelPresetGroup('sampling', llama({})), 'temp 0.7 · top-p 0.8 · top-k 20 · max 15k');
});
