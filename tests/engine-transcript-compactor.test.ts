import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { z } from 'zod';

import {
  COMPACTION_SUMMARY_MARKER,
  TranscriptCompactor,
} from '../src/repo-search/engine/transcript-compactor.js';
import { TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS, TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import {
  resolveRepoSearchPlannerToolDefinitions,
  type ChatMessage,
} from '../src/repo-search/planner-protocol.js';
import { buildMockScorecard } from './_test-helpers.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { toProtocolTools } from '../src/providers/inference.js';

const PLANNER_TOOLS = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
const NEW_EPOCH = {
  kind: 'new_epoch',
  flags: { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false },
  tools: PLANNER_TOOLS,
} as const;

const SummaryRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  }).passthrough()),
  tools: z.array(z.object({
    type: z.string(),
    function: z.object({ name: z.string() }).passthrough(),
  }).passthrough()),
  tool_choice: z.string(),
  max_tokens: z.number().int().positive(),
}).passthrough();

function makeCompactor(mockResponses: MockPlannerResponseInput[] | undefined, totalContextTokens = 32_000): TranscriptCompactor {
  const config = mockOfflineSiftConfig();
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 45 });
  return new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens,
    compactionReserveTokens: budget.compactionReserveTokens,
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
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }]);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH });

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
    compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH }),
    /planner_compaction_failed/u,
  );
});

test('compact retries the summarizer once before failing', async () => {
  const compactor = makeCompactor([{ content: '' }, { content: 'RECOVERED SUMMARY' }]);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH });

  assert.equal(outcome.summaryText, 'RECOVERED SUMMARY');
  assert.equal(outcome.nextMockResponseIndex, 2);
});

test('chat compaction summarizes completed history and retains the entire in-flight turn', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'trigger question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'fresh tool result' },
  ];

  const outcome = await makeCompactor([{ content: 'SUMMARY' }]).compact({
    taskId: 'chat-1',
    turn: 2,
    messages,
    mockResponseIndex: 0,
    retention: { kind: 'current_chat_turn', startIndex: 3 },
    cacheOrigin: NEW_EPOCH,
  });

  assert.deepEqual(outcome.messages.slice(2), messages.slice(3));
  assert.equal(outcome.currentTurnStartIndex, 2);
});

test('chat compaction sends only completed history to the real summary request', async () => {
  const capturedRequests: Array<z.infer<typeof SummaryRequestSchema>> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      capturedRequests.push(SummaryRequestSchema.parse(parseJsonValueText(body)));
      sendChatCompletionSse(response, { choices: [{ message: { content: 'SUMMARY' } }] });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve());
  });
  const address = getAddressInfo(server);
  const config = mockOfflineSiftConfig();
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'trigger question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'fresh tool result' },
  ];
  try {
    const compactor = new TranscriptCompactor({
      config,
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'mock-model',
      timeoutMs: 5_000,
      totalContextTokens: 32_000,
      compactionReserveTokens: new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }).compactionReserveTokens,
      useEstimatedTokensOnly: true,
      mockResponses: undefined,
      tokenUsage: new TokenUsageTracker(config, true),
      logger: null,
      abortSignal: undefined,
    });

    await compactor.compact({
      taskId: 'chat-1',
      turn: 2,
      messages,
      mockResponseIndex: 0,
      retention: { kind: 'current_chat_turn', startIndex: 3 },
      cacheOrigin: NEW_EPOCH,
    });

    const captured = capturedRequests[0];
    assert.ok(captured);
    assert.deepEqual(captured.messages.slice(0, -1), [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ]);
    const instruction = captured.messages.at(-1);
    assert.ok(instruction);
    assert.equal(instruction.role, 'user');
    assert.match(instruction.content, /You are compacting a long working conversation/u);
    assert.equal(captured.messages.some((message) => message.content === 'trigger question'), false);
    assert.equal(captured.messages.some((message) => message.content === 'fresh tool result'), false);
    assert.deepEqual(captured.tools, PLANNER_TOOLS);
    assert.equal(captured.tool_choice, 'none');
    assert.equal(captured.max_tokens, 15_000);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('manual compaction retains no live message outside its summary', async () => {
  const outcome = await makeCompactor([{ content: 'SUMMARY' }]).compact({
    taskId: 'chat-1',
    turn: null,
    messages: transcript(),
    mockResponseIndex: 0,
    retention: { kind: 'none' },
    cacheOrigin: NEW_EPOCH,
  });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant']);
  assert.equal(outcome.currentTurnStartIndex, null);
});

