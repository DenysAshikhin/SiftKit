import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantRateLimiter } from '../src/status-server/assistant-rate-limiter.ts';

test('assistant mutations are limited per bearer in fixed one-minute windows', () => {
  const limiter = new AssistantRateLimiter();
  for (let index = 0; index < 30; index += 1) {
    assert.equal(limiter.consumeMutation('token-a', 1_000), true);
  }
  assert.equal(limiter.consumeMutation('token-a', 1_000), false);
  assert.equal(limiter.consumeMutation('token-b', 1_000), true, 'each bearer has its own window');
  assert.equal(limiter.consumeMutation('token-a', 61_000), true, 'the window resets after a minute');
});
