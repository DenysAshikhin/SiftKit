import test from 'node:test';
import assert from 'node:assert/strict';

import { editDistanceWithin, isNearOwnerAlias } from '../src/assistant/domain/owner-identity.js';

test('editDistanceWithin matches the Levenshtein bound', () => {
  assert.equal(editDistanceWithin('denyz', 'denys', 2), true);
  assert.equal(editDistanceWithin('demyus', 'denys', 2), true);
  assert.equal(editDistanceWithin('dmitry', 'denys', 2), false);
  assert.equal(editDistanceWithin('kitten', 'sitting', 3), true);
  assert.equal(editDistanceWithin('kitten', 'sitting', 2), false);
  assert.equal(editDistanceWithin('', 'ab', 2), true);
  assert.equal(editDistanceWithin('abc', '', 2), false);
  assert.equal(editDistanceWithin('same', 'same', 0), true);
});

test('isNearOwnerAlias ignores short names, exact matches, and pronouns', () => {
  const aliases = ['the user', 'user', 'me', 'i', 'myself', 'denys'];
  assert.equal(isNearOwnerAlias('deny', aliases), true);
  assert.equal(isNearOwnerAlias('den', aliases), false);
  assert.equal(isNearOwnerAlias('denys', aliases), false);
  assert.equal(isNearOwnerAlias('ester', aliases), false);
  assert.equal(isNearOwnerAlias('alice', aliases), false);
});
