import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getManagedLlamaConfig, buildRuntimeLaunchSnapshot } from '../src/status-server/config-store.js';
import type { SiftConfig } from '../src/config/types.js';

function withExl3Active(mutate?: (config: SiftConfig) => void): SiftConfig {
  const config = getDefaultConfigObject();
  const base = config.Server.ModelPresets.Presets[0];
  if (!base) throw new Error('default preset missing');
  const exl3Preset = { ...base, id: 'exl3-main', Backend: 'exl3' as const, BaseUrl: 'http://127.0.0.1:8098' };
  config.Server.ModelPresets = { ActivePresetId: exl3Preset.id, Presets: [exl3Preset, base] };
  mutate?.(config);
  return config;
}

test('getManagedLlamaConfig: fails loud when the active preset is not llama-backed', () => {
  const config = withExl3Active();
  assert.throws(() => getManagedLlamaConfig(config), /llama/i);
});

test('getManagedLlamaConfig: resolves managed config for a llama-backed active preset', () => {
  const config = getDefaultConfigObject();
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  const managed = getManagedLlamaConfig(config);
  assert.equal(typeof managed.BaseUrl, 'string');
});

test('buildRuntimeLaunchSnapshot: emits empty LlamaCpp runtime for a non-llama active preset', () => {
  const config = withExl3Active((c) => {
    const active = c.Server.ModelPresets.Presets[0];
    if (active) active.Model = 'model-a';
  });
  const snapshot = buildRuntimeLaunchSnapshot(config);
  assert.deepEqual(snapshot.LlamaCpp, {});
  assert.equal(snapshot.Model, 'model-a');
});

test('buildRuntimeLaunchSnapshot: emits populated LlamaCpp runtime for a llama active preset', () => {
  const snapshot = buildRuntimeLaunchSnapshot(getDefaultConfigObject());
  assert.equal(typeof snapshot.LlamaCpp.BaseUrl, 'string');
});
