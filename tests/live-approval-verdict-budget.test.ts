import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonValueText } from '../src/lib/json.js';
import { ApprovalVerdictSchema } from '../src/repo-search/approval-verdict.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import { resolvePlannerThinkingFlags } from '../src/repo-search/engine/task-loop-support.js';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  serializeProtocolMessages,
  type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.js';
import {
  buildLiveContextTranscript,
  LIVE_PLANNER_MAX_TOKENS,
  LIVE_REQUEST_TIMEOUT_MS,
  LIVE_TEST_TIMEOUT_MS,
  loadLivePlannerFixture,
} from './helpers/live-planner-fixture.js';

const ENABLED = process.env.SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_BUDGET === '1';
const CONTEXT_LINE_COUNT = 1_200;
const CACHE_RETENTION_FRACTION = 0.9;

function retention(response: PlannerActionResponse, label: string): number {
  const cached = response.promptCacheTokens;
  const evaluated = response.promptEvalTokens;
  if (cached === null || cached === undefined || evaluated === null || evaluated === undefined) {
    throw new Error(`${label}: provider reported no prompt cache usage`);
  }
  return cached / (cached + evaluated);
}

test('a budgeted verdict keeps the planner prefix cached and the next planner turn too', {
  timeout: LIVE_TEST_TIMEOUT_MS,
  skip: ENABLED ? false : 'set SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_BUDGET=1 and use an existing local exl3 server',
}, async () => {
  const { config, preset, model, baseUrl, tools } = await loadLivePlannerFixture();
  assert.equal(preset.Backend, 'exl3', `active preset ${preset.id} must be exl3`);
  const thinking = resolvePlannerThinkingFlags(config);
  assert.equal(thinking.thinkingEnabled, true, `active preset ${preset.id} must have Reasoning on`);

  const transcript = buildLiveContextTranscript({
    runLabel: 'Budget verdict',
    lineCount: CONTEXT_LINE_COUNT,
    request: 'Reply with the single word ok. Do not call tools.',
  });

  const plannerMessages = serializeProtocolMessages(transcript, thinking.reasoningContentEnabled);
  const executing = captureExecutingPlannerRequest(plannerMessages, thinking, tools, 1_000);
  await requestRepoSearchPlannerProtocolAction({
    config, baseUrl, model, messages: plannerMessages,
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: LIVE_PLANNER_MAX_TOKENS, ...thinking,
    stage: 'planner_action', tools, toolChoice: 'none', responseSchema: null,
  });

  // A payload the reviewer must inspect closely: this is what makes a real verdict think.
  const verdict = await requestApprovalVerdict({
    config, baseUrl, model,
    transcriptMessages: transcript, pendingMessages: [],
    question: buildApprovalVerdictQuestion({
      toolName: 'write',
      command: 'write path="src/probe.ts"',
      reviewPayload: JSON.stringify({ toolName: 'write', args: { path: 'src/probe.ts', content: 'export const ok = true;' } }),
    }),
    executing, timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
  });
  assert.equal(verdict.toolCalls.length, 0);
  ApprovalVerdictSchema.parse(parseJsonValueText(verdict.text));
  assert.ok(retention(verdict, 'verdict') >= CACHE_RETENTION_FRACTION, `verdict retention ${retention(verdict, 'verdict')}`);

  const next = await requestRepoSearchPlannerProtocolAction({
    config, baseUrl, model,
    messages: serializeProtocolMessages([...transcript, { role: 'user', content: 'Reply with the single word ok again.' }], thinking.reasoningContentEnabled),
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: LIVE_PLANNER_MAX_TOKENS, ...thinking,
    stage: 'planner_action', tools, toolChoice: 'none', responseSchema: null,
  });
  assert.ok(retention(next, 'next planner turn') >= CACHE_RETENTION_FRACTION, `next-turn retention ${retention(next, 'next planner turn')}`);
});
