import test from 'node:test';
import assert from 'node:assert/strict';

import { clampToPresetMaxTokens, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import { RESPONSE_RESERVE_TOKENS } from '../src/lib/response-reserve.js';
import { JsonValueSchema } from '../src/lib/json-types.js';
import type { SiftConfig } from '../src/config/types.js';
import { asRuntimeSiftConfig, mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens }] } },
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

test('a roomy context yields exactly the shared reserve as the output cap', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 20_000,
      config: configWithMaxTokens(15_000),
    }),
    RESPONSE_RESERVE_TOKENS,
  );
});

test('a nearly full context yields only what remains', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 133_000,
      config: configWithMaxTokens(15_000),
    }),
    7_000,
  );
});

test('the output cap is already bounded by the preset MaxTokens without a second clamp', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 1_000,
      config: configWithMaxTokens(2_000),
    }),
    2_000,
  );
});

test('the output cap never drops below one token', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 200_000,
      config: configWithMaxTokens(15_000),
    }),
    1,
  );
});

test('an absent config still bounds the output cap by the shared reserve', () => {
  assert.equal(
    getDynamicMaxOutputTokens({ totalContextTokens: 140_000, promptTokenCount: 20_000, config: null }),
    RESPONSE_RESERVE_TOKENS,
  );
});

test('clampToPresetMaxTokens caps a fixed value at the active preset MaxTokens', () => {
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(2000), 25_000), 2000);
});

test('clampToPresetMaxTokens keeps a value below the preset cap', () => {
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(15_000), 1234), 1234);
});

test('clampToPresetMaxTokens throws on a non-positive preset MaxTokens instead of capping at 1', () => {
  assert.throws(
    () => clampToPresetMaxTokens(configWithRawMaxTokens(0), 100),
    /Active model preset "default" has an invalid MaxTokens: 0/,
  );
});

test('clampToPresetMaxTokens throws on a fractional preset MaxTokens', () => {
  assert.throws(
    () => clampToPresetMaxTokens(configWithRawMaxTokens(12.5), 100),
    /Active model preset "default" has an invalid MaxTokens: 12.5/,
  );
});

test('estimate-driven callers still get a positive cap', () => {
  assert.ok(
    getDynamicMaxOutputTokens({
      totalContextTokens: 32_000,
      promptTokenCount: 1_000,
      config: configWithMaxTokens(15_000),
    }) > 0,
  );
});
