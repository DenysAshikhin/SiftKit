import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantRateLimiter } from '../src/status-server/assistant-rate-limiter.js';

test('assistant rate limits use independent fixed windows per bearer and operation class', () => {
  const limiter = new AssistantRateLimiter();
  for (let index = 0; index < 120; index += 1) {
    assert.equal(limiter.consume('token-a', 'read', 1_000), true);
  }
  assert.equal(limiter.consume('token-a', 'read', 1_000), false);
  assert.equal(limiter.consume('token-a', 'mutation', 1_000), true);
  assert.equal(limiter.consume('token-b', 'read', 1_000), true);
  assert.equal(limiter.consume('token-a', 'read', 61_000), true);
  for (let index = 1; index < 10; index += 1) {
    assert.equal(limiter.consume('token-a', 'question_answer', 1_000), true);
  }
  assert.equal(limiter.consume('token-a', 'question_answer', 1_000), true);
  assert.equal(limiter.consume('token-a', 'question_answer', 1_000), false);
});
