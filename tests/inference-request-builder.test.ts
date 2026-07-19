import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceRequestBuilder } from '../src/llm-protocol/inference-request-builder.js';

const messages = [{ role: 'user' as const, content: 'hello' }];

test('llama request includes llama-only cache and slot controls', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    maxTokens: 128,
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
    tools: [],
    maxTokens: 128,
    stream: true,
    thinking: { enabled: true, preserve: true, reasoningContent: true },
    llama: { cachePrompt: true, slotId: 2 },
  });

  assert.equal(request.cache_prompt, undefined);
  assert.equal(request.id_slot, undefined);
  assert.equal(request.timings_per_token, undefined);
  assert.deepEqual(request.chat_template_kwargs, {
    enable_thinking: true,
    preserve_thinking: true,
  });
});
