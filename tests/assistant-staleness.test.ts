import test from 'node:test';
import assert from 'node:assert/strict';

import { RELATION_DEFINITIONS, RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import {
  STALENESS_HALF_LIFE_DAYS, stalenessFactor,
} from '../src/assistant/domain/staleness.js';

test('every registered predicate declares a staleness class', () => {
  for (const predicate of RELATION_TYPES) {
    const definition = RELATION_DEFINITIONS[predicate];
    assert.ok(
      definition.stalenessClass in STALENESS_HALF_LIFE_DAYS,
      `${predicate} has an unknown staleness class`,
    );
  }
});

test('stable identity never decays', () => {
  assert.equal(stalenessFactor('none', 0), 1);
  assert.equal(stalenessFactor('none', 100_000), 1);
});

test('a class decays to half its weight after exactly one half-life', () => {
  assert.equal(stalenessFactor('moderate', STALENESS_HALF_LIFE_DAYS.moderate ?? 0), 0.5);
  assert.equal(stalenessFactor('very_rapid', STALENESS_HALF_LIFE_DAYS.very_rapid ?? 0), 0.5);
});

test('decay is monotonic and bounded to (0, 1]', () => {
  let previous = stalenessFactor('fast', 0);
  assert.equal(previous, 1);
  for (const ageDays of [1, 10, 60, 365, 3650]) {
    const current = stalenessFactor('fast', ageDays);
    assert.ok(current < previous, `expected decay at ${ageDays} days`);
    assert.ok(current > 0 && current <= 1);
    previous = current;
  }
});

test('a negative age is rejected rather than silently clamped', () => {
  assert.throws(() => stalenessFactor('fast', -1), /age/i);
});

test('rapid classes decay faster than slow ones at the same age', () => {
  assert.ok(stalenessFactor('very_rapid', 30) < stalenessFactor('rapid', 30));
  assert.ok(stalenessFactor('rapid', 30) < stalenessFactor('fast', 30));
  assert.ok(stalenessFactor('fast', 30) < stalenessFactor('moderate', 30));
  assert.ok(stalenessFactor('moderate', 30) < stalenessFactor('slow', 30));
  assert.ok(stalenessFactor('slow', 30) < stalenessFactor('very_slow', 30));
  assert.ok(stalenessFactor('very_slow', 30) < stalenessFactor('none', 30));
});