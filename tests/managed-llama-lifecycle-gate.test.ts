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

test('managesManagedLlamaLifecycle: active llama preset drives the lifecycle', () => {
  const config = getDefaultConfigObject();
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), true);
});

test('managesManagedLlamaLifecycle: active exl3 preset must NOT drive the llama lifecycle', () => {
  const config = withActivePreset((c) => {
    const base = c.Server.ModelPresets.Presets[0];
    if (!base) throw new Error('default preset missing');
    const exl3Preset = { ...base, id: 'exl3-main', Backend: 'exl3' as const };
    c.Server.ModelPresets = { ActivePresetId: exl3Preset.id, Presets: [exl3Preset, base] };
  });
  assert.equal(managesManagedLlamaLifecycle(config), false);
});

// RED until Task 1 Step 3. Removed in Task 7 Step 9 when the field no longer exists.
test('managesManagedLlamaLifecycle: ignores any top-level Backend value', () => {
  const config = withActivePreset((c) => {
    c.Backend = 'noop';
  });
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal(managesManagedLlamaLifecycle(config), true);
});
