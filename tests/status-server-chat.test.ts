import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatCompletionRequest, buildContextUsage, buildRepoSearchMarkdown } from '../src/status-server/chat.ts';
import { estimatePromptTokenCountFromCharacters, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import { estimateTokenCount, type ChatSession } from '../src/state/chat-sessions.ts';
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

test('buildRepoSearchMarkdown collapses exact repeated final output blocks for display', () => {
  const repeatedOutput = [
    '| Category | Concern |',
    '|---|---|',
    '| Bank | helper duplication |',
    '',
    'Note: exact evidence only.',
    '| Category | Concern |',
    '|---|---|',
    '| Bank | helper duplication |',
    '',
    'Note: exact evidence only.',
  ].join('\n');

  const markdown = buildRepoSearchMarkdown('audit duplicates', 'C:\\repo', {
    transcriptPath: 'transcript',
    artifactPath: 'artifact',
    scorecard: {
      tasks: [{ finalOutput: repeatedOutput }],
    },
  });

  assert.match(markdown, /\| Bank \| helper duplication \|/u);
  assert.equal(markdown.match(/\| Category \| Concern \|/gu)?.length, 1);
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
  assert.equal('extra_body' in request.body, false);
});

test('buildChatCompletionRequest uses dynamic max_tokens from remaining context', () => {
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'next question');
  const promptChars = ((request.body.messages as Array<Record<string, unknown>>) || [])
    .reduce((total, message) => total + String(message.content || '').length, 0);

  assert.equal(
    request.body.max_tokens,
    getDynamicMaxOutputTokens({
      totalContextTokens: 8192,
      promptTokenCount: estimatePromptTokenCountFromCharacters(createConfig(), promptChars),
    })
  );
});

test('buildContextUsage estimates continuation context from session content instead of provider prompt telemetry', () => {
  const session = {
    id: 'session-usage',
    contextWindowTokens: 75000,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'How are tool calls handled?',
        inputTokensEstimate: 52403,
        inputTokensEstimated: false,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '# Repo Search Results\n\nTool calls are parsed and executed through the loop.',
        outputTokensEstimate: 2288,
        outputTokensEstimated: true,
        thinkingTokens: 3405,
        thinkingTokensEstimated: true,
        thinkingContent: 'Prior reasoning that can be replayed.',
      },
    ],
    hiddenToolContexts: [
      {
        content: 'tool transcript content',
        tokenEstimate: 5708,
      },
    ],
  } as ChatSession;

  const expectedThinkingTokens = estimateTokenCount('Prior reasoning that can be replayed.');
  const expectedChatTokens = estimateTokenCount('general, coder friendly assistant')
    + estimateTokenCount('How are tool calls handled?')
    + estimateTokenCount('# Repo Search Results\n\nTool calls are parsed and executed through the loop.')
    + expectedThinkingTokens;
  const expectedToolTokens = estimateTokenCount(
    'Internal tool-call context from prior session steps. Use this as additional evidence only when relevant.',
  ) + 5708;
  const usage = buildContextUsage(session);

  assert.equal(usage.chatUsedTokens, expectedChatTokens);
  assert.equal(usage.usedTokens, expectedChatTokens);
  assert.equal(usage.thinkingUsedTokens, expectedThinkingTokens);
  assert.equal(usage.toolUsedTokens, expectedToolTokens);
  assert.equal(usage.totalUsedTokens, expectedChatTokens + expectedToolTokens);
  assert.equal(usage.estimatedTokenFallbackTokens, 0);
});
