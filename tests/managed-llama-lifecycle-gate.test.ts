import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { managesManagedLlamaLifecycle } from '../src/config/getters.js';
import type { SiftConfig } from '../src/config/types.js';

function withActivePreset(mutate: (config: SiftConfig) => void): SiftConfig {
  const config = getDefaultConfigObject();
  mutate(config);
  return config;
}

test('managesManagedLlamaLifecycle: llama.cpp provider + active llama preset drives the lifecycle', () => {
  const config = withActivePreset((c) => {
    c.Backend = 'llama.cpp';
  });
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), true);
});

test('managesManagedLlamaLifecycle: active exl3 preset must NOT drive the llama lifecycle', () => {
  const config = withActivePreset((c) => {
    c.Backend = 'llama.cpp';
    const base = c.Server.ModelPresets.Presets[0];
    if (!base) throw new Error('default preset missing');
    const exl3Preset = { ...base, id: 'exl3-main', Backend: 'exl3' as const };
    c.Server.ModelPresets = { ActivePresetId: exl3Preset.id, Presets: [exl3Preset, base] };
  });
  assert.equal(managesManagedLlamaLifecycle(config), false);
});

test('managesManagedLlamaLifecycle: non-llama.cpp provider (mock/noop) never drives the lifecycle', () => {
  const config = withActivePreset((c) => {
    c.Backend = 'noop';
  });
  // Active preset is still llama-backed, but the provider is a mock/noop backend.
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), false);
});
