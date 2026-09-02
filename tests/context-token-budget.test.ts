import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESPONSE_RESERVE_TOKENS,
  resolveContextTokenBudget,
  getPresetMaxTokens,
} from '../src/lib/response-reserve.js';
import { JsonValueSchema } from '../src/lib/json-types.js';
import type { SiftConfig } from '../src/config/types.js';
import { asRuntimeSiftConfig, mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens, IdleAction: 'unload' }] } },
  });
}

// Normalization repairs a non-positive MaxTokens, so the loud-failure branch needs a raw object.
function configWithRawMaxTokens(maxTokens: number): SiftConfig {
  const base = configWithMaxTokens(15_000);
  return asRuntimeSiftConfig(JsonValueSchema.parse({
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: {
        ...base.Server.ModelPresets,
        Presets: base.Server.ModelPresets.Presets.map((preset) => ({ ...preset, MaxTokens: maxTokens })),
      },
    },
  }));
}

test('RESPONSE_RESERVE_TOKENS is the single 15k shared reserve', () => {
  assert.equal(RESPONSE_RESERVE_TOKENS, 15_000);
});

test('the active-sized context resolves one response reserve and one prompt limit', () => {
  const budget = resolveContextTokenBudget({
    totalContextTokens: 155_000,
    config: configWithMaxTokens(15_000),
  });

  assert.deepEqual(budget, {
    totalContextTokens: 155_000,
    responseReserveTokens: 15_000,
    maxPromptTokens: 140_000,
  });
});

test('a large context reserves the full flat amount', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 140_000, config: configWithMaxTokens(15_000) }),
    { totalContextTokens: 140_000, responseReserveTokens: 15_000, maxPromptTokens: 125_000 },
  );
});

test('a small context clamps the reserve to half the window', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 8_000, config: configWithMaxTokens(15_000) }),
    { totalContextTokens: 8_000, responseReserveTokens: 4_000, maxPromptTokens: 4_000 },
  );
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 1_000, config: configWithMaxTokens(15_000) }),
    { totalContextTokens: 1_000, responseReserveTokens: 500, maxPromptTokens: 500 },
  );
});

test('a lower preset MaxTokens bounds the reserve so context is not stranded', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 140_000, config: configWithMaxTokens(8_000) }),
    { totalContextTokens: 140_000, responseReserveTokens: 8_000, maxPromptTokens: 132_000 },
  );
});

test('a higher preset MaxTokens never raises the reserve above the shared constant', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 140_000, config: configWithMaxTokens(64_000) }),
    { totalContextTokens: 140_000, responseReserveTokens: 15_000, maxPromptTokens: 125_000 },
  );
});

test('an absent config falls back to the shared constant', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 8_000, config: null }),
    { totalContextTokens: 8_000, responseReserveTokens: 4_000, maxPromptTokens: 4_000 },
  );
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 140_000, config: null }),
    { totalContextTokens: 140_000, responseReserveTokens: 15_000, maxPromptTokens: 125_000 },
  );
});

test('the reserve never drops below one token and the prompt limit never goes negative', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 1, config: null }),
    { totalContextTokens: 1, responseReserveTokens: 1, maxPromptTokens: 0 },
  );
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: -10, config: null }),
    { totalContextTokens: 1, responseReserveTokens: 1, maxPromptTokens: 0 },
  );
});

test('a zero or non-numeric context window still yields the minimum budget', () => {
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: 0, config: null }),
    { totalContextTokens: 1, responseReserveTokens: 1, maxPromptTokens: 0 },
  );
  assert.deepEqual(
    resolveContextTokenBudget({ totalContextTokens: Number.NaN, config: null }),
    { totalContextTokens: 1, responseReserveTokens: 1, maxPromptTokens: 0 },
  );
});

test('an invalid preset MaxTokens fails the whole budget resolution', () => {
  assert.throws(
    () => resolveContextTokenBudget({ totalContextTokens: 140_000, config: configWithRawMaxTokens(0) }),
    /Active model preset "default" has an invalid MaxTokens: 0/,
  );
});

test('getPresetMaxTokens throws on a non-positive preset MaxTokens', () => {
  assert.throws(
    () => getPresetMaxTokens(configWithRawMaxTokens(0)),
    /Active model preset "default" has an invalid MaxTokens: 0/,
  );
});

test('getPresetMaxTokens throws on a fractional preset MaxTokens', () => {
  assert.throws(
    () => getPresetMaxTokens(configWithRawMaxTokens(12.5)),
    /Active model preset "default" has an invalid MaxTokens: 12.5/,
  );
});
