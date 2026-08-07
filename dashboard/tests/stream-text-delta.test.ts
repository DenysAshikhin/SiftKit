import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTextDelta } from '../src/lib/stream-text-delta';

test('offset zero replaces (keyframe)', () => {
  assert.equal(applyTextDelta('old text', { turn: 1, offset: 0, text: 'new' }), 'new');
});

test('offset at the end appends', () => {
  assert.equal(applyTextDelta('abc', { turn: 1, offset: 3, text: 'def' }), 'abcdef');
});

test('offset inside rewrites the tail', () => {
  assert.equal(applyTextDelta('abcdef', { turn: 1, offset: 3, text: 'XY' }), 'abcXY');
});

test('an offset beyond the end is ignored (defensive gap rule)', () => {
  assert.equal(applyTextDelta('abc', { turn: 1, offset: 10, text: 'zzz' }), 'abc');
});