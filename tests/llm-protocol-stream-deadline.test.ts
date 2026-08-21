import test from 'node:test';
import assert from 'node:assert/strict';

import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import {
  MIN_EXPECTED_TOKENS_PER_SECOND,
  assertDeadlineFitsBudget,
  computeRequiredGenerationMs,
} from '../src/llm-protocol/stream-deadline.js';
import { buildStreamingTestConfig, contentFrame } from './helpers/streaming-client.js';

test('required generation time is derived from the throughput floor', () => {
  assert.equal(MIN_EXPECTED_TOKENS_PER_SECOND, 20);
  assert.equal(computeRequiredGenerationMs(15_000), 750_000);
  assert.equal(computeRequiredGenerationMs(200), 10_000);
});

test('the historical 15k-tokens-in-120s combination is rejected', () => {
  assert.throws(
    () => { assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 120_000 }); },
    /cannot fit a 15000-token budget/u,
  );
});

test('a deadline that fits the budget is accepted', () => {
  assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 750_000 });
});

/** Emits frames forever, one per tick, so only a deadline can stop it. */
class EndlessStreamHttpClient {
  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    throw new Error(`requestJsonFull must not be called for chat completions (${options.url})`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    for (;;) {
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      yield { event: 'message', data: contentFrame('x') };
    }
  }
}

test('a stream exceeding its total deadline is aborted', async () => {
  const client = new LlamaCppClient(new EndlessStreamHttpClient());

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      // One token is the largest budget a 50 ms deadline can fit at the 20 tok/s floor;
      // anything larger is rejected up front instead of running to the deadline.
      maxTokens: 1,
      allowedToolNames: [],
      totalDeadlineMs: 50,
    }),
    /total deadline/u,
  );
});

test('a maxTokens budget larger than the deadline is rejected up front', async () => {
  const client = new LlamaCppClient(new EndlessStreamHttpClient());

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 15_000,
      allowedToolNames: [],
      totalDeadlineMs: 120_000,
    }),
    /cannot fit a 15000-token budget/u,
  );
});