test('an invalid chat turn boundary fails loudly', async () => {
  await assert.rejects(
    makeCompactor([{ content: 'SUMMARY' }]).compact({
      taskId: 'chat-1',
      turn: 1,
      messages: transcript(),
      mockResponseIndex: 0,
      retention: { kind: 'current_chat_turn', startIndex: 99 },
      cacheOrigin: NEW_EPOCH,
    }),
    /invalid compaction retention boundary/u,
  );
});

test('the summary budget excludes the retained triggering turn', async () => {
  const trigger = { role: 'user' as const, content: 'Q'.repeat(40_000) };
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'assistant', content: 'small completed history' },
    trigger,
  ];

  const outcome = await makeCompactor([{ content: 'SUMMARY' }], 5_000).compact({
    taskId: 'chat-1',
    turn: 1,
    messages,
    mockResponseIndex: 0,
    retention: { kind: 'current_chat_turn', startIndex: 2 },
    cacheOrigin: NEW_EPOCH,
  });

  assert.equal(outcome.summaryText, 'SUMMARY');
  assert.equal(outcome.messages.at(-1), trigger);
});

test('compact fails hard when the summarization prompt cannot fit single-shot', async () => {
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }], 5_000);
  const oversized: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'Q'.repeat(40_000) },
  ];

  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 1, messages: oversized, mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH }),
    /planner_compaction_prompt_overflow prompt_tokens=\d+/u,
  );
});

test('a completed-history image consumes the structured summary budget', async () => {
  const logged: Array<Record<string, JsonSerializable>> = [];
  const config = mockOfflineSiftConfig();
  const compactor = new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens: 2_500,
    compactionReserveTokens: new TurnBudget({ totalContextTokens: 2_500, maxTurns: 45 }).compactionReserveTokens,
    useEstimatedTokensOnly: true,
    mockResponses: [{ content: 'SUMMARY BODY' }],
    tokenUsage: new TokenUsageTracker(config, true),
    logger: { path: 'memory', write: (event) => { logged.push(event); } },
    abortSignal: undefined,
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'small completed history' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    { role: 'assistant', content: 'completed answer' },
  ];

  await assert.rejects(
    compactor.compact({
      taskId: 't1',
      turn: 1,
      messages,
      mockResponseIndex: 0,
      retention: { kind: 'none' },
      cacheOrigin: NEW_EPOCH,
    }),
    /planner_compaction_prompt_overflow prompt_tokens=\d+/u,
  );
  assert.equal(logged.some((event) => event.kind === 'turn_compaction_prompt_overflow_fail'), true);
  assert.equal(logged.some((event) => event.kind === 'turn_compaction_summary_retry'), false);
});

test('a caller with no turn is reported as such instead of borrowing turn zero', async () => {
  const logged: Array<Record<string, JsonSerializable>> = [];
  const config = mockOfflineSiftConfig();
  const compactor = new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens: 32_000,
    compactionReserveTokens: new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }).compactionReserveTokens,
    useEstimatedTokensOnly: true,
    mockResponses: [{ content: '' }, { content: 'RECOVERED SUMMARY' }],
    tokenUsage: new TokenUsageTracker(config, true),
    logger: { path: 'memory', write: (event) => { logged.push(event); } },
    abortSignal: undefined,
  });

  const outcome = await compactor.compact({
    taskId: 'session-x',
    turn: null,
    messages: transcript(),
    mockResponseIndex: 0,
    retention: { kind: 'none' },
    cacheOrigin: NEW_EPOCH,
  });

  assert.equal(outcome.summaryText, 'RECOVERED SUMMARY');
  const retry = logged.find((event) => event.kind === 'turn_compaction_summary_retry');
  assert.ok(retry);
  assert.equal(retry.turn, null);
  assert.equal(retry.taskId, 'session-x');
});

