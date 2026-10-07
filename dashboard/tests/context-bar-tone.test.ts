import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getContextBarFillTone } from '../src/lib/context-bar-tone.ts';

test('fill tone is accent below 85% and warn at/above', () => {
  assert.equal(getContextBarFillTone(0), 'accent');
  assert.equal(getContextBarFillTone(0.84), 'accent');
  assert.equal(getContextBarFillTone(0.85), 'warn');
  assert.equal(getContextBarFillTone(1), 'warn');
});
