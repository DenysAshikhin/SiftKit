import test from 'node:test';
import assert from 'node:assert/strict';

import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';

test('the estimator is deterministic and proportional to length', async () => {
  const counter = new EstimateTokenCounter(4);
  const short = await counter.count('abcd');
  const long = await counter.count('abcd'.repeat(100));
  assert.equal(short.tokenCount, 1);
  assert.equal(long.tokenCount, 100);
  assert.equal(short.tokenizerId, 'estimate');
  assert.deepEqual(await counter.count('abcd'), short);
});

test('an empty string still costs one token', async () => {
  assert.equal((await new EstimateTokenCounter(4).count('')).tokenCount, 1);
});

test('a non-positive characters-per-token is rejected at construction', () => {
  assert.throws(() => new EstimateTokenCounter(0), /characters per token/i);
});