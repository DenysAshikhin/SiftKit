import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESPONSE_RESERVE_TOKENS,
  computeResponseReserveTokens,
  getPresetMaxTokens,
} from '../src/lib/response-reserve.js';
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

test('RESPONSE_RESERVE_TOKENS is the single 15k shared reserve', () => {
  assert.equal(RESPONSE_RESERVE_TOKENS, 15_000);
});

test('a large context reserves the full flat amount', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(15_000) }),
    15_000,
  );
});

test('a small context clamps the reserve to half the window', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 8_000, config: configWithMaxTokens(15_000) }),
    4_000,
  );
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 1_000, config: configWithMaxTokens(15_000) }),
    500,
  );
});

test('a lower preset MaxTokens bounds the reserve so context is not stranded', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(8_000) }),
    8_000,
  );
});

test('a higher preset MaxTokens never raises the reserve above the shared constant', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(64_000) }),
    15_000,
  );
});

test('an absent config falls back to the shared constant', () => {
  assert.equal(computeResponseReserveTokens({ totalContextTokens: 140_000, config: null }), 15_000);
});

test('the reserve never drops below one token', () => {
  assert.equal(computeResponseReserveTokens({ totalContextTokens: 1, config: null }), 1);
  assert.equal(computeResponseReserveTokens({ totalContextTokens: -10, config: null }), 1);
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
