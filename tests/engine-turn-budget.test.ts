import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PER_TOOL_RESULT_RATIO,
  THINKING_BUFFER_MIN_TOKENS,
  THINKING_BUFFER_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';

test('TurnBudget splits context into thinking buffer and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.thinkingBufferTokens, Math.max(Math.ceil(100_000 * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS));
  assert.equal(budget.usablePromptTokens, 100_000 - budget.thinkingBufferTokens);
});

test('TurnBudget enforces the 4000-token minimum thinking buffer on small contexts', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45 });
  assert.equal(budget.thinkingBufferTokens, 4_000);
  assert.equal(budget.usablePromptTokens, 4_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1_000, maxTurns: 45 });
  assert.equal(budget.usablePromptTokens, 0);
});

test('perToolCapTokens uses the floor ratio until command count overtakes it', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10 });
  assert.equal(budget.perToolCapTokens(0), Math.max(1, Math.floor(budget.usablePromptTokens * PER_TOOL_RESULT_RATIO)));
  assert.equal(budget.perToolCapTokens(5), Math.max(1, Math.floor(budget.usablePromptTokens * 0.5)));
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10, maxTurns: 0 });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.usablePromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100), 1);
});
