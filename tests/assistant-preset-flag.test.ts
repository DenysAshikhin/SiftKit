import test from 'node:test';
import assert from 'node:assert/strict';

import { SiftPresetSchema } from '../packages/contracts/src/config.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import { SIFT_DEFAULT_ASSISTANT_MEMORY } from '../src/config/constants.js';

const BUILTIN_PRESETS = PresetCatalog.createDefault().list();

test('the preset schema requires assistantMemory', () => {
  const base = BUILTIN_PRESETS[0];
  assert.ok(base);
  assert.equal(SiftPresetSchema.safeParse(base).success, true);
  const { assistantMemory, ...withoutFlag } = base;
  assert.equal(typeof assistantMemory, 'boolean');
  assert.equal(
    SiftPresetSchema.safeParse(withoutFlag).success,
    false,
    'a preset without the flag must fail loudly',
  );
});

test('every built-in preset declares the flag', () => {
  for (const preset of BUILTIN_PRESETS) {
    assert.equal(
      typeof preset.assistantMemory, 'boolean',
      `${preset.id} is missing assistantMemory`,
    );
  }
});

test('chat presets opt in and non-chat presets opt out', () => {
  for (const preset of BUILTIN_PRESETS) {
    const isChat = preset.id === 'chat';
    assert.equal(
      preset.assistantMemory, isChat,
      `${preset.id} should be ${isChat ? 'opted in' : 'opted out'}`,
    );
  }
});

test('the default for a newly created preset is off', () => {
  assert.equal(SIFT_DEFAULT_ASSISTANT_MEMORY, false);
});
