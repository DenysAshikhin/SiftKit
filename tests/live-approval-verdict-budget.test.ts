import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { getActiveModelPreset, getConfiguredLlamaBaseUrl, loadConfig } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { ApprovalVerdictSchema } from '../src/repo-search/approval-verdict.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import { allocateLlamaCppSlotId, resolvePlannerThinkingFlags } from '../src/repo-search/engine/task-loop-support.js';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';

const ENABLED = process.env.SIFTKIT_TEST_LIVE_APPROVAL_VERDICT_BUDGET === '1';
const CONTEXT_LINE_COUNT = 1_200;
const CACHE_RETENTION_FRACTION = 0.9;
/** The client derives its stream deadline from maxTokens, so the priming turns need real headroom. */
const PLANNER_MAX_TOKENS = 4_096;
const LIVE_REQUEST_TIMEOUT_MS = 300_000;
const LIVE_TEST_TIMEOUT_MS = 600_000;

function requireConfiguredString(value: string | null | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

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
  const config = await loadConfig({ ensure: true });
  const preset = getActiveModelPreset(config);
  assert.equal(preset.Backend, 'exl3', `active preset ${preset.id} must be exl3`);
  const thinking = resolvePlannerThinkingFlags(config);
  assert.equal(thinking.thinkingEnabled, true, `active preset ${preset.id} must have Reasoning on`);
  const model = requireConfiguredString(preset.Model, `active preset ${preset.id} has no configured model`);
  const baseUrl = requireConfiguredString(getConfiguredLlamaBaseUrl(config), `active preset ${preset.id} has no configured base URL`);
  const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(INTERACTIVE_REPO_TOOL_NAMES, preset.VisionEnabled === true));
  const slotId = allocateLlamaCppSlotId(config);

  const transcript: ChatMessage[] = [
    { role: 'system', content: `Budget verdict run ${randomUUID()}. Keep this context; answer only what is asked.` },
    {
      role: 'user',
      content: Array.from({ length: CONTEXT_LINE_COUNT }, (_unused, index) => `Context line ${index}: parser cache approval schema tool replay deterministic evidence.`).join('\n'),
    },
    { role: 'user', content: 'Reply with the single word ok. Do not call tools.' },
  ];

  const plannerMessages = serializeProtocolMessages(transcript, thinking.reasoningContentEnabled);
  const executing = captureExecutingPlannerRequest(plannerMessages, thinking, tools, slotId);
  await requestRepoSearchPlannerProtocolAction({
    config, baseUrl, model, messages: plannerMessages, slotId,
    timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: PLANNER_MAX_TOKENS, ...thinking,
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
    slotId, timeoutMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: PLANNER_MAX_TOKENS, ...thinking,
    stage: 'planner_action', tools, toolChoice: 'none', responseSchema: null,
  });
  assert.ok(retention(next, 'next planner turn') >= CACHE_RETENTION_FRACTION, `next-turn retention ${retention(next, 'next planner turn')}`);
});
