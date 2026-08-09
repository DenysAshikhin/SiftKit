import type { ModelRuntimePreset } from '../../src/config/types.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';

/** The default preset, overridden per test. Keeps every preset fixture on one definition. */
export function makeTestPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const [defaultPreset] = getDefaultConfigObject().Server.ModelPresets.Presets;
  return { ...defaultPreset, ...overrides };
}
