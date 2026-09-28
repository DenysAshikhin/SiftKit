import test from 'node:test';
import assert from 'node:assert/strict';

import { estimatePromptTokens } from '../../src/lib/chatMessages';

test('estimatePromptTokens returns at least one token and rounds up by four characters', () => {
  assert.equal(estimatePromptTokens(''), 1);
  assert.equal(estimatePromptTokens('x'.repeat(400)), 100);
  assert.equal(estimatePromptTokens('x'.repeat(401)), 101);
});
