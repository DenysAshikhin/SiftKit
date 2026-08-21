import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_EXPECTED_TOKENS_PER_SECOND,
  assertDeadlineFitsBudget,
  computeRequiredGenerationMs,
} from '../src/llm-protocol/stream-deadline.js';

test('required generation time is derived from the throughput floor', () => {
  assert.equal(MIN_EXPECTED_TOKENS_PER_SECOND, 20);
  assert.equal(computeRequiredGenerationMs(15_000), 750_000);
  assert.equal(computeRequiredGenerationMs(200), 10_000);
});

test('the historical 15k-tokens-in-120s combination is rejected', () => {
  assert.throws(
    () => { assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 120_000 }); },
    /cannot fit a 15000-token budget/u,
  );
});

test('a deadline that fits the budget is accepted', () => {
  assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 750_000 });
});
