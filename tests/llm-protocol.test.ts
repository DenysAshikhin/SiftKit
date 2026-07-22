import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import type {
  LlamaCppChatMessage,
  LlamaCppChatRequest,
  LlamaCppToolDefinition,
  NormalizedLlamaCppChatResponse,
} from '../src/llm-protocol/types.js';
import { LLAMA_CPP_PROTOCOL_FORMAT } from '../src/llm-protocol/types.js';
import { buildReplayToolCall, LlamaCppToolCallParser } from '../src/llm-protocol/tool-call-parser.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import type { FullJsonResponse, RequestJsonOptions } from '../src/lib/http-client.js';
import type { JsonValue } from '../src/lib/json-types.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import type { SiftConfig } from '../src/config/types.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';

test('llm protocol types model text, reasoning, and tool-call responses', () => {
  assert.equal(LLAMA_CPP_PROTOCOL_FORMAT, 'openai-compatible');

  const message: LlamaCppChatMessage = {
    role: 'assistant',
    content: 'answer',
    reasoning_content: 'thinking',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'grep', arguments: '{"pattern":"x"}' },
    }],
  };
  const tool: LlamaCppToolDefinition = {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search repository text.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  };
  const request: LlamaCppChatRequest = {
    model: 'local',
    messages: [{ role: 'user', content: 'find x' }],
    tools: [tool],
    parallel_tool_calls: true,
    stream: true,
    chat_template_kwargs: {
      enable_thinking: true,
      reasoning_content: true,
    },
  };
  const response: NormalizedLlamaCppChatResponse = {
    text: 'answer',
    reasoningText: 'thinking',
    toolCalls: message.tool_calls || [],
    usage: {
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      outputTokens: 4,
      thinkingTokens: 1,
      promptCacheTokens: null,
      promptEvalTokens: 3,
    },
    raw: { choices: [{ message }] },
    stoppedEarly: false,
  };

  assert.equal(request.chat_template_kwargs?.reasoning_content, true);
  assert.equal(response.toolCalls[0]?.function.name, 'grep');
});

test('tool-call parser normalizes message, choice, and legacy function calls', () => {
  const parser = new LlamaCppToolCallParser(['grep', 'finish']);
  const calls = parser.parseFromChoice({
    message: {
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'grep', arguments: '{"pattern":"AgentLoop"}' },
      }],
      function_call: { name: 'finish', arguments: '{"answer":"done"}' },
    },
    tool_calls: [{
      id: 'call_2',
      type: 'function',
      function: { name: 'not_allowed', arguments: '{}' },
    }],
  });

  assert.deepEqual(calls.map((call) => call.function.name), ['grep', 'finish']);
  assert.equal(calls[0]?.function.arguments, '{"pattern":"AgentLoop"}');
});

test('replay tool-call helper emits real web tool protocol names and rejects unknown commands', () => {
  const searchCall = buildReplayToolCall({ id: 'call_search', command: 'web_search query="local llama"' });
  const fetchCall = buildReplayToolCall({ id: 'call_fetch', command: 'web_fetch url="https://example.test/page"' });
  const grepCall = buildReplayToolCall({ id: 'call_grep', command: 'grep pattern="name" path="package.json" limit=20' });
  const gitCall = buildReplayToolCall({ id: 'call_git', command: 'git status --short' });

  assert.equal(searchCall.function.name, 'web_search');
  assert.equal(searchCall.function.arguments, '{"query":"local llama"}');
  assert.equal(fetchCall.function.name, 'web_fetch');
  assert.equal(fetchCall.function.arguments, '{"url":"https://example.test/page"}');
  assert.equal(grepCall.function.name, 'grep');
  assert.equal(grepCall.function.arguments, '{"pattern":"name","path":"package.json","limit":20}');
  assert.equal(gitCall.function.name, 'git');
  assert.equal(gitCall.function.arguments, '{"command":"git status --short"}');
  assert.throws(
    () => buildReplayToolCall({ id: 'call_unknown', command: 'not-a-tool: x' }),
    /Cannot replay unknown persisted tool command/u,
  );
});