test('an overflow reported by a turnless caller names no turn', async () => {
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }], 5_000);
  const oversized: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'Q'.repeat(40_000) },
  ];

  await assert.rejects(
    compactor.compact({ taskId: 'session-x', turn: null, messages: oversized, mockResponseIndex: 0, retention: { kind: 'none' }, cacheOrigin: NEW_EPOCH }),
    /planner_compaction_prompt_overflow .*turn=none/u,
  );
});

test('latest_user retention fails loudly when the transcript has no user message', async () => {
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }]);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'assistant', content: 'assistant only' },
  ];

  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 2, messages, mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH }),
    /invalid compaction retention boundary/u,
  );
});

// The reserve clamps on small windows; the summary generation budget has to clamp with it,
// or compaction becomes impossible exactly where the window is tightest. A transcript at
// the shared prompt limit is the ordinary compaction trigger, so it must always fit.
for (const totalContextTokens of [150_000, 32_000, 9_000]) {
  test(`a transcript at the prompt limit of a ${totalContextTokens}-token window compacts inside the reserve`, async () => {
    const budget = new TurnBudget({ totalContextTokens, maxTurns: 45 });
    const compactor = makeCompactor([{ content: 'SUMMARY BODY' }], totalContextTokens);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      // 4 characters per token is the estimate mock mode counts with.
      { role: 'assistant', content: 'H'.repeat(budget.maxPromptTokens * 4) },
      { role: 'user', content: 'latest user intent' },
    ];

    const outcome = await compactor.compact({ taskId: 't1', turn: 9, messages, mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH });

    assert.equal(outcome.summaryText, 'SUMMARY BODY');
    assert.equal(outcome.summaryGenerationTokenBudget <= budget.compactionReserveTokens, true);
    assert.equal(
      outcome.summaryGenerationTokenBudget,
      outcome.summaryReasoningTokenBudget + outcome.summaryOutputTokenBudget,
    );
    assert.equal(outcome.summaryOutputTokenBudget >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS, true);
  });
}

// Between the prompt limit and the physical window the generation budget is whatever the
// window actually leaves: below the reserve ceiling, above the summary minimum.
test('a transcript near the physical window clamps the generation budget below the reserve', async () => {
  const totalContextTokens = 32_000;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 45 });
  const compactor = makeCompactor([{ content: 'SUMMARY BODY' }], totalContextTokens);
  // 4 characters per token: leaves roughly 2,000 tokens of the 32,000-token window.
  const transcriptTokens = totalContextTokens - 2_000;
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'assistant', content: 'H'.repeat(transcriptTokens * 4) },
    { role: 'user', content: 'latest user intent' },
  ];

  const outcome = await compactor.compact({ taskId: 't1', turn: 9, messages, mockResponseIndex: 0, retention: { kind: 'latest_user' }, cacheOrigin: NEW_EPOCH });

  assert.equal(outcome.summaryText, 'SUMMARY BODY');
  assert.equal(outcome.summaryGenerationTokenBudget < budget.compactionReserveTokens, true);
  assert.equal(outcome.summaryOutputTokenBudget >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS, true);
  assert.equal(
    outcome.summaryGenerationTokenBudget,
    outcome.summaryReasoningTokenBudget + outcome.summaryOutputTokenBudget,
  );
});

test('TaskResultSchema requires compactionSummary so a missed producer fails loudly', () => {
  const task = buildMockScorecard('done').tasks[0];
  assert.equal(TaskResultSchema.safeParse(task).success, true);

  const { compactionSummary, ...withoutCompactionSummary } = task;
  assert.equal(typeof compactionSummary, 'string');
  assert.equal(TaskResultSchema.safeParse(withoutCompactionSummary).success, false);
});
