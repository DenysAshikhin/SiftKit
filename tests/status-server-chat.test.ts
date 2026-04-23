import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatCompletionRequest } from '../src/status-server/chat.ts';
import { getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import type { ChatSession } from '../src/state/chat-sessions.ts';
import type { Dict } from '../src/lib/types.ts';

function createConfig(overrides: Partial<Dict> = {}): Dict {
  return {
    Runtime: {
      Model: 'managed.gguf',
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        NumCtx: 8192,
        Temperature: 0.7,
        TopP: 0.9,
        TopK: 40,
        MinP: 0.05,
        PresencePenalty: 0,
        RepetitionPenalty: 1.1,
        MaxTokens: 512,
        Reasoning: 'on',
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        Reasoning: 'on',
        ReasoningContent: true,
        PreserveThinking: true,
      },
    },
    ...overrides,
  } as Dict;
}

function createSession(): ChatSession {
  return {
    id: 'session-1',
    title: 'Session',
    model: 'managed.gguf',
    contextWindowTokens: 8192,
    thinkingEnabled: true,
    createdAtUtc: '2026-04-17T00:00:00.000Z',
    updatedAtUtc: '2026-04-17T00:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'final answer',
        thinkingContent: 'prior thinking',
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'answer without thinking',
        thinkingContent: '',
      },
    ],
  } as ChatSession;
}

test('buildChatCompletionRequest replays assistant reasoning_content only when enabled and present', () => {
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'next question');
  const messages = request.body.messages as Array<Record<string, unknown>>;
  const assistantMessages = messages.filter((message) => message.role === 'assistant');

  assert.deepEqual(request.body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    preserve_thinking: true,
  });
  assert.deepEqual(assistantMessages[0], {
    role: 'assistant',
    content: 'final answer',
    reasoning_content: 'prior thinking',
  });
  assert.deepEqual(assistantMessages[1], {
    role: 'assistant',
    content: 'answer without thinking',
  });
});

test('buildChatCompletionRequest omits thinking preservation flags when direct chat thinking is toggled off', () => {
  const session = createSession();
  session.thinkingEnabled = false;

  const request = buildChatCompletionRequest(createConfig(), session, 'next question', {
    thinkingEnabled: session.thinkingEnabled !== false,
  });

  assert.deepEqual(request.body.chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.equal(request.body.extra_body?.reasoning_budget, 0);
});

test('buildChatCompletionRequest uses dynamic max_tokens from remaining context', () => {
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'next question');
  const promptChars = ((request.body.messages as Array<Record<string, unknown>>) || [])
    .reduce((total, message) => total + String(message.content || '').length, 0);

  assert.equal(
    request.body.max_tokens,
    getDynamicMaxOutputTokens({
      totalContextTokens: 8192,
      promptTokenCount: Math.max(1, Math.ceil(promptChars / 4)),
    })
  );
});
