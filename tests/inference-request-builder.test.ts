import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceRequestBuilder } from '../src/llm-protocol/inference-request-builder.js';

const messages = [{ role: 'user' as const, content: 'hello' }];
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get weather.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];
const defaults = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0,
  presencePenalty: 0,
  repetitionPenalty: 1,
  reasoning: 'off',
  reasoningEffort: 'xhigh',
  reasoningContent: false,
  preserveThinking: false,
  maintainPerStepThinking: false,
} as const;

test('streamed EXL3 request asks the server for usage in the final chunk', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    maxTokens: 128,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('EXL3 request never carries slot or prompt-cache fields and maps thinking policy', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools,
    defaults,
    maxTokens: 128,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' } },
    },
    thinking: { enabled: true, preserve: true, reasoningContent: true, effort: 'xhigh' as const },
  });

  assert.equal('cache_prompt' in request, false);
  assert.equal('id_slot' in request, false);
  assert.equal('timings_per_token' in request, false);
  assert.deepEqual(request.tools, tools);
  assert.equal(request.parallel_tool_calls, true);
  assert.deepEqual(request.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' } },
  });
  assert.deepEqual(request.chat_template_kwargs, {
    enable_thinking: true,
    preserve_thinking: true,
    reasoning_effort: 'xhigh',
  });
});

test('request builder emits every shared sampler for EXL3', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.1,
      repetitionPenalty: 1.05,
      reasoning: 'off',
      reasoningEffort: 'xhigh',
      reasoningContent: false,
      preserveThinking: false,
      maintainPerStepThinking: false,
    },
    maxTokens: 256,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal(request.max_tokens, 256);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.top_p, 0.9);
  assert.equal(request.top_k, 40);
  assert.equal(request.min_p, 0.05);
  assert.equal(request.presence_penalty, 0.1);
  assert.equal(request.repetition_penalty, 1.05);
  assert.equal(request.tools, undefined);
  assert.equal(request.response_format, undefined);
});

test('requests never send penalty_range — exllamav3 8e08af9 removed the unbounded-window cost', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: 'model',
    messages,
    tools: [],
    defaults,
    maxTokens: 128,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal('penalty_range' in request, false);
});

test('sampling always comes from preset defaults; maxTokens is the sole request override', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults: {
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repetitionPenalty: 1.25,
      reasoning: 'off',
      reasoningEffort: 'xhigh',
      reasoningContent: false,
      preserveThinking: false,
      maintainPerStepThinking: false,
    },
    maxTokens: 32,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal(request.max_tokens, 32);
  assert.equal(request.temperature, 0.7);
  assert.equal(request.top_p, 0.8);
  assert.equal(request.top_k, 20);
  assert.equal(request.min_p, 0);
  assert.equal(request.presence_penalty, 0);
  assert.equal(request.repetition_penalty, 1.25);
  assert.equal(request.repeat_penalty, undefined);
});

test('request builder omits thinking kwargs when no thinking override is supplied', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    maxTokens: 128,
    thinking: { enabled: undefined, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal(request.chat_template_kwargs, undefined);
});

test('request builder preserves the canonical planner schema', () => {
  const schema = {
    type: 'object',
    properties: {
      requiredText: { type: 'string' },
      optionalLimit: { type: 'integer' },
    },
    required: ['requiredText'],
  };
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    maxTokens: 128,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'planner', schema },
    },
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal(request.response_format?.type, 'json_schema');
  if (request.response_format?.type === 'json_schema') {
    assert.deepEqual(request.response_format.json_schema.schema, schema);
  }
});

test('request builder passes the structured-output schema through unchanged for EXL3', () => {
  // Tabby's LLGuidance grammar backend handles optional properties natively, so
  // the canonical schema must reach the server untouched (no forced required
  // list, no null-wrapped optionals).
  const direct = {
    type: 'object',
    properties: {
      mode: { const: 'inspect' },
      requiredText: { type: 'string' },
      optionalLimit: { type: 'integer' },
    },
    required: ['mode', 'requiredText'],
    additionalProperties: false,
  };
  const schema = {
    anyOf: [
      direct,
      {
        type: 'object',
        properties: {
          mode: { const: 'collect' },
          records: { type: 'array', minItems: 1, items: direct },
        },
        required: ['mode', 'records'],
        additionalProperties: false,
      },
    ],
  };
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    maxTokens: 128,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'planner', schema },
    },
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'xhigh' as const },
  });

  assert.equal(request.response_format?.type, 'json_schema');
  if (request.response_format?.type !== 'json_schema') {
    throw new Error('Expected EXL3 JSON Schema response format.');
  }
  assert.deepEqual(request.response_format.json_schema.schema, schema);
});

test('thinking requests carry the preset reasoning effort', () => {
  for (const effort of ['low', 'medium', 'xhigh'] as const) {
    const request = new InferenceRequestBuilder().build({
      backend: 'exl3',
      model: '3.8_27b_4.6bpw',
      messages,
      tools: [],
      defaults: { ...defaults, reasoningEffort: effort },
      maxTokens: 128,
      thinking: { enabled: true, preserve: false, reasoningContent: false, effort },
    });

    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true, reasoning_effort: effort });
  }
});

test('non-thinking requests omit reasoning effort because the template ignores it', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.8_27b_4.6bpw',
    messages,
    tools: [],
    defaults: { ...defaults, reasoningEffort: 'low' },
    maxTokens: 128,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'low' },
  });

  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
});
