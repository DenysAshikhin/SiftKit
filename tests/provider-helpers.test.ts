import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCompletionUsageFromResponseBody,
  getPromptUsageFromResponseBody,
  getTimingUsageFromResponseBody,
} from '../src/lib/provider-helpers.js';

test('provider helpers extract llama timings and predicted token counts when usage is absent', () => {
  const body = {
    timings: {
      cache_n: 20,
      prompt_n: 10,
      prompt_ms: 50.5,
      prompt_per_second: 198.02,
      predicted_n: 8,
      predicted_ms: 64.25,
      predicted_per_second: 124.51,
    },
    __verbose: {
      tokens_predicted: 8,
    },
  } as Record<string, unknown>;

  assert.deepEqual(getPromptUsageFromResponseBody(body), {
    promptTokens: null,
    promptCacheTokens: 20,
    promptEvalTokens: 10,
  });
  assert.deepEqual(getCompletionUsageFromResponseBody(body), {
    completionTokens: 8,
    thinkingTokens: null,
  });
  assert.deepEqual(getTimingUsageFromResponseBody(body), {
    promptEvalDurationMs: 50.5,
    generationDurationMs: 64.25,
    promptTokensPerSecond: 198.02,
    generationTokensPerSecond: 124.51,
  });
});

test('provider helpers normalize completion tokens by subtracting thinking tokens', () => {
  const body = {
    usage: {
      completion_tokens: 12,
      completion_tokens_details: {
        reasoning_tokens: 4,
      },
    },
  } as Record<string, unknown>;

  assert.deepEqual(getCompletionUsageFromResponseBody(body), {
    completionTokens: 8,
    thinkingTokens: 4,
  });
});
