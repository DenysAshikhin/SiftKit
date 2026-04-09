import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMetrics } from '../src/status-server/metrics.js';
import { buildPlannerSystemPrompt } from '../src/summary/planner/prompts.js';
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';

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

test('buildPlannerSystemPrompt reports learned read_lines guidance from idle-summary stats', () => {
  const prompt = buildPlannerSystemPrompt({
    sourceKind: 'text',
    rawReviewRequired: false,
    toolDefinitions: buildPlannerToolDefinitions(),
    lineReadGuidance: {
      toolName: 'read_lines',
      toolStats: {
        read_lines: {
          calls: 4,
          outputCharsTotal: 1200,
          outputTokensTotal: 400,
          outputTokensEstimatedCount: 0,
          lineReadCalls: 4,
          lineReadLinesTotal: 80,
          lineReadTokensTotal: 400,
        },
      },
      initialPerToolAllowanceTokens: 400,
    },
  });

  assert.match(prompt, /current per-tool allowance is 400 tokens/u);
  assert.match(prompt, /average line is 5\.00 tokens/u);
  assert.match(prompt, /prefer `read_lines` windows around 40 lines/u);
  assert.doesNotMatch(prompt, /Do not use tiny `read_lines` windows \(`<120` lines\)/u);
});
