import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import {
  PLANNER_REASONING_BUDGET_MESSAGE,
  requestContextCompactionSummary,
  requestRepoSearchPlannerProtocolAction,
} from '../src/repo-search/planner-protocol.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import {
  buildReasoningDeltas,
  FAKE_PROMPT_USAGE,
  startFakeChatServer,
  type FakeChatServer,
  type FakeChatServerOptions,
} from './helpers/fake-chat-server.js';
import type { SiftConfig } from '../src/config/types.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

// Request 1 streams enough reasoning to blow a tiny ReasoningBudget (10 x 8 = 80
// chars exceed it under the 2.5 chars/token estimate), then the finish action;
// every later request answers with the action alone.
const FINISH_STREAM = {
  content: '{"action":"finish","output":"done"}',
  reasoningDeltas: buildReasoningDeltas(10, 8),
} satisfies FakeChatServerOptions;

function budgetedConfig(
  backend: 'exl3' | 'llama',
  opts: { baseUrl?: string; stockBudgetMessage?: boolean; reasoningBudget?: number } = {},
): SiftConfig {
  const preset = mockModelPreset({
    id: 'budget-test',
    label: 'budget test',
    Backend: backend,
    Reasoning: 'on',
    ReasoningBudget: opts.reasoningBudget ?? 8,
    // stockBudgetMessage keeps the normalized default so tests can exercise the
    // "user did not customize the message" branch.
    ...(opts.stockBudgetMessage ? {} : { ReasoningBudgetMessage: 'Answer now.' }),
    // exl3 resolves its base URL from the preset, so token-count probes must
    // target the fake server rather than a real runtime port.
    ...(opts.baseUrl ? { BaseUrl: opts.baseUrl } : {}),
  });
  return mockSiftConfig({
    Server: { ModelPresets: { Presets: [preset], ActivePresetId: 'budget-test' } },
  });
}

async function runStreamingPlanner(baseUrl: string, config: SiftConfig): Promise<Awaited<ReturnType<typeof requestRepoSearchPlannerProtocolAction>>> {
  return requestRepoSearchPlannerProtocolAction({
    config,
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 64,
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
    stage: 'planner_action',
    tools: [],
    responseSchema: null,
    onThinkingDelta: () => {},
  });
}

test('exl3 streaming enforces ReasoningBudget with a response_prefix continuation', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.startsWith('<think>\n'));
    assert.ok(prefix.includes('r00'));
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(prefix.trimEnd().endsWith('</think>'));

    assert.match(response.text, /"action"\s*:\s*"finish"/u);
    assert.ok(response.thinkingText.includes('r00'));
    assert.ok(response.thinkingText.includes('Answer now.'));
    assert.equal(response.thinkingBudgetExhausted, true);

    // Both requests' prefill work is billed.
    const { first, later } = FAKE_PROMPT_USAGE;
    assert.equal(response.promptCacheTokens, first.cachedTokens + later.cachedTokens);
    assert.equal(
      response.promptEvalTokens,
      (first.promptTokens - first.cachedTokens) + (later.promptTokens - later.cachedTokens),
    );
  } finally {
    await fake.close();
  }
});

test('exl3 budget enforcement applies when reasoning comes from the preset default', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    const response = await new LlamaCppClient().chat({
      config: budgetedConfig('exl3'),
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      retry: false,
    });
    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
  } finally {
    await fake.close();
  }
});

// Both compaction tests drive the same request; only the generation ceiling
// and the fake server reasoning stream vary.
function requestCompactionSummary(
  fake: FakeChatServer,
  config: SiftConfig,
  maxTokens: number,
): ReturnType<typeof requestContextCompactionSummary> {
  const flags = {
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
  };
  return requestContextCompactionSummary({
    config,
    baseUrl: fake.baseUrl,
    model: 'mock',
    messages: [{ role: 'user', content: 'large history' }],
    instruction: 'Summarize the history.',
    timeoutMs: 5_000,
    maxTokens,
    reasoningBudgetTokens: 8,
    continuationMinTokens: 4,
    cacheOrigin: { kind: 'new_epoch', flags, tools: [], slotId: 0 },
  });
}

test('a compaction continuation never drops below its summary output floor', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    const config = budgetedConfig('exl3', {
      baseUrl: fake.baseUrl,
      reasoningBudget: 100_000,
    });
    const response = await requestCompactionSummary(fake, config, 12);

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(0).max_tokens, 12);
    // The gate trips at an estimated spend of 10, leaving a remainder of 2, so
    // the floor of 4 governs.
    assert.equal(fake.bodyAt(1).max_tokens, 4);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.match(prefix, /Output the context compaction summary now\./u);
    assert.equal(response.thinkingBudgetExhausted, true);
    assert.match(response.thinkingText, /Output the context compaction summary now\./u);
    assert.match(response.text, /"action"\s*:\s*"finish"/u);
  } finally {
    await fake.close();
  }
});

test('measured headroom above the floor goes to the continuation', async () => {
  // 40-char deltas, reported counts climbing 1 per delta, budget 8: the gate
  // trips on delta 8 at a reported spend of 9, so 64 - 9 = 55 remains — far above
  // the floor of 4, and far above what the 360-character estimate would allow.
  const fake = await startFakeChatServer({
    ...FINISH_STREAM,
    reasoningDeltas: buildReasoningDeltas(12, 40),
    reportedReasoningTokens: 'cumulative',
  });
  try {
    const config = budgetedConfig('exl3', { baseUrl: fake.baseUrl, reasoningBudget: 100_000 });
    await requestCompactionSummary(fake, config, 64);

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(1).max_tokens, 55);
  } finally {
    await fake.close();
  }
});

