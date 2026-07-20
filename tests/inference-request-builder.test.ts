import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceRequestBuilder } from '../src/llm-protocol/inference-request-builder.js';

const messages = [{ role: 'user' as const, content: 'hello' }];
const tools = [{
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get weather.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];
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
    responseFormat: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
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
