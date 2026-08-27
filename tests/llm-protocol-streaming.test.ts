import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpResponseError,
  type FullJsonResponse,
  type SseStreamOptions,
} from '../src/lib/http-client.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { SiftConfig } from '../src/config/types.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import type { LiveContentSnapshot } from '../src/llm-protocol/live-content-classifier.js';

class StreamingHttpClient {
  readonly requests: SseStreamOptions[] = [];
  private readonly packets: JsonObject[];
  private readonly error: Error | null;

  constructor(packets: JsonObject[], error: Error | null = null) {
    this.packets = packets;
    this.error = error;
  }

  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw new Error('requestJsonFull should not be called by streaming tests');
  }

  async *streamSse(options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.requests.push(options);
    if (this.error) {
      throw this.error;
    }
    for (const packet of this.packets) {
      yield { event: 'message', data: JSON.stringify(packet) };
    }
    yield { event: 'message', data: '[DONE]' };
  }
}

function buildStreamingConfig(): SiftConfig {
  const config = getDefaultConfigObject();
  config.Server.ModelPresets.Presets[0].Model = 'local';
  config.Runtime.LlamaCpp = {
    ...config.Runtime.LlamaCpp,
    BaseUrl: 'http://127.0.0.1:8097',
    Reasoning: 'on',
  };
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('default config must include a managed llama preset');
  }
  preset.id = 'p1';
  preset.label = 'p1';
  preset.Model = 'local';
  preset.BaseUrl = 'http://127.0.0.1:8097';
  preset.Reasoning = 'on';
  preset.ReasoningContent = true;
  preset.PreserveThinking = true;
  config.Server.ModelPresets.ActivePresetId = 'p1';
  return config;
}

const streamingConfig = buildStreamingConfig();

test('llama streaming client assembles reasoning, content, timings, and native tool chunks', async () => {
  const thinkingUpdates: string[] = [];
  const contentUpdates: LiveContentSnapshot[] = [];
  const http = new StreamingHttpClient([
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 1 },
        prompt_tokens_details: { cached_tokens: 3 },
      },
      timings: { prompt_n: 7, prompt_ms: 12, predicted_ms: 34 },
      choices: [{ delta: { reasoning_content: 'thinking ' } }],
    },
    { choices: [{ delta: { content: 'answer ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'grep', arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'grep', description: 'Search.', parameters: { type: 'object' } } }],
    maxTokens: 64,
    allowedToolNames: ['grep'],
    onThinkingDelta: (value) => thinkingUpdates.push(value),
    onContentDelta: (value) => contentUpdates.push(value),
  });

  const body = JSON.parse(http.requests[0]?.body || '{}');
  assert.equal(body.stream, true);
  assert.equal(body.timings_per_token, true);
  assert.equal(response.text, 'answer ');
  assert.equal(response.reasoningText, 'thinking ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{"pattern":"x"}');
  assert.equal(response.usage.promptTokens, 10);
  assert.equal(response.usage.promptEvalTokens, 7);
  assert.equal(response.usage.promptCacheTokens, 3);
  assert.equal(response.usage.thinkingTokens, 1);
  assert.deepEqual(thinkingUpdates, ['thinking ']);
  assert.deepEqual(contentUpdates, [{
    classification: 'narration',
    rawText: 'answer ',
    narrationText: 'answer ',
  }]);
});

test('streaming client requests include_usage and captures a final usage-only chunk', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { reasoning_content: 'thinking ' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 22232,
        completion_tokens: 40,
        total_tokens: 22272,
        prompt_tokens_details: { cached_tokens: 21421 },
      },
    },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  const body = JSON.parse(http.requests[0]?.body || '{}');
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(response.usage.promptTokens, 22232);
  assert.equal(response.usage.completionTokens, 40);
  assert.equal(response.usage.totalTokens, 22272);
  assert.equal(response.usage.promptCacheTokens, 21421);
  assert.equal(response.usage.promptEvalTokens, 811);
});

test('llama streaming client does not reinterpret JSON in reasoning as an action', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { reasoning: 'prefix {"action":"finish","output":"done"} suffix' } }] },
    { choices: [{ delta: { content: 'final answer' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'final answer');
  assert.equal(response.reasoningText, 'prefix {"action":"finish","output":"done"} suffix');
  assert.equal(response.stoppedEarly, false);
  assert.equal(response.earlyStopReason, undefined);
});

test('llama streaming client separates malformed raw control text from safe narration', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { content: 'Visible prefix <tool_call><function=>broken' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'Visible prefix ');
  assert.equal(response.narrationText, 'Visible prefix ');
  assert.equal(response.rawText, 'Visible prefix <tool_call><function=>broken');
  assert.equal(response.classification, 'tool_control');
  assert.deepEqual(response.toolCalls, []);
});