class CapturingHttpClient {
  readonly requests: RequestJsonOptions[] = [];
  private readonly responses: Array<FullJsonResponse<JsonValue> | Error>;

  constructor(responses: Array<FullJsonResponse<JsonValue> | Error> = []) {
    this.responses = responses;
  }

  async requestJsonFull<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<FullJsonResponse<T>> {
    this.requests.push(options);
    const response = this.responses.shift() || {
      statusCode: 200,
      rawText: JSON.stringify({
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      }),
      body: {
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      },
    };
    if (response instanceof Error) {
      throw response;
    }
    return { statusCode: response.statusCode, rawText: response.rawText, body: schema.parse(response.body) };
  }

  async *streamSse(): AsyncGenerator<SseFrame> {
    throw new Error('streamSse should not be called by non-streaming tests');
  }
}

class StringThrowingHttpClient extends CapturingHttpClient {
  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw 'string failure';
  }
}

class BlockingHttpClient extends CapturingHttpClient {
  calls = 0;
  activeCalls = 0;
  maxActiveCalls = 0;
  private holdFirst = true;

  releaseFirst(): void {
    this.holdFirst = false;
  }

  async requestJsonFull<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<FullJsonResponse<T>> {
    this.requests.push(options);
    this.calls += 1;
    const callNumber = this.calls;
    this.activeCalls += 1;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    while (callNumber === 1 && this.holdFirst) {
      await delay(1);
    }
    this.activeCalls -= 1;
    const body = { choices: [{ message: { content: `response ${callNumber}` } }] };
    return {
      statusCode: 200,
      rawText: JSON.stringify(body),
      body: schema.parse(body),
    };
  }
}

function jsonResponse(body: JsonValue, statusCode = 200, rawText = JSON.stringify(body)): FullJsonResponse<JsonValue> {
  return {
    statusCode,
    rawText,
    body,
  };
}

function buildProtocolConfig(preserveThinking = false): SiftConfig {
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
  preset.PreserveThinking = preserveThinking;
  config.Server.ModelPresets.ActivePresetId = 'p1';
  return config;
}

const protocolConfig = buildProtocolConfig();

test('llama client builds chat request with nested reasoning_content and tools', async () => {
  const http = new CapturingHttpClient();
  const client = new LlamaCppClient(http);
  await client.chat({
    config: protocolConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }],
    maxTokens: 64,
    stream: false,
    allowedToolNames: ['grep'],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.equal(http.requests[0]?.url, 'http://127.0.0.1:8097/v1/chat/completions');
  assert.deepEqual(body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
  });
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.tools[0].function.name, 'grep');
});

test('llama client covers token-count fallbacks, model fallbacks, and status errors', async () => {
  const countClient = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ token_count: 7 }),
    jsonResponse({ n_tokens: 8 }),
    jsonResponse({ tokens: ['a', 'b', 'c'] }),
    jsonResponse({}),
  ]));

  assert.equal((await countClient.countTokens(protocolConfig, 'a')).tokenCount, 7);
  assert.equal((await countClient.countTokens(protocolConfig, 'b')).tokenCount, 8);
  assert.equal((await countClient.countTokens(protocolConfig, 'c')).tokenCount, 3);
  assert.equal((await countClient.countTokens(protocolConfig, 'd')).tokenCount, 0);

  const modelClient = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ data: [{ id: '' }, { model: 'fallback-model' }] }),
    jsonResponse({ models: ['plain-model'] }),
    jsonResponse({ error: 'bad' }, 500, 'server exploded'),
  ]));

  assert.deepEqual(await modelClient.listModels(protocolConfig), ['fallback-model']);
  assert.deepEqual(await modelClient.listModels(protocolConfig), ['plain-model']);
  await assert.rejects(() => modelClient.listModels(protocolConfig), /HTTP 500: server exploded/u);

  const status = await new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ error: 'bad' }, 500, 'server exploded'),
  ])).getStatus(protocolConfig);
  assert.deepEqual(status, { ok: false, models: [], error: 'HTTP 500: server exploded' });
});

