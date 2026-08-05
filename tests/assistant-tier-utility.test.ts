import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TIER_UTILITY, routeTier, tierUtility,
} from '../src/assistant/domain/tier-utility.js';

const neutral = {
  explicitness: 0, crossDomainUsefulness: 0, retrievalFrequency: 0, recency: 0,
  activeGoalRelevance: 0, uniqueness: 0, userPin: 0,
  redundancy: 0, staleness: 0, sensitivityCost: 0,
} as const;

test('every weight matches the design formula', () => {
  assert.equal(tierUtility({ ...neutral, explicitness: 1 }), 3);
  assert.equal(tierUtility({ ...neutral, crossDomainUsefulness: 1 }), 2.5);
  assert.equal(tierUtility({ ...neutral, retrievalFrequency: 1 }), 2);
  assert.equal(tierUtility({ ...neutral, recency: 1 }), 1.5);
  assert.equal(tierUtility({ ...neutral, activeGoalRelevance: 1 }), 1.5);
  assert.equal(tierUtility({ ...neutral, uniqueness: 1 }), 1);
  assert.equal(tierUtility({ ...neutral, userPin: 1 }), 1);
  assert.equal(tierUtility({ ...neutral, redundancy: 1 }), -2);
  assert.equal(tierUtility({ ...neutral, staleness: 1 }), -1.5);
  assert.equal(tierUtility({ ...neutral, sensitivityCost: 1 }), -1);
});

test('the maximum score is the sum of the positive weights', () => {
  const allPositive = {
    ...neutral, explicitness: 1, crossDomainUsefulness: 1, retrievalFrequency: 1,
    recency: 1, activeGoalRelevance: 1, uniqueness: 1, userPin: 1,
  };
  assert.equal(tierUtility(allPositive), MAX_TIER_UTILITY);
});

test('a signal outside [0, 1] is rejected', () => {
  assert.throws(() => tierUtility({ ...neutral, recency: 1.5 }), /recency/);
  assert.throws(() => tierUtility({ ...neutral, redundancy: -1 }), /redundancy/);
});

test('routing respects projection behaviour before score', () => {
  assert.equal(routeTier('never_project', MAX_TIER_UTILITY), null);
  assert.equal(routeTier('episodic', MAX_TIER_UTILITY), 3);
});

test('a core-behaviour topic reaches tier 1 only with a high score', () => {
  assert.equal(routeTier('core', MAX_TIER_UTILITY), 1);
  assert.equal(routeTier('core', 4), 2);
});

test('a dossier-behaviour topic falls to tier 3 when its score is low', () => {
  assert.equal(routeTier('dossier', 5), 2);
  assert.equal(routeTier('dossier', 1), 3);
});