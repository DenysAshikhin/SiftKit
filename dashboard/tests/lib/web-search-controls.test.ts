import assert from 'node:assert/strict';
import test from 'node:test';

import { getNextWebSearchOverride, resolveEffectiveWebSearchEnabled } from '../../src/lib/web-search-controls';

test('getNextWebSearchOverride cycles composer override', () => {
  assert.equal(getNextWebSearchOverride('default'), 'on');
  assert.equal(getNextWebSearchOverride('on'), 'off');
  assert.equal(getNextWebSearchOverride('off'), 'default');
});

test('resolveEffectiveWebSearchEnabled applies override', () => {
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'default'), false);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'default'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'on'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'off'), false);
});