test('llama streaming client converts transient HTTP stream errors', async () => {
  const http = new StreamingHttpClient([], new HttpResponseError(503, 'loading model'));

  await assert.rejects(
    () => new LlamaCppClient(http).chat({
      config: streamingConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      // Conversion is under test, not the retry loop; without this the client
      // spends the full 30 s retry window replaying the always-503 fake.
      retry: false,
      allowedToolNames: [],
    }),
    /HTTP 503: loading model/u,
  );
});

test('llama streaming client covers empty packets, thinking fallback, malformed tool chunks, and repetition stop', async () => {
  const repeatedArgTags = `prefix ${'</arg_value>'.repeat(48)}`;
  const http = new StreamingHttpClient([
    {},
    { choices: [] },
    { choices: [{ delta: { thinking: 'deep ' } }] },
    {
      choices: [{
        delta: {
          content: repeatedArgTags,
          tool_calls: [
            null,
            {},
            { index: 2, id: 123, function: 'bad' },
            { index: 3, id: 'bad', function: { name: 'not_allowed', arguments: '{}' } },
          ],
        },
      }],
    },
    { choices: [{ delta: { content: 'must not be read' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'prefix');
  assert.equal(response.reasoningText, 'deep ');
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.function.name, 'not_allowed');
  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /recent planner content tokens repeated/u);
});

test('llama streaming client rejects an empty stream as degenerate', async () => {
  await assert.rejects(
    () => new LlamaCppClient(new StreamingHttpClient([])).chat({
      config: streamingConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
    }),
    /stream produced no frames/u,
  );
});

test('llama streaming client wraps non-error stream failures', async () => {
  class StringThrowingStreamingClient extends StreamingHttpClient {
    override async *streamSse(): AsyncGenerator<SseFrame> {
      throw 'stream failed';
    }
  }

  await assert.rejects(
    () => new LlamaCppClient(new StringThrowingStreamingClient([])).chat({
      config: streamingConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
    }),
    /stream failed/u,
  );
});

test('llama streaming client throttles runaway checks to the 256-char stride', async () => {
  const contentUpdates: LiveContentSnapshot[] = [];
  // Frame 1 is 15 chars; each brace frame adds 8. Per-frame checking would
  // stop at 111 chars (96 trailing braces, 13 callbacks). The throttled check
  // first runs at 263 chars: 31 normal callbacks, then the stop callback.
  const packets: JsonObject[] = [
    { choices: [{ delta: { content: '{"action":"x"} ' } }] },
    ...Array.from({ length: 60 }, (): JsonObject => ({ choices: [{ delta: { content: '}}}}}}}}' } }] })),
  ];
  const http = new StreamingHttpClient(packets);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    onContentDelta: (value) => contentUpdates.push(value),
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /runaway streamed planner content repeated/u);
  assert.equal(response.text, `{"action":"x"} ${'}'.repeat(96)}`);
  assert.equal(contentUpdates.length, 32);
});

test('llama streaming client detects a runaway completing after the last throttled check', async () => {
  const contentUpdates: LiveContentSnapshot[] = [];
  // 'prefix ' (7 chars) + 48 tag frames (12 chars each) = 583 chars total.
  // Throttled checks run at 259 chars (21 tags) and 523 chars (43 tags) —
  // both below the 48-tag trigger. The final 60 chars arrive unchecked, so
  // only the end-of-stream check can catch the completed 48-tag flood.
  const packets: JsonObject[] = [
    { choices: [{ delta: { content: 'prefix ' } }] },
    ...Array.from({ length: 48 }, (): JsonObject => ({ choices: [{ delta: { content: '</arg_value>' } }] })),
  ];
  const http = new StreamingHttpClient(packets);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    onContentDelta: (value) => contentUpdates.push(value),
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /recent planner content tokens repeated/u);
  assert.equal(response.text, 'prefix');
  // 49 normal per-frame callbacks plus one truncation callback from the
  // end-of-stream check. Per-frame checking stops inside the loop at frame
  // 49 and produces only 49 callbacks.
  assert.equal(contentUpdates.length, 50);
});
