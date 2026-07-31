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

// Normalization repairs a non-positive MaxTokens, so the guard branch needs a raw object.
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

test('clampToPresetMaxTokens passes the value through unchanged when config is undefined', () => {
  assert.equal(clampToPresetMaxTokens(undefined, 777), 777);
});

test('clampToPresetMaxTokens never returns less than 1', () => {
  assert.equal(clampToPresetMaxTokens(configWithRawMaxTokens(0), 100), 1);
});

test('clampToPresetMaxTokens composes with getDynamicMaxOutputTokens', () => {
  const dynamic = getDynamicMaxOutputTokens({ totalContextTokens: 32_000, promptTokenCount: 1000 });
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(500), dynamic), 500);
});
