import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResidencyControlState } from '../src/tabs/settings/ModelRuntimeResidencyPanel.js';

test('load is available only for an unloaded stable runtime', () => {
  assert.equal(resolveResidencyControlState('unloaded').load, true);
  assert.equal(resolveResidencyControlState('ready').load, false);
});

test('unload is available only for a ready stable runtime', () => {
  assert.equal(resolveResidencyControlState('ready').unload, true);
  assert.equal(resolveResidencyControlState('unloaded').unload, false);
});

test('control state exposes exactly load and unload', () => {
  assert.deepEqual(Object.keys(resolveResidencyControlState('ready')).sort(), ['load', 'unload']);
});

test('all controls are disabled during transitions, stopped processes, and requests', () => {
  for (const state of ['loading', 'unloading', 'failed'] as const) {
    assert.deepEqual(resolveResidencyControlState(state), { load: false, unload: false });
  }
  assert.deepEqual(resolveResidencyControlState('ready', 'starting'), { load: false, unload: false });
  assert.deepEqual(resolveResidencyControlState('ready', 'ready', true), { load: false, unload: false });
});
