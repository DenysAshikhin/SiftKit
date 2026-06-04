import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRecentTokenRepetition } from '../src/repo-search/repetition-guard.js';

test('detectRecentTokenRepetition ignores short outputs below the trigger threshold', () => {
  const text = `${'</arg_value>'.repeat(20)} normal`;

  assert.equal(detectRecentTokenRepetition(text), null);
});

test('detectRecentTokenRepetition catches repeated suffix tokens in long output', () => {
  const text = `${Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ')} ${'</arg_value>'.repeat(10)}`;

  const result = detectRecentTokenRepetition(text);

  assert.notEqual(result, null);
  assert.equal(result?.periodTokens, 1);
  assert.equal(result?.windowTokens, 10);
  assert.equal(result?.repeatedTokens.join(''), '</arg_value>');
});

test('detectRecentTokenRepetition catches alternating structural loops', () => {
  const text = `${Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ')} ${'}]'.repeat(5)}`;

  const result = detectRecentTokenRepetition(text);

  assert.notEqual(result, null);
  assert.equal(result?.periodTokens, 2);
  assert.equal(result?.repeatedTokens.join(''), '}]');
});
