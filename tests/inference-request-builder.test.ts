import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceRequestBuilder } from '../src/llm-protocol/inference-request-builder.js';
import { isJsonObject, type JsonObject, type OptionalJsonValue } from '../src/lib/json-types.js';

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
  maxTokens: 128,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0,
  presencePenalty: 0,
  repetitionPenalty: 1,
  reasoning: 'off',
  reasoningContent: false,
  preserveThinking: false,
  maintainPerStepThinking: false,
} as const;

function requireObject(value: OptionalJsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected JSON object in inference request builder test.');
  }
  return value;
}

function getActionVariant(schema: JsonObject, action: string): JsonObject {
  if (!Array.isArray(schema.anyOf)) {
    throw new Error('Expected planner schema variants.');
  }
  for (const candidate of schema.anyOf) {
    const variant = requireObject(candidate);
    const actionSchema = requireObject(requireObject(variant.properties).action);
    if (actionSchema.const === action) {
      return variant;
    }
  }
  throw new Error(`Missing planner action variant: ${action}`);
}

test('llama request includes llama-only cache and slot controls', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: true,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true, slotId: 2 },
  });

  assert.equal(request.cache_prompt, true);
  assert.equal(request.id_slot, 2);
  assert.equal(request.timings_per_token, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('streamed EXL3 request asks the server for usage in the final chunk', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: true,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true },
  });

  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('non-streamed request omits stream_options', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true },
  });

  assert.equal(request.stream_options, undefined);
});

test('EXL3 request omits llama-only fields and maps thinking policy', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools,
    defaults,
    overrides: {},
    stream: true,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' } },
    },
    thinking: { enabled: true, preserve: true, reasoningContent: true },
    llama: { cachePrompt: true, slotId: 2 },
  });

  assert.equal(request.cache_prompt, undefined);
  assert.equal(request.id_slot, undefined);
  assert.equal(request.timings_per_token, undefined);
  assert.deepEqual(request.tools, tools);
  assert.equal(request.parallel_tool_calls, true);
  assert.deepEqual(request.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' } },
  });
  assert.deepEqual(request.chat_template_kwargs, {
    enable_thinking: true,
    preserve_thinking: true,
  });
});

test('request builder emits every shared sampler for EXL3', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults: {
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.1,
      repetitionPenalty: 1.05,
      reasoning: 'off',
      reasoningContent: false,
      preserveThinking: false,
      maintainPerStepThinking: false,
    },
    overrides: {},
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true },
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

test('explicit request samplers override active preset defaults', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    defaults: {
      maxTokens: 256,
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repetitionPenalty: 1,
      reasoning: 'off',
      reasoningContent: false,
      preserveThinking: false,
      maintainPerStepThinking: false,
    },
    overrides: { maxTokens: 32, temperature: 0.1, topP: 0.95 },
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true },
  });

  assert.equal(request.max_tokens, 32);
  assert.equal(request.temperature, 0.1);
  assert.equal(request.top_p, 0.95);
  assert.equal(request.repeat_penalty, 1);
  assert.equal(request.repetition_penalty, undefined);
});

test('request builder omits thinking kwargs when no thinking override is supplied', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: false,
    thinking: { enabled: undefined, preserve: false, reasoningContent: false },
    llama: { cachePrompt: false },
  });

  assert.equal(request.chat_template_kwargs, undefined);
});

test('llama request includes reasoning content when requested', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: false,
    thinking: { enabled: true, preserve: true, reasoningContent: true },
    llama: { cachePrompt: false },
  });

  assert.deepEqual(request.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    preserve_thinking: true,
  });
});

test('request builder preserves the canonical planner schema for llama', () => {
  const schema = {
    type: 'object',
    properties: {
      requiredText: { type: 'string' },
      optionalLimit: { type: 'integer' },
    },
    required: ['requiredText'],
  };
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    defaults,
    overrides: {},
    stream: false,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'planner', schema },
    },
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: true },
  });

  assert.equal(request.response_format?.type, 'json_schema');
  if (request.response_format?.type === 'json_schema') {
    assert.deepEqual(request.response_format.json_schema.schema, schema);
  }
});

test('request builder lowers only Formatron-incompatible planner constraints for EXL3', () => {
  const direct = {
    type: 'object',
    properties: {
      action: { const: 'inspect' },
      requiredText: { type: 'string' },
      optionalLimit: { type: 'integer' },
    },
    required: ['action', 'requiredText'],
    additionalProperties: false,
  };
  const schema = {
    anyOf: [
      direct,
      {
        type: 'object',
        properties: {
          action: { const: 'tool_batch' },
          calls: { type: 'array', minItems: 1, items: direct },
        },
        required: ['action', 'calls'],
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
    overrides: {},
    stream: false,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'planner', schema },
    },
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: false },
  });

  assert.equal(request.response_format?.type, 'json_schema');
  if (request.response_format?.type !== 'json_schema') {
    throw new Error('Expected EXL3 JSON Schema response format.');
  }
  const loweredSchema = requireObject(request.response_format.json_schema.schema);
  const loweredDirect = getActionVariant(loweredSchema, 'inspect');
  assert.deepEqual(loweredDirect.required, ['action', 'requiredText', 'optionalLimit']);
  assert.deepEqual(requireObject(requireObject(loweredDirect.properties).optionalLimit), {
    anyOf: [{ type: 'integer' }, { type: 'null' }],
  });
  const batch = getActionVariant(loweredSchema, 'tool_batch');
  const calls = requireObject(requireObject(batch.properties).calls);
  assert.equal(Object.hasOwn(calls, 'minItems'), false);
  assert.deepEqual(requireObject(calls.items), loweredDirect);
  assert.equal(requireObject(requireObject(direct.properties).optionalLimit).type, 'integer');
  assert.equal(requireObject(requireObject(requireObject(schema.anyOf[1]).properties).calls).minItems, 1);
});
