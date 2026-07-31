import { z } from '../../src/lib/zod.js';
import { JsonValueSchema, type OptionalJsonValue } from '../../src/lib/json-types.js';
import type { ModelRuntimePreset, SiftConfig } from '../../src/config/types.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import { mergeConfig, normalizeConfigObject } from '../../src/config/normalization.js';

// Deliberately-partial SiftConfig fixtures: the input is structurally checked
// against a DeepPartial view (catching typos / wrong nesting) while the runtime
// value is branded to SiftConfig at this single boundary. Tests exercise only the
// fields they set; completing the object would change what the code under test reads.
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const MockSiftConfigSchema = z.custom<SiftConfig>((value) => typeof value === 'object' && value !== null);

export function mockSiftConfig(partial: DeepPartial<SiftConfig>): SiftConfig {
  const merged = mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), JsonValueSchema.parse(partial));
  return normalizeConfigObject(merged);
}

// A fully-populated ModelRuntimePreset for fixtures that need a preset snapshot
// (chat sessions) rather than a whole config. Starts from the normalized default
// preset so every required field is present.
export function mockModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Default config has no model preset.');
  }
  return { ...preset, ...overrides };
}

// Brand an already-constructed runtime config object (e.g. a stub server's live
// config, or a clone with a few overridden fields) as SiftConfig at one boundary.
// Accepts any JSON value; the schema predicate rejects non-objects at runtime.
export function asRuntimeSiftConfig(value: OptionalJsonValue): SiftConfig {
  return MockSiftConfigSchema.parse(value);
}
