import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResidencyControlState } from '../src/tabs/settings/ModelRuntimeResidencyPanel.js';

test('load and restore is available for unloaded and frozen stable runtimes', () => {
  assert.equal(resolveResidencyControlState('unloaded', 'llama').load, true);
  assert.equal(resolveResidencyControlState('frozen', 'exl3').load, true);
  assert.equal(resolveResidencyControlState('ready', 'llama').load, false);
});

test('freeze to RAM is available only for a ready EXL3 runtime', () => {
  assert.equal(resolveResidencyControlState('ready', 'exl3').freeze, true);
  assert.equal(resolveResidencyControlState('ready', 'llama').freeze, false);
  assert.equal(resolveResidencyControlState('frozen', 'exl3').freeze, false);
});

test('unload is available for ready and frozen stable resident runtimes', () => {
  assert.equal(resolveResidencyControlState('ready', 'llama').unload, true);
  assert.equal(resolveResidencyControlState('frozen', 'exl3').unload, true);
  assert.equal(resolveResidencyControlState('unloaded', 'exl3').unload, false);
});

test('all controls are disabled during transitions, stopped processes, and requests', () => {
  for (const state of ['loading', 'freezing', 'unloading'] as const) {
    assert.deepEqual(resolveResidencyControlState(state, 'exl3'), { load: false, freeze: false, unload: false });
  }
  assert.deepEqual(resolveResidencyControlState('ready', 'exl3', 'starting'), { load: false, freeze: false, unload: false });
  assert.deepEqual(resolveResidencyControlState('ready', 'exl3', 'ready', true), { load: false, freeze: false, unload: false });
});
