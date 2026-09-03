import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMetrics } from '../src/status-server/metrics.js';
import { getRepoSearchPromptBaselinePerToolAllowanceTokens } from '../src/line-read-guidance.js';
import { DEFAULT_MAX_TURNS, TurnBudget } from '../src/repo-search/engine/turn-budget.js';

test('normalizeMetrics backfills missing line-read fields to zero', () => {
  const metrics = normalizeMetrics({
    schemaVersion: 2,
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    thinkingTokensTotal: 0,
    toolTokensTotal: 0,
    promptCacheTokensTotal: 0,
    promptEvalTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
    taskTotals: {
      summary: {},
      plan: {},
      'repo-search': {},
      chat: {},
    },
    toolStats: {
      summary: {
        'get-content': {
          calls: 1,
          outputCharsTotal: 200,
          outputTokensTotal: 50,
          outputTokensEstimatedCount: 0,
        },
      },
      plan: {},
      'repo-search': {},
      chat: {},
    },
  });

  assert.equal(metrics.toolStats.summary['get-content'].lineReadCalls, 0);
  assert.equal(metrics.toolStats.summary['get-content'].lineReadLinesTotal, 0);
  assert.equal(metrics.toolStats.summary['get-content'].lineReadTokensTotal, 0);
  assert.equal(metrics.toolStats.summary['get-content'].semanticRepeatRejects, 0);
  assert.equal(metrics.toolStats.summary['get-content'].stagnationWarnings, 0);
  assert.equal(metrics.toolStats.summary['get-content'].promptInsertedTokens, 0);
  assert.equal(metrics.toolStats.summary['get-content'].rawToolResultTokens, 0);
});


test('the repo-search baseline allowance matches the engine single-call floor exactly', () => {
  const budget = new TurnBudget({ totalContextTokens: 32_000, maxTurns: DEFAULT_MAX_TURNS });
  assert.equal(getRepoSearchPromptBaselinePerToolAllowanceTokens(null), budget.perToolCapTokens(0, 1));
});
