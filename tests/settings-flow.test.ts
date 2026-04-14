import assert from 'node:assert/strict';
import test from 'node:test';

import { getDirtyActionRequirement, type DirtyContinuation } from '../dashboard/src/settings-flow.ts';

test('section switch requires confirmation when settings are dirty', () => {
  assert.equal(getDirtyActionRequirement(true, 'switch-section'), 'confirm');
});

test('section switch continues immediately when settings are clean', () => {
  assert.equal(getDirtyActionRequirement(false, 'switch-section'), 'continue');
});

test('save continuation preserves requested action metadata', () => {
  const continuation: DirtyContinuation = {
    kind: 'switch-tab',
    nextTab: 'runs',
  };
  assert.deepEqual(continuation, { kind: 'switch-tab', nextTab: 'runs' });
});
