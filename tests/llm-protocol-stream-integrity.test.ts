import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpResponseError, type FullJsonResponse, type SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { InferenceClient } from '../src/llm-protocol/inference-client.js';
import {
  RawFrameHttpClient,
  RecordingLogger,
  buildStreamingTestConfig,
  contentFrame,
} from './helpers/streaming-client.js';

test('malformed stream frames are logged rather than silently skipped', async () => {
  const logger = new RecordingLogger();
  const client = new InferenceClient(new RawFrameHttpClient([
    contentFrame('hello'),
    'not-json-at-all',
    contentFrame(' world'),
    '[DONE]',
  ]));

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    logger,
  });

  assert.equal(response.text, 'hello world');
  const invalid = logger.events.filter((event) => event.kind === 'provider_stream_frame_invalid');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.rawFrame, 'not-json-at-all');
});

test('a stream that yields no frames throws rather than returning empty text', async () => {
  const logger = new RecordingLogger();
  const client = new InferenceClient(new RawFrameHttpClient([]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      logger,
    }),
    /stream produced no frames/u,
  );

  const degenerate = logger.events.filter((event) => event.kind === 'provider_stream_degenerate');
  assert.equal(degenerate.length, 1);
  assert.equal(degenerate[0]?.reason, 'no_frames');
});

test('a stream ending without [DONE] throws', async () => {
  const logger = new RecordingLogger();
  const client = new InferenceClient(new RawFrameHttpClient([contentFrame('partial')]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      logger,
    }),
    /ended without a \[DONE\] sentinel/u,
  );

  const degenerate = logger.events.filter((event) => event.kind === 'provider_stream_degenerate');
  assert.equal(degenerate[0]?.reason, 'missing_done_sentinel');
});

/** Fails the first N attempts with a transient 503, then streams normally. */
class FlakyStreamHttpClient {
  attempts = 0;
  constructor(private readonly failures: number) {}

  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw new Error('requestJsonFull must not be called for chat completions');
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw new HttpResponseError(503, 'LOADING MODEL');
    }
    yield { event: 'message', data: contentFrame('recovered') };
    yield { event: 'message', data: '[DONE]' };
  }
}

test('a transient failure before the first frame is retried', async () => {
  const http = new FlakyStreamHttpClient(1);
  const client = new InferenceClient(http);

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    retry: { maxWaitMs: 5_000 },
  });

  assert.equal(response.text, 'recovered');
  assert.equal(http.attempts, 2);
});

test('retry: false propagates a transient failure without a second attempt', async () => {
  const http = new FlakyStreamHttpClient(1);
  const client = new InferenceClient(http);

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      retry: false,
    }),
    /HTTP 503/u,
  );
  assert.equal(http.attempts, 1);
});
