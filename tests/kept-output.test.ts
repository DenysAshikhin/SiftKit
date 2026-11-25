import assert from 'node:assert/strict';
import test from 'node:test';

import { keepOutput } from '../src/output-digest/kept-output.ts';

test('an output no digest parser recognises keeps only its tail', () => {
  assert.deepEqual(keepOutput('abcdef', { tailChars: 3, digestChars: 100 }), { output: 'def', digest: null });
});

test('output within the limits is kept whole', () => {
  assert.deepEqual(keepOutput('abcdef', { tailChars: 10, digestChars: 100 }), { output: 'abcdef', digest: null });
});

test('a tsc failure digests the whole output, cut to its budget, while the output keeps its tail', () => {
  const output = `${'x'.repeat(100)}\nsrc/a.ts(1,2): error TS2304: Cannot find name 'x'.`;
  const result = keepOutput(output, { tailChars: 50, digestChars: 100 });
  assert.equal(result.output, output.slice(-50));
  assert.ok(result.digest !== null, 'the tsc failure must produce a digest');
  assert.ok(result.digest.length <= 100, String(result.digest.length));
});
