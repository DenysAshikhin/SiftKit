import type { ModelRuntimePreset } from '../../src/config/types.ts';
import { getDefaultConfigObject } from '../../src/config/defaults.ts';

/** The default preset, overridden per test. Keeps every preset fixture on one definition. */
export function makeTestPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const [defaultPreset] = getDefaultConfigObject().Server.ModelPresets.Presets;
  return { ...defaultPreset, ...overrides };
}
