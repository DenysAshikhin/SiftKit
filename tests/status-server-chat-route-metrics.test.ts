import test from 'node:test';
import assert from 'node:assert/strict';

import { getRepoSearchGenerationTokensPerSecond } from '../src/status-server/routes/chat.js';

test('getRepoSearchGenerationTokensPerSecond counts thinking tokens in repo-search generation throughput', () => {
  const scorecard = {
    totals: {
      outputTokens: 607,
      thinkingTokens: 576,
      generationDurationMs: 15837.164,
    },
  };

  const rate = getRepoSearchGenerationTokensPerSecond(scorecard as never);

  assert.equal(rate, (607 + 576) / (15837.164 / 1000));
});

test('getRepoSearchGenerationTokensPerSecond returns null when duration is missing', () => {
  const scorecard = {
    totals: {
      outputTokens: 607,
      thinkingTokens: 576,
      generationDurationMs: null,
    },
  };

  assert.equal(getRepoSearchGenerationTokensPerSecond(scorecard as never), null);
});
