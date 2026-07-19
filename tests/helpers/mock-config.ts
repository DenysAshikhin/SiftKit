import { z } from '../../src/lib/zod.js';
import { JsonValueSchema, type OptionalJsonValue } from '../../src/lib/json-types.js';
import type { SiftConfig } from '../../src/config/types.js';
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

// Brand an already-constructed runtime config object (e.g. a stub server's live
// config, or a clone with a few overridden fields) as SiftConfig at one boundary.
// Accepts any JSON value; the schema predicate rejects non-objects at runtime.
export function asRuntimeSiftConfig(value: OptionalJsonValue): SiftConfig {
  return MockSiftConfigSchema.parse(value);
}