test('llama client accepts current object-valued model lists', async () => {
  const client = new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({
      models: [{
        name: 'Qwen3.6-27B-IQ4_NL_mtp.gguf',
        model: 'Qwen3.6-27B-IQ4_NL_mtp.gguf',
      }],
      data: [{ id: 'Qwen3.6-27B-IQ4_NL_mtp.gguf' }],
    }),
    jsonResponse({
      models: [{ name: 'fallback-name.gguf' }],
    }),
  ]));

  const current = await client.probeModelsAtBaseUrl('http://127.0.0.1:8097');
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.models, ['Qwen3.6-27B-IQ4_NL_mtp.gguf']);

  const fallback = await client.probeModelsAtBaseUrl('http://127.0.0.1:8097');
  assert.deepEqual(fallback.models, ['fallback-name.gguf']);
});

test('llama client covers non-streaming request and response normalization branches', async () => {
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        text: 'fallback text',
        message: {
          content: [{ type: 'text', text: '' }, { type: 'text', text: '' }],
          reasoning_content: [{ type: 'text', text: 'reason ' }, { type: 'text', text: 'trace' }],
          function_call: { name: 'finish', arguments: '{"output":"done"}' },
        },
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 13,
        total_tokens: 24,
        output_tokens_details: { thinking_tokens: 3 },
        input_tokens_details: { cached_tokens: 4 },
      },
    }),
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: protocolConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 33,
    temperature: 0.2,
    cachePrompt: false,
    slotId: 2,
    stream: false,
    responseFormat: { type: 'json_object' },
    reasoningOverride: 'off',
    retryMaxWaitMs: 0,
    allowedToolNames: ['finish'],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.equal(body.cache_prompt, false);
  assert.equal(body.id_slot, 2);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.custom_value, undefined);
  assert.equal(response.text, 'fallback text');
  assert.equal(response.reasoningText, 'reason trace');
  assert.equal(response.toolCalls[0]?.function.name, 'finish');
  assert.equal(response.usage.promptEvalTokens, 7);
  assert.equal(response.usage.thinkingTokens, 3);
});

test('tool-call parser extracts Qwen XML tool calls from plain text', () => {
  const parser = new LlamaCppToolCallParser(['find_text', 'read_lines']);
  const calls = parser.parseFromText(`
<tool_call>
<function=find_text>
<parameter=pattern>InferenceRequestBuilder</parameter>
<parameter=max_results>20</parameter>
</function>
</tool_call>
<tool_call>
<function=read_lines>
<parameter=path>src/providers/llama-cpp.ts</parameter>
</function>
</tool_call>`);

  assert.deepEqual(calls.map((call) => call.function.name), ['find_text', 'read_lines']);
  assert.deepEqual(JSON.parse(calls[0]?.function.arguments || '{}'), {
    pattern: 'InferenceRequestBuilder',
    max_results: 20,
  });
  assert.deepEqual(JSON.parse(calls[1]?.function.arguments || '{}'), {
    path: 'src/providers/llama-cpp.ts',
  });
});

test('EXL3 token counting uses the Tabby OpenAI token endpoint', async () => {
  const config = buildProtocolConfig();
  config.Server.ModelPresets.Presets[0].Backend = 'exl3';
  config.Server.ModelPresets.Presets[0].BaseUrl = 'http://127.0.0.1:8098';
  const http = new CapturingHttpClient([jsonResponse({ length: 50106, tokens: [1, 2] })]);

  const response = await new LlamaCppClient(http).countTokens(config, 'large prompt');

  assert.equal(response.tokenCount, 50106);
  assert.equal(http.requests[0]?.url, 'http://127.0.0.1:8098/v1/token/encode');
  assert.deepEqual(JSON.parse(String(http.requests[0]?.body)), { text: 'large prompt' });
});

