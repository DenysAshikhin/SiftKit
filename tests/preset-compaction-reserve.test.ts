import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelPresetFieldSchema } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getConfiguredCompactionReserveTokens } from '../src/config/index.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { PROMPT_COMPACTION_RESERVE_TOKENS } from '../src/lib/context-token-budget.js';
import { getPlannerPromptBudget } from '../src/summary/chunking.js';

function buildConfigWithReserve(numCtx: number, compactionReserveTokens: number) {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('default config must include a model preset');
  preset.NumCtx = numCtx;
  preset.CompactionReserveTokens = compactionReserveTokens;
  return config;
}

test('CompactionReserveTokens is a model preset field', () => {
  assert.equal(ModelPresetFieldSchema.safeParse('CompactionReserveTokens').success, true);
});

test('the default preset reserves the shared compaction headroom', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  assert.equal(preset?.CompactionReserveTokens, PROMPT_COMPACTION_RESERVE_TOKENS);
  assert.equal(getConfiguredCompactionReserveTokens(config), 15_000);
});

test('a persisted preset without the field normalizes to the default reserve', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('default config must include a model preset');
  const { CompactionReserveTokens, ...withoutReserve } = preset;
  const normalized = normalizeConfigObject({
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: { ...config.Server.ModelPresets, Presets: [withoutReserve] },
    },
  });
  assert.equal(
    normalized.Server.ModelPresets.Presets[0]?.CompactionReserveTokens,
    PROMPT_COMPACTION_RESERVE_TOKENS,
  );
});

test('a persisted preset keeps its own reserve', () => {
  const config = buildConfigWithReserve(200_000, 40_000);
  const normalized = normalizeConfigObject(config);
  assert.equal(normalized.Server.ModelPresets.Presets[0]?.CompactionReserveTokens, 40_000);
  assert.equal(getConfiguredCompactionReserveTokens(normalized), 40_000);
});

test('the planner prompt budget compacts at the preset reserve', () => {
  const budget = getPlannerPromptBudget(buildConfigWithReserve(200_000, 40_000));
  assert.equal(budget.numCtxTokens, 200_000);
  assert.equal(budget.compactionReserveTokens, 40_000);
  assert.equal(budget.plannerStopLineTokens, 160_000);
});

test('a reserve larger than half the window is clamped to half', () => {
  const budget = getPlannerPromptBudget(buildConfigWithReserve(20_000, 40_000));
  assert.equal(budget.compactionReserveTokens, 10_000);
  assert.equal(budget.plannerStopLineTokens, 10_000);
});
