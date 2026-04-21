import test from 'node:test';
import assert from 'node:assert/strict';

import { getRepoSearchOutputTokensPerSecond } from '../src/status-server/routes/chat.js';

test('getRepoSearchOutputTokensPerSecond counts thinking tokens in repo-search generation throughput', () => {
  const scorecard = {
    totals: {
      outputTokens: 607,
      thinkingTokens: 576,
      generationDurationMs: 15837.164,
    },
  };

  const rate = getRepoSearchOutputTokensPerSecond(scorecard as never);

  assert.equal(rate, (607 + 576) / (15837.164 / 1000));
});

test('getRepoSearchOutputTokensPerSecond returns null when duration is missing', () => {
  const scorecard = {
    totals: {
      outputTokens: 607,
      thinkingTokens: 576,
      generationDurationMs: null,
    },
  };

  assert.equal(getRepoSearchOutputTokensPerSecond(scorecard as never), null);
});
