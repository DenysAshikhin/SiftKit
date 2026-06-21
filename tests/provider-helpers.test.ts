import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCompletionUsageFromResponseBody,
  getPromptUsageFromResponseBody,
  getTimingUsageFromResponseBody,
  isTransientProviderError,
  retryProviderRequest,
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
  };

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
  };

  assert.deepEqual(getCompletionUsageFromResponseBody(body), {
    completionTokens: 8,
    thinkingTokens: 4,
  });
});

test('isTransientProviderError treats ECONNREFUSED as transient', () => {
  assert.equal(isTransientProviderError(new Error('connect ECONNREFUSED 127.0.0.1:8097')), true);
});

test('retryProviderRequest retries transient failures and returns on success', async () => {
  let attemptCount = 0;
  const retryEvents: Array<{ attempt: number; nextDelayMs: number }> = [];
  const sleepCalls: number[] = [];
  const result = await retryProviderRequest(async () => {
    attemptCount += 1;
    if (attemptCount < 3) {
      const error = new Error(`connect ECONNREFUSED 127.0.0.1:8097 attempt=${attemptCount}`) as Error & { code?: string };
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return 'ok';
  }, {
    maxWaitMs: 5000,
    onRetry(event) {
      retryEvents.push({ attempt: event.attempt, nextDelayMs: event.nextDelayMs });
    },
    sleepMs: async (delayMs: number) => {
      sleepCalls.push(delayMs);
    },
  });
  assert.equal(result, 'ok');
  assert.equal(attemptCount, 3);
  assert.deepEqual(retryEvents.map((item) => item.attempt), [1, 2]);
  assert.deepEqual(sleepCalls, [250, 500]);
});

test('retryProviderRequest stops after max wait budget and surfaces the original error', async () => {
  let nowMs = 0;
  const retryEvents: number[] = [];
  await assert.rejects(
    () => retryProviderRequest(async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:8097') as Error & { code?: string };
      error.code = 'ECONNREFUSED';
      throw error;
    }, {
      maxWaitMs: 200,
      onRetry(event) {
        retryEvents.push(event.attempt);
      },
      nowMs: () => nowMs,
      sleepMs: async (delayMs: number) => {
        nowMs += delayMs;
      },
    }),
    /ECONNREFUSED/u
  );
  assert.deepEqual(retryEvents, []);
});
