import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_SUMMARY_MARKER,
  TranscriptCompactor,
} from '../src/repo-search/engine/transcript-compactor.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import type { ChatMessage } from '../src/repo-search/planner-protocol.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

function makeCompactor(mockResponses: string[] | undefined, totalContextTokens = 32_000): TranscriptCompactor {
  const config = mockOfflineSiftConfig();
  return new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens,
    thinking: { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false },
    useEstimatedTokensOnly: Array.isArray(mockResponses),
    mockResponses,
    tokenUsage: new TokenUsageTracker(config, true),
    logger: null,
    abortSignal: undefined,
  });
}

function transcript(): ChatMessage[] {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'original question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'git', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'src/a.ts:12: hit' },
    { role: 'user', content: 'latest user intent' },
  ];
}

test('compact rebuilds the transcript as system, summary, latest user message', async () => {
  const compactor = makeCompactor(['SUMMARY BODY']);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant', 'user']);
  assert.equal(outcome.messages[0].content, 'SYSTEM PROMPT');
  assert.equal(outcome.messages[1].content, `${COMPACTION_SUMMARY_MARKER}\nSUMMARY BODY`);
  assert.equal(outcome.messages[2].content, 'latest user intent');
  assert.equal(outcome.summaryText, 'SUMMARY BODY');
  assert.equal(outcome.droppedMessageCount, 3);
  assert.equal(outcome.summaryTokenCount > 0, true);
  assert.equal(outcome.nextMockResponseIndex, 1);
});

test('compact fails as planner_compaction_failed when the summarizer never answers', async () => {
  const compactor = makeCompactor([]);

  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 }),
    /planner_compaction_failed/u,
  );
});

test('compact retries the summarizer once before failing', async () => {
  const compactor = makeCompactor(['', 'RECOVERED SUMMARY']);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 });

  assert.equal(outcome.summaryText, 'RECOVERED SUMMARY');
  assert.equal(outcome.nextMockResponseIndex, 2);
});

test('compact fails hard when the summarization prompt cannot fit single-shot', async () => {
  const compactor = makeCompactor(['SUMMARY BODY'], 5_000);
  const oversized: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'Q'.repeat(40_000) },
  ];

  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 1, messages: oversized, mockResponseIndex: 0 }),
    /planner_compaction_prompt_overflow prompt_tokens=\d+/u,
  );
});

test('compact keeps a transcript with no user message to system plus summary', async () => {
  const compactor = makeCompactor(['SUMMARY BODY']);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'assistant', content: 'assistant only' },
  ];

  const outcome = await compactor.compact({ taskId: 't1', turn: 2, messages, mockResponseIndex: 0 });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant']);
  assert.equal(outcome.droppedMessageCount, 1);
});

// The reserve clamps on small windows; the summary output budget has to clamp with it,
// or compaction becomes impossible exactly where the window is tightest.
for (const totalContextTokens of [150_000, 32_000, 9_000]) {
  test(`the worst-case transcript at a ${totalContextTokens}-token window still compacts`, async () => {
    const budget = new TurnBudget({ totalContextTokens, maxTurns: 45, config: null });
    const worstCaseTranscriptTokens = budget.usablePromptTokens + budget.responseReserveTokens;
    const compactor = makeCompactor(['SUMMARY BODY'], totalContextTokens);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      // 2.5 characters per token is the local estimate the mock config uses.
      { role: 'assistant', content: 'H'.repeat(Math.floor(worstCaseTranscriptTokens * 2.5)) },
      { role: 'user', content: 'latest user intent' },
    ];

    const outcome = await compactor.compact({ taskId: 't1', turn: 9, messages, mockResponseIndex: 0 });

    assert.equal(outcome.summaryText, 'SUMMARY BODY');
  });
}

test('compact summarizes the transcript below the system prompt, not the system prompt itself', async () => {
  const logged: Array<Record<string, unknown>> = [];
  const config = mockOfflineSiftConfig();
  const compactor = new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens: 5_000,
    thinking: { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false },
    useEstimatedTokensOnly: true,
    mockResponses: ['SUMMARY BODY'],
    tokenUsage: new TokenUsageTracker(config, true),
    logger: { path: 'memory', write: (event) => { logged.push(event); } },
    abortSignal: undefined,
  });
  // A system prompt far larger than the whole window still compacts: it is never sent
  // to the summarizer, only the conversation below it is.
  const messages: ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(200_000) },
    { role: 'user', content: 'small question' },
  ];

  const outcome = await compactor.compact({ taskId: 't1', turn: 3, messages, mockResponseIndex: 0 });

  assert.equal(outcome.summaryText, 'SUMMARY BODY');
  assert.equal(logged.some((event) => event.kind === 'turn_compaction_prompt_overflow_fail'), false);
});
