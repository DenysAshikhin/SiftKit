import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_TURN_TOOL_RESULT_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';
import { RESPONSE_RESERVE_TOKENS } from '../src/lib/response-reserve.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens, IdleAction: 'unload' }] } },
  });
}

test('TurnBudget exposes the shared response reserve and prompt limit', () => {
  const budget = new TurnBudget({ totalContextTokens: 155_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, RESPONSE_RESERVE_TOKENS);
  assert.equal(budget.responseReserveTokens, 15_000);
  assert.equal(budget.maxPromptTokens, 140_000);
});

test('TurnBudget adds no compaction-specific prompt reservation', () => {
  const budget = new TurnBudget({ totalContextTokens: 155_000, maxTurns: 45, config: null });
  assert.equal(budget.remainingToolAllowance(129_000, 0), 11_000);
  assert.equal(budget.remainingToolAllowance(140_000, 0), 0);
});

test('TurnBudget clamps the reserve to half of a small context', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 4_000);
  assert.equal(budget.maxPromptTokens, 4_000);
});

test('TurnBudget bounds the reserve by the active preset MaxTokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: configWithMaxTokens(8_000) });
  assert.equal(budget.responseReserveTokens, 8_000);
  assert.equal(budget.maxPromptTokens, 132_000);
});

test('maxPromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 1);
  assert.equal(budget.maxPromptTokens, 0);
});

test('a lone tool call early in a run gets the whole floor share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.maxPromptTokens, 85_000);
  assert.equal(budget.perToolCapTokens(0, 1), Math.floor(budget.maxPromptTokens * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(0, 1), 6_375);
});

test('the turn share still grows with completed tool-call progress', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10, config: null });
  const early = budget.perToolCapTokens(0, 1);
  const late = budget.perToolCapTokens(4, 1);
  assert.equal(early, Math.floor(budget.maxPromptTokens * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(late, Math.floor(budget.maxPromptTokens * (4 / 10)));
  assert.ok(late > early, `expected the cap to grow with progress, got ${late} <= ${early}`);
});

test('a batch divides whatever share the turn gets, so the batch total never exceeds one call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10, config: null });
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
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.perToolCapTokens(0, 0), budget.perToolCapTokens(0, 1));
  assert.equal(budget.perToolCapTokens(0, -3), budget.perToolCapTokens(0, 1));
});

test('a fractional batch size is floored to whole calls before dividing', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.perToolCapTokens(0, 2.9), budget.perToolCapTokens(0, 2));
});

test('perToolCapTokens never drops below one token', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45, config: null });
  assert.equal(budget.perToolCapTokens(0, 10_000), 1);
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.maxPromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.maxPromptTokens, 1), 0);
});

test('resolveToolResultCapacity reports the same cap and allowance as the underlying methods', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10, config: null });
  const capacity = budget.resolveToolResultCapacity({
    promptTokenCount: 10_000,
    acceptedToolPromptTokensThisTurn: 5_000,
    completedCommandCount: 4,
    batchCommandCount: 2,
  });
  assert.deepEqual(capacity, {
    kind: 'available',
    perToolCapTokens: budget.perToolCapTokens(4, 2),
    remainingTokenAllowance: budget.remainingToolAllowance(10_000, 5_000),
  });
});

test('resolveToolResultCapacity is exhausted exactly when the allowance is zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 155_000, maxTurns: 45, config: null });
  const oneLeft = budget.resolveToolResultCapacity({
    promptTokenCount: budget.maxPromptTokens - 1,
    acceptedToolPromptTokensThisTurn: 0,
    completedCommandCount: 0,
    batchCommandCount: 1,
  });
  assert.deepEqual(oneLeft, {
    kind: 'available',
    perToolCapTokens: budget.perToolCapTokens(0, 1),
    remainingTokenAllowance: 1,
  });

  const atLimit = budget.resolveToolResultCapacity({
    promptTokenCount: budget.maxPromptTokens,
    acceptedToolPromptTokensThisTurn: 0,
    completedCommandCount: 0,
    batchCommandCount: 1,
  });
  assert.deepEqual(atLimit, { kind: 'exhausted' });

  const consumedByBatch = budget.resolveToolResultCapacity({
    promptTokenCount: budget.maxPromptTokens - 100,
    acceptedToolPromptTokensThisTurn: 100,
    completedCommandCount: 0,
    batchCommandCount: 2,
  });
  assert.equal(consumedByBatch.kind, 'exhausted');
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10, maxTurns: 0, config: null });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.responseReserveTokens, 1);
  assert.equal(budget.maxPromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100, 1), 1);
});
