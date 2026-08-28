import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_PROMPT_HEADROOM_TOKENS,
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

test('TurnBudget splits context into the shared response reserve and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, RESPONSE_RESERVE_TOKENS);
  assert.equal(budget.compactionReserveTokens, 11_000);
  assert.equal(budget.usablePromptTokens, 114_000);
});

test('TurnBudget clamps the reserve to half of a small context', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 4_000);
  // 4000 prompt tokens before the compaction reserve, which may never take more than half.
  assert.equal(budget.compactionReserveTokens, 2_000);
  assert.equal(budget.usablePromptTokens, 2_000);
});

test('TurnBudget bounds the reserve by the active preset MaxTokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: configWithMaxTokens(8_000) });
  assert.equal(budget.responseReserveTokens, 8_000);
  assert.equal(budget.compactionReserveTokens, 8_666);
  assert.equal(budget.usablePromptTokens, 123_334);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1, maxTurns: 45, config: null });
  assert.equal(budget.compactionReserveTokens, 0);
  assert.equal(budget.usablePromptTokens, 0);
});

test('the compaction reserve is one third of the run response reserve plus prompt headroom', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: null });
  assert.equal(
    budget.compactionReserveTokens,
    Math.floor(budget.responseReserveTokens / 3) + COMPACTION_PROMPT_HEADROOM_TOKENS,
  );
  assert.ok(COMPACTION_PROMPT_HEADROOM_TOKENS > 0);
});

test('the compaction reserve leaves room for a whole summarization request', () => {
  const budget = new TurnBudget({ totalContextTokens: 150_000, maxTurns: 45, config: null });
  const worstCaseTranscriptTokens = budget.usablePromptTokens + budget.responseReserveTokens;
  assert.equal(worstCaseTranscriptTokens, budget.totalContextTokens - budget.compactionReserveTokens);
});

test('a lone tool call early in a run gets the whole floor share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.usablePromptTokens, 74_000);
  assert.equal(budget.perToolCapTokens(0, 1), Math.floor(74_000 * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(0, 1), 5_550);
});

test('the turn share still grows with completed tool-call progress', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10, config: null });
  const early = budget.perToolCapTokens(0, 1);
  const late = budget.perToolCapTokens(4, 1);
  assert.equal(early, Math.floor(74_000 * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(late, Math.floor(74_000 * (4 / 10)));
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
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10, maxTurns: 0, config: null });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.usablePromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100, 1), 1);
});
