import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import {
  getDirtyActionRequirement,
  isBackendRestartSupported,
  isModelPresetPickerBusy,
  isPresetAutoloadPickerBusy,
  type DirtyContinuation,
} from '../dashboard/src/settings-flow.js';

function getDefaultModelPreset() {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default config must include a model preset.');
  return preset;
}

test('section switch requires confirmation when settings are dirty', () => {
  assert.equal(getDirtyActionRequirement(true, 'switch-section'), 'confirm');
});

test('section switch continues immediately when settings are clean', () => {
  assert.equal(getDirtyActionRequirement(false, 'switch-section'), 'continue');
});

test('save continuation preserves requested action metadata', () => {
  const continuation: DirtyContinuation = {
    kind: 'switch-tab',
    nextTab: 'runs',
  };
  assert.deepEqual(continuation, { kind: 'switch-tab', nextTab: 'runs' });
});

test('restart is offered for managed backends and withheld for external servers', () => {
  const preset = getDefaultModelPreset();

  assert.equal(isBackendRestartSupported(null), false);
  assert.equal(isBackendRestartSupported({ ...preset, Backend: 'llama', ExternalServerEnabled: false }), true);
  assert.equal(isBackendRestartSupported({ ...preset, Backend: 'exl3', ExternalServerEnabled: false }), true);
  assert.equal(isBackendRestartSupported({ ...preset, ExternalServerEnabled: true }), false);
});

test('picker busy checks distinguish model preset fields from autoload rows', () => {
  assert.equal(isModelPresetPickerBusy(null, 'ModelPath'), false);
  assert.equal(isModelPresetPickerBusy({ kind: 'model-preset', field: 'ModelPath' }, 'ModelPath'), true);
  assert.equal(isModelPresetPickerBusy({ kind: 'model-preset', field: 'ExecutablePath' }, 'ModelPath'), false);
  assert.equal(isModelPresetPickerBusy({ kind: 'preset-autoload', presetId: 'a', index: 0 }, 'ModelPath'), false);

  assert.equal(isPresetAutoloadPickerBusy(null, 'a', 0), false);
  assert.equal(isPresetAutoloadPickerBusy({ kind: 'preset-autoload', presetId: 'a', index: 0 }, 'a', 0), true);
  assert.equal(isPresetAutoloadPickerBusy({ kind: 'preset-autoload', presetId: 'a', index: 1 }, 'a', 0), false);
  assert.equal(isPresetAutoloadPickerBusy({ kind: 'preset-autoload', presetId: 'b', index: 0 }, 'a', 0), false);
  assert.equal(isPresetAutoloadPickerBusy({ kind: 'model-preset', field: 'ModelPath' }, 'a', 0), false);
});
