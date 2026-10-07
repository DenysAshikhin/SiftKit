import assert from 'node:assert/strict';
import test from 'node:test';

import { getActiveModelPreset } from '../src/config/getters.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.ts';

test('applied model preset state changes preset and admission capacity together', () => {
  const initial = getActiveModelPreset(getDefaultConfig());
  const replacement = { ...initial, id: 'replacement', ParallelSlots: 3 };
  const state = new AppliedModelPresetState(initial);

  assert.equal(state.getPreset(), initial);
  assert.equal(state.getParallelSlots(), 1);
  state.applyPreset(replacement);
  assert.equal(state.getPreset(), replacement);
  assert.equal(state.getParallelSlots(), 3);
});