test('EXL3 forwards native tools and response format while parsing Qwen XML tool calls', async () => {
  const config = buildProtocolConfig();
  config.Server.ModelPresets.Presets[0].Backend = 'exl3';
  config.Server.ModelPresets.Presets[0].BaseUrl = 'http://127.0.0.1:8098';
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        message: {
          content: '<tool_call><function=grep><parameter=pattern>SelectedBackend</parameter></function></tool_call>',
          reasoning_content: null,
          tool_calls: null,
        },
      }],
      usage: null,
    }),
  ]);
  const tool: LlamaCppToolDefinition = {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search repository text.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  };

  const response = await new LlamaCppClient(http).chat({
    config,
    model: '3.6_27B',
    messages: [{ role: 'user', content: 'find it' }],
    tools: [tool],
    maxTokens: 32,
    stream: false,
    responseFormat: { type: 'json_object' },
    allowedToolNames: ['grep'],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.deepEqual(body.tools, [tool]);
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(response.toolCalls[0]?.function.name, 'grep');
  assert.deepEqual(JSON.parse(response.toolCalls[0]?.function.arguments || '{}'), { pattern: 'SelectedBackend' });
});

test('EXL3 chat requests are serialized for a single Tabby cache slot', async () => {
  const config = buildProtocolConfig();
  config.Server.ModelPresets.Presets[0].Backend = 'exl3';
  config.Server.ModelPresets.Presets[0].BaseUrl = 'http://127.0.0.1:8098';
  const http = new BlockingHttpClient();
  const client = new LlamaCppClient(http);
  const options = {
    config,
    model: '3.6_27B',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    maxTokens: 4,
    stream: false,
    allowedToolNames: [],
  };

  const first = client.chat(options);
  while (http.calls === 0) await delay(1);
  const second = client.chat(options);
  await delay(20);
  const callsBeforeRelease = http.calls;
  http.releaseFirst();
  await Promise.all([first, second]);

  assert.equal(callsBeforeRelease, 1);
  assert.equal(http.maxActiveCalls, 1);
});

test('OpenAI response normalization accepts Tabby nullable optional fields', async () => {
  const config = buildProtocolConfig();
  config.Server.ModelPresets.Presets[0].Backend = 'exl3';
  config.Server.ModelPresets.Presets[0].BaseUrl = 'http://127.0.0.1:8098';
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        message: {
          content: 'EXL3 response',
          reasoning_content: null,
          tool_calls: null,
        },
      }],
      usage: null,
    }),
  ]);

  const response = await new LlamaCppClient(http).chat({
    config,
    baseUrl: 'http://127.0.0.1:8098',
    model: '3.6_27B',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 16,
    stream: false,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'EXL3 response');
  assert.equal(response.reasoningText, '');
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.usage.promptTokens, null);
});

test('tool-call parser covers fallback ids, default arguments, quoted replay values, and empty quotes', () => {
  const parser = new LlamaCppToolCallParser(['grep', 'finish']);

  assert.deepEqual(parser.parseFromChoice({}), []);
  assert.deepEqual(parser.parseToolCall({ type: 'function', function: { name: 'not_allowed', arguments: '{}' } }), null);
  assert.deepEqual(parser.parseToolCall({ type: 'function', function: { name: 'grep' } }), {
    id: 'call_grep',
    type: 'function',
    function: { name: 'grep', arguments: '{}' },
  });
  assert.equal(parser.parseToolCall(JSON.parse('{"type":"function","function":{"name":5,"arguments":"{}"}}')), null);
  assert.equal(parser.parseFromChoice({
    tool_calls: [{ id: 'top', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }],
  })[0]?.id, 'top');
  assert.equal(parser.parseFromChoice({
    message: { function_call: { name: 'finish' } },
  })[0]?.function.arguments, '{}');

  const quotedSearch = buildReplayToolCall({ id: 'quoted', command: 'web_search query="local llama"' });
  const escapedRead = buildReplayToolCall({ id: 'escaped', command: 'read path="src/a b.ts" offset=1 limit=40' });
  assert.equal(quotedSearch.function.arguments, '{"query":"local llama"}');
  assert.equal(escapedRead.function.arguments, '{"path":"src/a b.ts","offset":1,"limit":40}');
  // A native tool call with no parseable arguments is not replayable.
  assert.throws(
    () => buildReplayToolCall({ id: 'spaces', command: 'web_search query=   ' }),
    /Cannot replay unknown persisted tool command/u,
  );
  assert.throws(
    () => buildReplayToolCall({ id: 'bare', command: 'web_fetch' }),
    /Cannot replay unknown persisted tool command/u,
  );
  assert.throws(
    () => buildReplayToolCall({ id: 'unknown', command: 'Get-Content src/a.ts' }),
    /Cannot replay unknown persisted tool command/u,
  );
  assert.throws(
    () => buildReplayToolCall({ id: 'empty', command: '' }),
    /Cannot replay unknown persisted tool command/u,
  );
});

