import test from 'node:test';
import assert from 'node:assert/strict';

import { clampToPresetMaxTokens, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
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

test('clampToPresetMaxTokens caps the dynamic value at the active preset MaxTokens', () => {
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(2000), 25_000), 2000);
});

test('clampToPresetMaxTokens keeps the dynamic value when below the preset cap', () => {
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

test('clampToPresetMaxTokens composes with getDynamicMaxOutputTokens', () => {
  const dynamic = getDynamicMaxOutputTokens({ totalContextTokens: 32_000, promptTokenCount: 1000 });
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(500), dynamic), 500);
});
