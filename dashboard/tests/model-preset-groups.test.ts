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

function preset(overrides: Partial<DashboardModelRuntimePreset>): DashboardModelRuntimePreset {
  return {
    ...MANAGED_PRESET,
    Model: 'Qwen3.5-35B', ModelPath: 'Qwen3.5-35B-exl3-4.0bpw', BaseUrl: 'http://127.0.0.1:8098',
    NumCtx: 128000, UBatchSize: 512, KvCacheQuantization: 'f16',
    Temperature: 0.7, TopP: 0.8, TopK: 20, MaxTokens: 15000,
    Reasoning: 'off', MaintainPerStepThinking: true, ReasoningBudget: 10000,
    SpeculativeEnabled: true, SpeculativeDraftMax: 8, SpeculativeDynamic: true,
    StartupTimeoutMs: 120000, HealthcheckTimeoutMs: 5000, HealthcheckIntervalMs: 1000,
    SleepIdleSeconds: 600, IdleAction: 'unload',
    ...overrides,
  };
}

test('identity summary shows the model directory, management and endpoint', () => {
  assert.equal(summarizeIdentity(preset({})), 'Qwen3.5-35B-exl3-4.0bpw · managed · http://127.0.0.1:8098');
  assert.equal(
    summarizeIdentity(preset({ ModelPath: null, ExternalServerEnabled: true })),
    'Qwen3.5-35B · external · http://127.0.0.1:8098',
  );
});

test('memory summary reports context, chunk size and KV cache mode', () => {
  assert.equal(summarizeMemory(preset({})), 'ctx 128k · chunk 512 · KV f16');
});

test('sampling / reasoning / lifecycle summaries', () => {
  assert.equal(summarizeSampling(preset({})), 'temp 0.7 · top-p 0.8 · top-k 20 · max 15k');
  assert.equal(summarizeReasoning(preset({})), 'off · per-step thinking on · budget 10k');
  assert.equal(summarizeLifecycle(preset({})), 'startup 120s · probe 5s/1s · idle unload 600s');
});

test('preset summary reports the idle action alongside the timer', () => {
  const base = preset({});
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'none' }), /stays resident/u);
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'freeze' }), /idle freeze 600s/u);
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'unload' }), /idle unload 600s/u);
});

test('speculative summary covers dynamic, fixed and off', () => {
  assert.equal(summarizeSpeculative(preset({})), 'on · draft-mtp · dynamic ≤8');
  assert.equal(summarizeSpeculative(preset({ SpeculativeDynamic: false })), 'on · draft-mtp · 8');
  assert.equal(summarizeSpeculative(preset({ SpeculativeEnabled: false })), 'off');
});

test('summarizeModelPresetGroup dispatches by id and groups are complete', () => {
  assert.equal(MODEL_PRESET_GROUPS.length, 6);
  assert.equal(summarizeModelPresetGroup('sampling', preset({})), 'temp 0.7 · top-p 0.8 · top-k 20 · max 15k');
});
