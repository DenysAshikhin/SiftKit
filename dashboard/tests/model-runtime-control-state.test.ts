import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResidencyControlState } from '../src/tabs/settings/ModelRuntimeResidencyPanel.js';

test('load and restore is available for unloaded and frozen stable runtimes', () => {
  assert.equal(resolveResidencyControlState('unloaded', 'exl3', false).load, true);
  assert.equal(resolveResidencyControlState('frozen', 'exl3', true).load, true);
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).load, false);
});

test('freeze to RAM is available only for a ready EXL3 runtime', () => {
  assert.equal(resolveResidencyControlState('ready', 'exl3', true).freeze, true);
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).freeze, false);
  assert.equal(resolveResidencyControlState('frozen', 'exl3', true).freeze, false);
});

test('freeze to RAM is unavailable when the installed exllamav3 has no freeze patch', () => {
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).freeze, false);
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).load, false);
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).unload, true);
});

test('unload is available for ready and frozen stable resident runtimes', () => {
  assert.equal(resolveResidencyControlState('ready', 'exl3', false).unload, true);
  assert.equal(resolveResidencyControlState('frozen', 'exl3', true).unload, true);
  assert.equal(resolveResidencyControlState('unloaded', 'exl3', true).unload, false);
});

test('all controls are disabled during transitions, stopped processes, and requests', () => {
  for (const state of ['loading', 'freezing', 'unloading'] as const) {
    assert.deepEqual(resolveResidencyControlState(state, 'exl3', true), { load: false, freeze: false, unload: false });
  }
  assert.deepEqual(resolveResidencyControlState('ready', 'exl3', true, 'starting'), { load: false, freeze: false, unload: false });
  assert.deepEqual(resolveResidencyControlState('ready', 'exl3', true, 'ready', true), { load: false, freeze: false, unload: false });
});
