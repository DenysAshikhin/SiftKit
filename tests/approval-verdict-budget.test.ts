import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../src/repo-search/planner-protocol.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { asObject } from './helpers/dashboard-http.js';
import { buildReasoningDeltas, startFakeChatServer } from './helpers/fake-chat-server.js';

const VERDICT = '{"verdict":"deny","reason":"introduces a remote-execution dropper"}';
const VERDICT_BUDGET_MESSAGE = 'Thinking budget reached. Output the approval verdict JSON now.';
const transcript: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'task' },
];

// A believable exl3 preset: preset values are the sole source of samplers and template kwargs.
// A tiny ReasoningBudget on the preset must NOT win: the verdict overrides it to 1024.
function exl3Config(baseUrl: string): SiftConfig {
  const preset = mockModelPreset({
    id: 'budget-verdict-test',
    label: 'budget verdict test',
    Backend: 'exl3',
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
    ReasoningEffort: 'xhigh',
    ReasoningBudget: 8,
    BaseUrl: baseUrl,
  });
  return mockSiftConfig({
    Server: { ModelPresets: { Presets: [preset], ActivePresetId: 'budget-verdict-test' } },
  });
}

const THINKING_ON = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
} satisfies PlannerThinkingFlags;

function verdictOptions(baseUrl: string) {
  return {
    config: exl3Config(baseUrl),
    baseUrl,
    model: 'mock',
    transcriptMessages: transcript,
    pendingMessages: [],
    question: 'approve?',
    executing: captureExecutingPlannerRequest(
      serializeProtocolMessages(transcript, THINKING_ON.reasoningContentEnabled),
      THINKING_ON,
      toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
      2,
    ),
    timeoutMs: 30_000,
  };
}

test('a verdict whose reasoning exceeds the budget closes the think block and returns JSON', async () => {
  // 400 deltas x 8 chars = 3200 chars ~ 1280 tokens at 2.5 chars/token, past the 1024 budget.
  const fake = await startFakeChatServer({ content: VERDICT, reasoningDeltas: buildReasoningDeltas(400, 8) });
  try {
    const response = await requestApprovalVerdict(verdictOptions(fake.baseUrl));
    // Request 1 tripped the budget; request 2 is the continuation.
    assert.equal(fake.requestCount(), 2);
    // The continuation renders a response_prefix that closes the think block with the budget msg.
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.startsWith('<think>\n'));
    assert.ok(prefix.includes(VERDICT_BUDGET_MESSAGE));
    assert.ok(prefix.trimEnd().endsWith('</think>'));
    // The template kwargs are untouched on both requests: thinking stays on at render time.
    for (const index of [0, 1]) {
      assert.equal(asObject(fake.bodyAt(index).chat_template_kwargs).enable_thinking, true);
    }
    assert.equal(response.text, VERDICT);
    assert.equal(response.thinkingBudgetExhausted, true);
  } finally {
    await fake.close();
  }
});

test('a verdict whose reasoning fits the budget makes exactly one request', async () => {
  // 20 deltas x 8 chars = 160 chars ~ 64 tokens: over the preset's 8-token budget, under the verdict's 1024.
  const fake = await startFakeChatServer({ content: VERDICT, reasoningDeltas: buildReasoningDeltas(20, 8) });
  try {
    const response = await requestApprovalVerdict(verdictOptions(fake.baseUrl));
    assert.equal(fake.requestCount(), 1);
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    assert.equal(response.text, VERDICT);
    assert.equal(response.thinkingBudgetExhausted, undefined);
  } finally {
    await fake.close();
  }
});
