import { createHash } from 'node:crypto';

import { writeStableJson } from './json.js';
import type { JsonValue } from './json-types.js';

/** sha256 over the stable serialization, so equal JSON values digest equally regardless of key order. Node-only: json.ts is shared with the browser dashboard. */
export function digestStableJson(value: JsonValue): string {
  const hash = createHash('sha256');
  writeStableJson(value, chunk => { hash.update(chunk); });
  return hash.digest('hex');
}