test('a continuation with no floor gets the remainder, not a second full budget', async () => {
  // Regression guard: an unset floor used to re-grant the whole maxTokens.
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(0).max_tokens, 64);
    // Three 8-character deltas (24 chars) estimate at 10 tokens at the 2.5
    // chars/token default, tripping the budget of 8.
    assert.equal(fake.bodyAt(1).max_tokens, 54);
  } finally {
    await fake.close();
  }
});

test('planner reasoningBudgetMessage overrides the preset message in the continuation', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    const response = await requestRepoSearchPlannerProtocolAction({
      config: budgetedConfig('exl3'),
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
      maxTokens: 64,
      thinkingEnabled: true,
      reasoningContentEnabled: false,
      preserveThinking: false,
      stage: 'planner_action',
      tools: [],
      responseSchema: null,
      onThinkingDelta: () => {},
      reasoningBudgetMessage: 'Emit the next action.',
    });

    assert.equal(fake.requestCount(), 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Emit the next action.'));
    assert.ok(!prefix.includes('Answer now.'));
    assert.ok(response.thinkingText.includes('Emit the next action.'));
  } finally {
    await fake.close();
  }
});

async function runBudgetedTaskLoop(
  baseUrl: string,
  loopKind: 'repo-search' | 'chat',
  opts: { stockBudgetMessage?: boolean } = {},
): Promise<void> {
  await runTaskLoop(
    { id: loopKind, question: 'hi' },
    {
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
      repoRoot: os.tmpdir(),
      systemContext: createEmptyPresetSystemContext(),
      config: budgetedConfig('exl3', { baseUrl, stockBudgetMessage: opts.stockBudgetMessage }),
      runtimeProfile: new RepoSearchRuntimeProfile(loopKind),
      model: 'mock',
      baseUrl,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      ...(loopKind === 'chat' ? { plannerToolDefinitions: [] } : {}),
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter(),
    },
  );
}

test('repo-search loop continuations use the planner action budget message', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'repo-search', { stockBudgetMessage: true });

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
    assert.ok(!prefix.includes('You have to provide the answer now.'));
  } finally {
    await fake.close();
  }
});

test('repo-search loop keeps a user-customized preset budget message', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'repo-search');

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(!prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
  } finally {
    await fake.close();
  }
});

test('chat loop continuations keep the preset budget message', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'chat');

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(!prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
  } finally {
    await fake.close();
  }
});

test('planner loop on llama backend warns that the planner budget message cannot apply', async () => {
  const runWithLogger = async (loopKind: 'repo-search' | 'chat'): Promise<Record<string, JsonSerializable>[]> => {
    const events: Record<string, JsonSerializable>[] = [];
    await runTaskLoop(
      { id: loopKind, question: 'hi' },
      {
        plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
        repoRoot: os.tmpdir(),
        systemContext: createEmptyPresetSystemContext(),
        config: budgetedConfig('llama'),
        runtimeProfile: new RepoSearchRuntimeProfile(loopKind),
        model: 'mock',
        baseUrl: DEAD_BASE_URL,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        ...(loopKind === 'chat' ? { plannerToolDefinitions: [] } : {}),
        mockResponses: [{ content: "done" }],
        mockCommandResults: {},
        logger: { path: 'memory', write: (event) => { events.push(event); } },
      },
    );
    return events;
  };

  const plannerEvents = await runWithLogger('repo-search');
  assert.ok(plannerEvents.some((event) => event.kind === 'planner_budget_backend_gap'));

  const chatEvents = await runWithLogger('chat');
  assert.ok(!chatEvents.some((event) => event.kind === 'planner_budget_backend_gap'));
});

test('llama backend streaming never enforces the budget client-side', async () => {
  const fake = await startFakeChatServer(FINISH_STREAM);
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('llama'));

    assert.equal(fake.requestCount(), 1);
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    assert.match(response.text, /"action"\s*:\s*"finish"/u);
    assert.equal(response.thinkingBudgetExhausted, undefined);
  } finally {
    await fake.close();
  }
});

test('the gate fires on a positive reported thinking count, not the character estimate', async () => {
  // 40-char deltas estimate at 16 tokens each, so the estimate would blow a
  // budget of 8 on the first delta. Reported counts climb 1 per delta, so the
  // stop must instead land on delta 8 (reported 9 > 8).
  const fake = await startFakeChatServer({
    ...FINISH_STREAM,
    reasoningDeltas: buildReasoningDeltas(12, 40),
    reportedReasoningTokens: 'cumulative',
  });
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
    // Nine deltas survived the gate; the tenth never streamed.
    assert.ok(response.thinkingText.includes('r08'));
    assert.ok(!response.thinkingText.includes('r09'));
  } finally {
    await fake.close();
  }
});

test('reported zeros fall back to the character estimate and still trip the gate', async () => {
  const fake = await startFakeChatServer({
    ...FINISH_STREAM,
    reasoningDeltas: buildReasoningDeltas(12, 40),
    reportedReasoningTokens: 'zero',
  });
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
    // 40 chars estimates at 16 tokens, over the budget of 8, so one delta is enough.
    assert.ok(response.thinkingText.includes('r00'));
    assert.ok(!response.thinkingText.includes('r01'));
  } finally {
    await fake.close();
  }
});
