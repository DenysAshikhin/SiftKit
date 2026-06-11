import test from 'node:test';
import assert from 'node:assert/strict';

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
import type { SiftConfig } from '../src/config/types.js';

test('llm protocol types model text, reasoning, and tool-call responses', () => {
  assert.equal(LLAMA_CPP_PROTOCOL_FORMAT, 'openai-compatible');

  const message: LlamaCppChatMessage = {
    role: 'assistant',
    content: 'answer',
    reasoning_content: 'thinking',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'repo_rg', arguments: '{"pattern":"x"}' },
    }],
  };
  const tool: LlamaCppToolDefinition = {
    type: 'function',
    function: {
      name: 'repo_rg',
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
    text: message.content,
    reasoningText: message.reasoning_content || '',
    toolCalls: message.tool_calls || [],
    usage: {
      promptTokens: 3,
      completionTokens: 4,
      outputTokens: 4,
      thinkingTokens: 1,
      promptCacheTokens: null,
      promptEvalTokens: 3,
    },
    raw: { choices: [{ message }] },
    stoppedEarly: false,
  };

  assert.equal(request.chat_template_kwargs?.reasoning_content, true);
  assert.equal(response.toolCalls[0]?.function.name, 'repo_rg');
});

test('tool-call parser normalizes message, choice, and legacy function calls', () => {
  const parser = new LlamaCppToolCallParser(['repo_rg', 'finish']);
  const calls = parser.parseFromChoice({
    message: {
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'repo_rg', arguments: '{"pattern":"AgentLoop"}' },
      }],
      function_call: { name: 'finish', arguments: '{"answer":"done"}' },
    },
    tool_calls: [{
      id: 'call_2',
      type: 'function',
      function: { name: 'not_allowed', arguments: '{}' },
    }],
  });

  assert.deepEqual(calls.map((call) => call.function.name), ['repo_rg', 'finish']);
  assert.equal(calls[0]?.function.arguments, '{"pattern":"AgentLoop"}');
});

test('replay tool-call helper emits real web tool protocol names and rejects unknown commands', () => {
  const searchCall = buildReplayToolCall({ id: 'call_search', command: 'web_search: local llama' });
  const fetchCall = buildReplayToolCall({ id: 'call_fetch', command: 'web_fetch: https://example.test/page' });
  const rgCall = buildReplayToolCall({ id: 'call_rg', command: 'rg -n "name" package.json' });

  assert.equal(searchCall.function.name, 'web_search');
  assert.equal(searchCall.function.arguments, '{"query":"local llama"}');
  assert.equal(fetchCall.function.name, 'web_fetch');
  assert.equal(fetchCall.function.arguments, '{"url":"https://example.test/page"}');
  assert.equal(rgCall.function.name, 'repo_rg');
  assert.equal(rgCall.function.arguments, '{"command":"rg -n \\"name\\" package.json"}');
  assert.throws(
    () => buildReplayToolCall({ id: 'call_unknown', command: 'not-a-tool: x' }),
    /Cannot replay unknown persisted tool command/u,
  );
});

class CapturingHttpClient {
  readonly requests: RequestJsonOptions[] = [];

  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    this.requests.push(options);
    return {
      statusCode: 200,
      headers: {},
      rawText: JSON.stringify({
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      }),
      body: {
        choices: [{ message: { content: 'ok', reasoning_content: 'think' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
      } as T,
    };
  }
}

test('llama client builds chat request with nested reasoning_content and tools', async () => {
  const http = new CapturingHttpClient();
  const client = new LlamaCppClient(http);
  await client.chat({
    config: {
      Backend: 'llama.cpp',
      Runtime: {
        Model: 'local',
        LlamaCpp: {
          BaseUrl: 'http://127.0.0.1:8097',
        },
      },
      Server: {
        LlamaCpp: {
          ActivePresetId: 'p1',
          Presets: [{ id: 'p1', name: 'p1', Reasoning: 'on', ReasoningContent: true, PreserveThinking: false }],
        },
      },
    } as SiftConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      type: 'function',
      function: {
        name: 'repo_rg',
        description: 'Search.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }],
    maxTokens: 64,
    stream: false,
    allowedToolNames: ['repo_rg'],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.equal(http.requests[0]?.url, 'http://127.0.0.1:8097/v1/chat/completions');
  assert.deepEqual(body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
  });
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.tools[0].function.name, 'repo_rg');
});
