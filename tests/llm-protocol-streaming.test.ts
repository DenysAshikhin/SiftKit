import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LlamaHttpError,
  type FullJsonResponse,
  type SseStreamOptions,
  type SseStreamPacket,
  type SseStreamSignal,
} from '../src/lib/http-client.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { SiftConfig } from '../src/config/types.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import { LlamaCppStreamingResponseAssembler } from '../src/llm-protocol/streaming-response-assembler.js';

class StreamingHttpClient {
  readonly requests: SseStreamOptions[] = [];
  private readonly packets: SseStreamPacket[];
  private readonly error: Error | null;

  constructor(packets: SseStreamPacket[], error: Error | null = null) {
    this.packets = packets;
    this.error = error;
  }

  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw new Error('requestJsonFull should not be called by streaming tests');
  }

  async streamSse(
    options: SseStreamOptions,
    onData: (packet: SseStreamPacket) => SseStreamSignal,
  ): Promise<{ sawDone: boolean }> {
    this.requests.push(options);
    if (this.error) {
      throw this.error;
    }
    for (const packet of this.packets) {
      if (onData(packet) === 'stop') {
        return { sawDone: false };
      }
    }
    return { sawDone: true };
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

test('streaming assembler accumulates content, reasoning, and tool-call deltas', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['grep']);

  assembler.ingestChoiceDelta({ delta: { reasoning_content: 'think ', content: 'ans' } });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep', arguments: '{"pattern":' } }],
    },
  });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
    },
  });

  const response = assembler.toResponse({
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    outputTokens: 2,
    thinkingTokens: 1,
    promptCacheTokens: null,
    promptEvalTokens: 1,
  });

  assert.equal(response.text, 'ans');
  assert.equal(response.reasoningText, 'think ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{"pattern":"x"}');
});

test('streaming assembler early-stops runaway structural repetition', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['finish'], { structuralRepeatLimit: 4 });

  for (const chunk of ['||||', '||||', '||||', '||||']) {
    assembler.ingestChoiceDelta({ delta: { content: chunk } });
  }

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /runaway/i);
});

test('llama streaming client assembles deltas, callbacks, timings, tool chunks, and early reasoning actions', async () => {
  const thinkingUpdates: string[] = [];
  const contentUpdates: string[] = [];
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
    stream: true,
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
  assert.deepEqual(contentUpdates, ['answer ']);
});

test('llama streaming client stops on completed planner action in reasoning', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { reasoning: 'prefix {"action":"finish","output":"done"} suffix' } }] },
    { choices: [{ delta: { content: 'must not be read' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
  });

  assert.equal(response.text, '{"action":"finish","output":"done"}');
  assert.equal(response.reasoningText, '');
  assert.equal(response.stoppedEarly, true);
  assert.equal(response.earlyStopReason, 'planner action completed in streamed reasoning');
});

test('llama streaming client converts transient llama HTTP stream errors', async () => {
  const http = new StreamingHttpClient([], new LlamaHttpError(503, 'loading model'));

  await assert.rejects(
    () => new LlamaCppClient(http).chat({
      config: streamingConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 64,
      stream: true,
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
    stream: true,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'prefix');
  assert.equal(response.reasoningText, 'deep ');
  assert.equal(response.toolCalls.length, 0);
  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /recent planner content tokens repeated/u);
});

test('llama streaming client covers empty streams without derived timings', async () => {
  const response = await new LlamaCppClient(new StreamingHttpClient([])).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
  });

  assert.equal(response.text, '');
  assert.equal(response.usage.promptEvalDurationMs, null);
  assert.equal(response.usage.generationDurationMs, null);
});

test('llama streaming client wraps non-error stream failures', async () => {
  class StringThrowingStreamingClient extends StreamingHttpClient {
    async streamSse(): Promise<{ sawDone: boolean }> {
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
      stream: true,
      allowedToolNames: [],
    }),
    /stream failed/u,
  );
});

test('streaming assembler ignores packets after early stop and covers empty delta branches', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['grep'], { structuralRepeatLimit: 2 });

  assembler.ingestChoiceDelta({});
  assembler.ingestChoiceDelta({ delta: { content: '}}' } });
  assembler.ingestChoiceDelta({ delta: { content: 'ignored' } });

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.text, '}}');
  assert.equal(response.stoppedEarly, true);
});

test('streaming assembler covers fallback tool index and filters disallowed calls', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['grep']);

  assembler.ingestChoiceDelta({ delta: { tool_calls: [{ function: { name: 'grep', arguments: '{"pattern":"x"}' } }] } });
  assembler.ingestChoiceDelta({ delta: { tool_calls: [{ function: { name: 'not_allowed', arguments: '{}' } }] } });

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.id, 'call_0');
});

test('streaming assembler covers thinking fallback, non-string deltas, and default tool arguments', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['grep']);

  assembler.ingestChoiceDelta({
    delta: {
      content: 5,
      thinking: 'think ',
      tool_calls: [{ id: 'tool', function: { name: 'grep' } }],
    },
  });

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.text, '');
  assert.equal(response.reasoningText, 'think ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{}');
});

test('streaming assembler covers non-runaway punctuation and word-tail branches', () => {
  const punctuation = new LlamaCppStreamingResponseAssembler(['grep'], { structuralRepeatLimit: 2 });
  punctuation.ingestChoiceDelta({ delta: { content: '}!' } });
  const punctuationResponse = punctuation.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });
  assert.equal(punctuationResponse.stoppedEarly, false);

  const wordTail = new LlamaCppStreamingResponseAssembler(['grep'], { structuralRepeatLimit: 2 });
  wordTail.ingestChoiceDelta({ delta: { content: 'aa' } });
  const wordTailResponse = wordTail.toResponse({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });
  assert.equal(wordTailResponse.stoppedEarly, false);
});