test('llama client covers non-streaming HTTP errors and status success branches', async () => {
  await assert.rejects(
    () => new LlamaCppClient(new CapturingHttpClient([
      jsonResponse({ error: 'bad' }, 500, 'bad tokenize'),
    ])).countTokens(protocolConfig, 'x', { retryMaxWaitMs: 0 }),
    /HTTP 500: bad tokenize/u,
  );

  await assert.rejects(
    () => new LlamaCppClient(new CapturingHttpClient([
      jsonResponse({ error: 'bad' }, 500, 'bad chat'),
    ])).chat({
      config: protocolConfig,
      model: 'local',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 16,
      stream: false,
      retryMaxWaitMs: 0,
      allowedToolNames: [],
    }),
    /HTTP 500: bad chat/u,
  );

  const okStatus = await new LlamaCppClient(new CapturingHttpClient([
    jsonResponse({ data: [{ id: 'local' }] }),
  ])).getStatus(protocolConfig);
  assert.deepEqual(okStatus, { ok: true, models: ['local'], error: null });

  const stringFailureStatus = await new LlamaCppClient(new StringThrowingHttpClient()).getStatus(protocolConfig);
  assert.deepEqual(stringFailureStatus, { ok: false, models: [], error: 'string failure' });
});

test('llama client covers timing cache, top-level thinking tokens, and top-level tool calls', async () => {
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        message: { content: 'answer', reasoning_content: 'think' },
        tool_calls: [{ id: 'top', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }],
      }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 5,
        total_tokens: 14,
        reasoning_tokens: 2,
      },
      timings: { cache_n: 3, prompt_n: 6 },
    }),
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: protocolConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 16,
    stream: false,
    retryMaxWaitMs: 0,
    allowedToolNames: ['grep'],
  });

  assert.equal(response.toolCalls[0]?.id, 'top');
  assert.equal(response.usage.promptCacheTokens, 3);
  assert.equal(response.usage.promptEvalTokens, 6);
  assert.equal(response.usage.thinkingTokens, 2);
  assert.equal(response.usage.totalTokens, 14);
});

test('llama client covers prompt-token cache fallback, empty response normalization, and disabled reasoning kwargs', async () => {
  const noReasoningConfig = buildProtocolConfig();
  noReasoningConfig.Runtime.LlamaCpp.Reasoning = null;
  noReasoningConfig.Server.ModelPresets.Presets[0].Reasoning = 'off';
  const http = new CapturingHttpClient([
    jsonResponse({
      choices: [{
        message: {
          content: [{ type: 'text' }, { type: 'text', text: 'answer' }],
          reasoning_content: [{ type: 'text' }, { type: 'text', text: 'trace' }],
        },
      }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
        thinking_tokens: 2,
      },
    }),
    jsonResponse({}),
  ]);
  const client = new LlamaCppClient(http);

  const response = await client.chat({
    config: noReasoningConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 16,
    stream: false,
    retryMaxWaitMs: 1,
    allowedToolNames: [],
  });
  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(response.text, 'answer');
  assert.equal(response.reasoningText, 'trace');
  assert.equal(response.usage.promptCacheTokens, 3);
  assert.equal(response.usage.promptEvalTokens, 5);
  assert.equal(response.usage.thinkingTokens, 2);

  const empty = await client.chat({
    config: protocolConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 16,
    stream: false,
    retryMaxWaitMs: 0,
    allowedToolNames: [],
  });
  assert.equal(empty.text, '');
  assert.equal(empty.reasoningText, '');
});
