import { z } from '../../src/lib/zod.js';
import type { SiftConfig } from '../../src/config/types.js';

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
  return MockSiftConfigSchema.parse(partial);
}
