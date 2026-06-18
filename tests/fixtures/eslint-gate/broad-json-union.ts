import type { JsonValue } from '../../../src/lib/json-types.js';

type MixedPayload = string | JsonValue;

const payload: MixedPayload = 'raw';

export { payload };
