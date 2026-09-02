import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getPresetFieldAvailability } from '../src/inference-presets/preset-compatibility.js';

function presetWith(idleAction: string) {
  const base = getDefaultConfigObject();
  const presets = base.Server.ModelPresets.Presets.map((preset) => ({
    ...preset,
    Backend: 'exl3',
    IdleAction: idleAction,
  }));
  return getActiveModelPreset(normalizeConfigObject({
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: { ...base.Server.ModelPresets, Presets: presets },
    },
  }));
}

test('IdleAction defaults to unload when absent from stored preset JSON', () => {
  assert.equal(getActiveModelPreset(getDefaultConfigObject()).IdleAction, 'unload');
});

test('IdleAction accepts every documented value', () => {
  for (const action of ['none', 'freeze', 'unload'] as const) {
    assert.equal(presetWith(action).IdleAction, action);
  }
});

test('IdleAction rejects an unrecognised value', () => {
  assert.throws(() => presetWith('hibernate'), /Invalid IdleAction/u);
});

test('IdleAction is visible on the preset form', () => {
  assert.equal(getPresetFieldAvailability(presetWith('unload'), 'IdleAction').visible, true);
});
