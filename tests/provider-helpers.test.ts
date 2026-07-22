import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCompletionUsageFromResponseBody,
  getPromptUsageFromResponseBody,
  getSpeculativeUsageFromResponseBody,
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

test('provider helpers extract TabbyAPI usage: cache details, second-based timings, and draft stats', () => {
  const body = {
    usage: {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 900 },
      prompt_time: 0.06,
      prompt_tokens_per_sec: 1666.67,
      completion_tokens: 50,
      completion_time: 1.2,
      completion_tokens_per_sec: 41.7,
      total_tokens: 1050,
      total_time: 1.3,
      draft_accepted_tokens: 40,
      draft_rejected_tokens: 8,
    },
  };

  assert.deepEqual(getPromptUsageFromResponseBody(body), {
    promptTokens: 1000,
    promptCacheTokens: 900,
    promptEvalTokens: 100,
  });
  assert.deepEqual(getTimingUsageFromResponseBody(body), {
    promptEvalDurationMs: 60,
    generationDurationMs: 1200,
    promptTokensPerSecond: 1666.67,
    generationTokensPerSecond: 41.7,
  });
  assert.deepEqual(getSpeculativeUsageFromResponseBody(body), {
    speculativeAcceptedTokens: 40,
    speculativeGeneratedTokens: 48,
  });
});

test('provider helpers treat Indeterminate TabbyAPI rates and absent draft stats as null', () => {
  const body = {
    usage: {
      prompt_tokens: 10,
      prompt_time: 0,
      prompt_tokens_per_sec: 'Indeterminate',
      completion_tokens: 5,
      completion_time: 0.5,
      completion_tokens_per_sec: 10,
      total_tokens: 15,
    },
  };

  assert.deepEqual(getTimingUsageFromResponseBody(body), {
    promptEvalDurationMs: 0,
    generationDurationMs: 500,
    promptTokensPerSecond: null,
    generationTokensPerSecond: 10,
  });
  assert.deepEqual(getSpeculativeUsageFromResponseBody(body), {
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
  });
});

test('llama timings take precedence over TabbyAPI-shaped usage timing fields', () => {
  const body = {
    usage: { prompt_time: 9.9, completion_time: 9.9 },
    timings: { prompt_ms: 50.5, predicted_ms: 64.25, prompt_per_second: 198.02, predicted_per_second: 124.51 },
  };

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
      throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:8097 attempt=${attemptCount}`), { code: 'ECONNREFUSED' });
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
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8097'), { code: 'ECONNREFUSED' });
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
