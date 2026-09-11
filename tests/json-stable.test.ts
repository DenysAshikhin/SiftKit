import assert from 'node:assert/strict';
import test from 'node:test';

import { stableStringify, writeStableJson } from '../src/lib/json.js';
import type { JsonValue } from '../src/lib/json-types.js';

const CASES: JsonValue[] = [
  null, 0, -1.5, true, '', 'quote " backslash \ newline \n unicode ☃',
  [], {}, [1, [2, [3, null]], { b: 1, a: [true] }],
  { z: 'last', a: { d: 1, c: [null, 'x'] }, m: '', 'k y': { '': 0 } },
  { output: 'x'.repeat(200_000), kind: 'tool_result', call: { turn: 1, batchId: 'b' } },
];

for (const [index, value] of CASES.entries()) test(`streamed stable JSON matches stableStringify byte for byte (${String(index)})`, () => {
  const chunks: string[] = [];
  writeStableJson(value, chunk => chunks.push(chunk));
  assert.equal(chunks.join(''), stableStringify(value));
  assert.deepEqual(JSON.parse(chunks.join('')), value);
});
