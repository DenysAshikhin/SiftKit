import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_TURN_TOOL_RESULT_RATIO,
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

test('a lone tool call early in a run gets the whole floor share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.usablePromptTokens, 85_000);
  assert.equal(budget.perToolCapTokens(0, 1), Math.floor(85_000 * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(0, 1), 6_375);
});

test('the turn share still grows with completed tool-call progress', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10 });
  const early = budget.perToolCapTokens(0, 1);
  const late = budget.perToolCapTokens(4, 1);
  assert.equal(early, Math.floor(85_000 * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(late, Math.floor(85_000 * (4 / 10)));
  assert.ok(late > early, `expected the cap to grow with progress, got ${late} <= ${early}`);
});

test('a batch divides whatever share the turn gets, so the batch total never exceeds one call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10 });
  for (const completedCommandCount of [0, 3, 7]) {
    const singleCallCap = budget.perToolCapTokens(completedCommandCount, 1);
    for (const batchCommandCount of [2, 3, 5, 9, 40]) {
      const perCall = budget.perToolCapTokens(completedCommandCount, batchCommandCount);
      assert.ok(
        perCall * batchCommandCount <= singleCallCap,
        `after ${completedCommandCount} commands, a batch of ${batchCommandCount} allowed `
        + `${perCall * batchCommandCount} tokens, above the single-call cap ${singleCallCap}`,
      );
    }
  }
});

test('a zero or negative batch size is treated as a single call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.perToolCapTokens(0, 0), budget.perToolCapTokens(0, 1));
  assert.equal(budget.perToolCapTokens(0, -3), budget.perToolCapTokens(0, 1));
});

test('a fractional batch size is floored to whole calls before dividing', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.perToolCapTokens(0, 2.9), budget.perToolCapTokens(0, 2));
});

test('perToolCapTokens never drops below one token', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45 });
  assert.equal(budget.perToolCapTokens(0, 10_000), 1);
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
  assert.equal(budget.perToolCapTokens(100, 1), 1);
});
