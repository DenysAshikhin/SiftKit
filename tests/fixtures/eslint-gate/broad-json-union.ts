import type { JsonValue } from '../../../src/lib/json-types.ts';

type MixedPayload = string | JsonValue;

const payload: MixedPayload = 'raw';

export { payload };
