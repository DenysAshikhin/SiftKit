import test from 'node:test';
import assert from 'node:assert/strict';

import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import {
  RawFrameHttpClient,
  RecordingLogger,
  buildStreamingTestConfig,
  contentFrame,
} from './helpers/streaming-client.js';

test('malformed stream frames are logged rather than silently skipped', async () => {
  const logger = new RecordingLogger();
  const client = new LlamaCppClient(new RawFrameHttpClient([
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
  const client = new LlamaCppClient(new RawFrameHttpClient([]));

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
  const client = new LlamaCppClient(new RawFrameHttpClient([contentFrame('partial')]));

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
