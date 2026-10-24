import { test } from 'vitest';
import assert from 'node:assert/strict';

import { diffRows, lineDiff } from '../src/lib/vault-diff.ts';

const ops = (pairs: readonly (readonly ['ctx' | 'add' | 'del', string])[]) => pairs.map(([kind, text]) => ({ kind, text }));

test('lineDiff reports a replaced middle line as delete then add', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']), ops([['ctx', 'a'], ['del', 'b'], ['add', 'x'], ['ctx', 'c']]));
});

test('lineDiff handles identical, empty-before and interleaved inputs', () => {
  assert.deepEqual(lineDiff(['a', 'b'], ['a', 'b']), ops([['ctx', 'a'], ['ctx', 'b']]));
  assert.deepEqual(lineDiff([], ['a', 'b']), ops([['add', 'a'], ['add', 'b']]));
  assert.deepEqual(lineDiff(['a', 'b', 'c', 'd'], ['b', 'c', 'e']), ops([['del', 'a'], ['ctx', 'b'], ['ctx', 'c'], ['del', 'd'], ['add', 'e']]));
});

test('lineDiff falls back to delete-all then add-all past the DP cell budget', () => {
  const before = Array.from({ length: 2001 }, (_, index) => `a${index}`);
  const after = Array.from({ length: 2001 }, (_, index) => `b${index}`);
  const result = lineDiff(before, after);
  assert.equal(result.length, 4002);
  assert.deepEqual(result[0], { kind: 'del', text: 'a0' });
  assert.deepEqual(result[2001], { kind: 'add', text: 'b0' });
});

test('diffRows keeps three context lines around each change and collapses the rest into one gap', () => {
  const before = Array.from({ length: 20 }, (_, index) => `l${index}`);
  const after = before.map((line, index) => (index === 10 ? 'changed' : line));
  const rows = diffRows(lineDiff(before, after), true);
  assert.deepEqual(rows.map((row) => (row.kind === 'gap' ? '…' : row.text)), ['…', 'l7', 'l8', 'l9', 'l10', 'changed', 'l11', 'l12', 'l13', '…']);
  assert.equal(diffRows(lineDiff(before, after), false).length, 21);
});
