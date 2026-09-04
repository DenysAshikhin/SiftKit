import test from 'node:test';
import assert from 'node:assert/strict';

import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { InferenceClient } from '../src/llm-protocol/inference-client.js';
import { buildStreamingTestConfig } from './helpers/streaming-client.js';

/** Rejects any blocking request aimed at chat completions. */
class ChatBlockingDetector {
  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    if (options.url.includes('/v1/chat/completions')) {
      throw new Error(
        `Blocking chat request detected at ${options.url}. Chat must stream: a blocking `
        + 'request bypasses runaway detection, the reasoning budget, and idle-timeout semantics.',
      );
    }
    throw new Error(`unexpected requestJsonFull to ${options.url}`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    yield { event: 'message', data: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) };
    yield { event: 'message', data: '[DONE]' };
  }
}

test('chat never issues a blocking request to /v1/chat/completions', async () => {
  const client = new InferenceClient(new ChatBlockingDetector());

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'ok');
});
