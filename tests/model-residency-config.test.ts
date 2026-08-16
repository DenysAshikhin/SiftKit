import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRuntimePresetSchema } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getPresetFieldAvailability } from '../src/inference-presets/preset-compatibility.js';
import { buildManagedLlamaArgs } from '../src/status-server/managed-llama.js';

function presetWith(backend: 'llama' | 'exl3', idleAction: string) {
  const base = getDefaultConfigObject();
  const presets = base.Server.ModelPresets.Presets.map((preset) => ({
    ...preset,
    Backend: backend,
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

function sleepIdleArg(args: readonly string[]): string | undefined {
  const index = args.indexOf('--sleep-idle-seconds');
  assert.notEqual(index, -1, 'expected --sleep-idle-seconds in the argument list');
  return args[index + 1];
}

test('IdleAction defaults to unload when absent from stored preset JSON', () => {
  assert.equal(getActiveModelPreset(getDefaultConfigObject()).IdleAction, 'unload');
});

test('IdleAction accepts every documented value', () => {
  for (const action of ['none', 'freeze', 'unload'] as const) {
    assert.equal(presetWith('exl3', action).IdleAction, action);
  }
});

test('IdleAction rejects an unrecognised value', () => {
  assert.throws(() => presetWith('exl3', 'hibernate'), /Invalid IdleAction/u);
});

test('llama presets reject freeze rather than clamping it', () => {
  assert.throws(() => presetWith('llama', 'freeze'), /backend llama cannot use IdleAction=freeze/u);
});

test('both backends keep none and unload idle actions', () => {
  for (const backend of ['llama', 'exl3'] as const) {
    for (const action of ['none', 'unload'] as const) {
      assert.equal(presetWith(backend, action).IdleAction, action);
    }
  }
});

test('IdleAction is visible on both backends', () => {
  assert.equal(getPresetFieldAvailability(presetWith('llama', 'unload'), 'IdleAction').visible, true);
  assert.equal(getPresetFieldAvailability(presetWith('exl3', 'unload'), 'IdleAction').visible, true);
});

test('all managed llama IdleAction values disable native llama.cpp idle sleep with -1', () => {
  const preset = ModelRuntimePresetSchema.parse({
    ...getActiveModelPreset(getDefaultConfigObject()),
    Backend: 'llama',
    IdleAction: 'none',
    SleepIdleSeconds: 600,
  });
  assert.equal(sleepIdleArg(buildManagedLlamaArgs(preset)), '-1');
  assert.equal(sleepIdleArg(buildManagedLlamaArgs(ModelRuntimePresetSchema.parse({
    ...preset,
    IdleAction: 'unload',
    SleepIdleSeconds: 42,
  }))), '-1');
});
