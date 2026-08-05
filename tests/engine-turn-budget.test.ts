import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TURN_TOOL_RESULT_RATIO,
  THINKING_BUFFER_MIN_TOKENS,
  THINKING_BUFFER_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';

test('TurnBudget splits context into thinking buffer and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.thinkingBufferTokens, Math.max(Math.ceil(100_000 * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS));
  assert.equal(budget.usablePromptTokens, 100_000 - budget.thinkingBufferTokens);
});

test('TurnBudget enforces the 4000-token minimum thinking buffer on small contexts', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000 });
  assert.equal(budget.thinkingBufferTokens, 4_000);
  assert.equal(budget.usablePromptTokens, 4_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1_000 });
  assert.equal(budget.usablePromptTokens, 0);
});

test('a single tool call gets the whole turn share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.usablePromptTokens, 85_000);
  assert.equal(budget.perToolCapTokens(1), Math.floor(85_000 * TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(1), 6_375);
});

test('a batch divides the turn share so the batch total never exceeds a single call cap', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  const singleCallCap = budget.perToolCapTokens(1);
  for (const commandCount of [2, 3, 5, 9, 40]) {
    const perCall = budget.perToolCapTokens(commandCount);
    assert.equal(perCall, Math.max(1, Math.floor((85_000 * TURN_TOOL_RESULT_RATIO) / commandCount)));
    assert.ok(
      perCall * commandCount <= singleCallCap,
      `batch of ${commandCount} allowed ${perCall * commandCount} tokens, above the single-call cap ${singleCallCap}`,
    );
  }
});

test('a zero or negative command count is treated as a single call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.perToolCapTokens(0), budget.perToolCapTokens(1));
  assert.equal(budget.perToolCapTokens(-3), budget.perToolCapTokens(1));
});

test('a fractional command count is floored to whole calls before dividing', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.perToolCapTokens(2.9), budget.perToolCapTokens(2));
});

test('perToolCapTokens never drops below one token', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000 });
  assert.equal(budget.perToolCapTokens(10_000), 1);
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000 });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10 });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.usablePromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100), 1);
});
