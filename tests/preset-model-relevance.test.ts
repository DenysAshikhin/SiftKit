import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelPresetFieldSchema, ReasoningEffortSchema, type ModelProfile } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import {
  getMlaKvCacheEquivalent,
  getPresetFieldAvailability,
  getProfileIgnoredFields,
  getReasoningEffortOptions,
} from '../src/inference-presets/preset-compatibility.ts';
import { GLM_PROFILE } from '../dashboard/tests/fixtures.ts';

const BARE_PROFILE: ModelProfile = {
  name: 'bare', architecture: 'LlamaForCausalLM',
  moe: false, recurrent: false, mtp: false, vision: false, ngram: false, mla: false,
  reasoningEfforts: [], thinkingToggle: true, preserveThinking: true,
  sampling: { temperature: null, topP: null, topK: null },
};

function createPreset(overrides: { ExternalServerEnabled?: boolean; UnlockAllSettings?: boolean } = {}) {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return { ...preset, ExternalServerEnabled: false, ...overrides };
}

function disabledFields(profile: ModelProfile, unlocked = false): Record<string, string | null> {
  const preset = createPreset({ UnlockAllSettings: unlocked });
  const disabled: Record<string, string | null> = {};
  for (const field of ModelPresetFieldSchema.options) {
    const availability = getPresetFieldAvailability(preset, field, profile);
    if (availability.visible && !availability.enabled) disabled[field] = availability.reason;
  }
  return disabled;
}

test('a GLM-5.3-Flash profile disables exactly the settings its model and template ignore', () => {
  assert.deepEqual(disabledFields(GLM_PROFILE), {
    NgramRam: 'No n-gram embedding table',
    Reasoning: 'Template ignores enable_thinking; the model always thinks',
    PreserveThinking: 'Template ignores preserve_thinking',
  });
});

test('a profile without experts, recurrence, MTP, vision, or effort levels disables those settings', () => {
  const disabled = disabledFields(BARE_PROFILE);

  assert.deepEqual(Object.keys(disabled), [
    'NcpuMoe', 'CacheRecurrentRam', 'DiskCacheCheckpointInterval', 'NgramRam', 'ReasoningEffort',
    'SpeculativeEnabled', 'SpeculativeDraftMax', 'SpeculativeDynamic',
    'VisionEnabled', 'VisionOffload', 'VisionImageRetention', 'VisionMaxImagePixels',
  ]);
  assert.equal(disabled.DiskCacheCheckpointInterval, disabled.CacheRecurrentRam);
  assert.equal(disabled.ReasoningEffort, 'Template ignores reasoning_effort');
});

test('the ignored fields are listed regardless of unlock or launch mode', () => {
  assert.deepEqual(getProfileIgnoredFields(GLM_PROFILE), ['NgramRam', 'Reasoning', 'PreserveThinking']);
  assert.deepEqual(getProfileIgnoredFields(BARE_PROFILE), Object.keys(disabledFields(BARE_PROFILE)));
});

test('unlocking all settings or having no profile leaves every field editable', () => {
  assert.deepEqual(disabledFields(GLM_PROFILE, true), {});
  assert.deepEqual(disabledFields(BARE_PROFILE, true), {});
  const preset = createPreset();
  for (const field of ModelPresetFieldSchema.options) {
    assert.deepEqual(getPresetFieldAvailability(preset, field, null), { visible: true, enabled: true, reason: null }, field);
  }
});

test('an external preset reports the managed-launch reason before any model reason', () => {
  const external = createPreset({ ExternalServerEnabled: true });

  assert.deepEqual(getPresetFieldAvailability(external, 'NgramRam', GLM_PROFILE),
    { visible: true, enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' });
  assert.deepEqual(getPresetFieldAvailability(external, 'Reasoning', GLM_PROFILE),
    { visible: true, enabled: false, reason: 'Template ignores enable_thinking; the model always thinks' });
});

test('reasoning effort options follow the template unless unlocked, unprofiled, or unconstrained', () => {
  assert.deepEqual(getReasoningEffortOptions(createPreset(), GLM_PROFILE), ['low', 'high', 'max']);
  assert.deepEqual(getReasoningEffortOptions(createPreset({ UnlockAllSettings: true }), GLM_PROFILE), ReasoningEffortSchema.options);
  assert.deepEqual(getReasoningEffortOptions(createPreset(), null), ReasoningEffortSchema.options);
  assert.deepEqual(getReasoningEffortOptions(createPreset(), BARE_PROFILE), ReasoningEffortSchema.options);
});

test('a split KV cache mode on an MLA model is equivalent to its K-only mode', () => {
  assert.equal(getMlaKvCacheEquivalent(createPreset(), GLM_PROFILE, 'q8_0/q4_0'), 'q8_0');
  assert.equal(getMlaKvCacheEquivalent(createPreset(), GLM_PROFILE, 'q8_0/q5_0'), 'q8_0');
  assert.equal(getMlaKvCacheEquivalent(createPreset(), GLM_PROFILE, 'q4_0'), null);
  assert.equal(getMlaKvCacheEquivalent(createPreset(), BARE_PROFILE, 'q8_0/q4_0'), null);
  assert.equal(getMlaKvCacheEquivalent(createPreset({ UnlockAllSettings: true }), GLM_PROFILE, 'q8_0/q4_0'), null);
});
