import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_COMPACTION_RESERVE_MAX_CONTEXT_RATIO,
  PROMPT_COMPACTION_RESERVE_TOKENS,
  resolveContextTokenBudget,
} from '../src/lib/context-token-budget.js';

test('155k context keeps a 15k compaction reserve', () => {
  assert.equal(PROMPT_COMPACTION_RESERVE_TOKENS, 15_000);
  assert.equal(PROMPT_COMPACTION_RESERVE_MAX_CONTEXT_RATIO, 0.5);
  assert.deepEqual(resolveContextTokenBudget({ totalContextTokens: 155_000 }), {
    totalContextTokens: 155_000,
    compactionReserveTokens: 15_000,
    maxPromptTokens: 140_000,
  });
});

test('small contexts reserve at most half the window', () => {
  assert.deepEqual(resolveContextTokenBudget({ totalContextTokens: 8_000 }), {
    totalContextTokens: 8_000,
    compactionReserveTokens: 4_000,
    maxPromptTokens: 4_000,
  });
});

test('invalid context windows fail loudly instead of collapsing to one token', () => {
  for (const totalContextTokens of [0, -10, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveContextTokenBudget({ totalContextTokens }),
      /totalContextTokens must be a positive integer/u,
    );
  }
});
