import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonValueText } from '../src/lib/json.js';
import {
  ApprovalVerdictSchema,
  buildApprovalVerdictJsonSchema,
} from '../src/repo-search/approval-verdict.js';
import { isApprovalExemptReadOnlyTool } from '../src/repo-search/engine/approval-gate.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';
import {
  captureExecutingPlannerRequest,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  serializeProtocolMessages,
  type ChatMessage,
  type ExecutingPlannerRequest,
  type PlannerActionResponse,
  type PlannerThinkingFlags,
} from '../src/repo-search/planner-protocol.js';
import {
  buildLiveContextTranscript,
  LIVE_PLANNER_MAX_TOKENS,
  LIVE_REQUEST_TIMEOUT_MS,
  LIVE_TEST_TIMEOUT_MS,
  loadLivePlannerFixture,
} from './helpers/live-planner-fixture.js';

const LIVE_CACHE_CHAIN_ENABLED = process.env.SIFTKIT_TEST_LIVE_APPROVAL_CACHE_CHAIN === '1';
const MIN_LARGE_CONTEXT_TOKENS = 32_768;
const CACHE_RETENTION_FRACTION = 0.9;
const CONTEXT_LINE_COUNT = 2_600;
const LARGE_TOOL_CONTENT_BYTES = 2_048;
const LIVE_STEP_RESPONSE_SCHEMA = buildApprovalVerdictJsonSchema();

type CacheRecord = {
  label: string;
  cached: number | null;
  evaluated: number | null;
  promptEvalDurationMs: number | null;
  verdict?: 'approve';
};

function toCacheRecord(
  label: string,
  response: PlannerActionResponse,
  verdict?: 'approve',
): CacheRecord {
  return {
    label,
    cached: response.promptCacheTokens ?? null,
    evaluated: response.promptEvalTokens ?? null,
    promptEvalDurationMs: response.promptEvalDurationMs ?? null,
    ...(verdict === undefined ? {} : { verdict }),
  };
}

test('live provider retains the large prefix through two approvals and an exempt read', {
  timeout: LIVE_TEST_TIMEOUT_MS,
  skip: LIVE_CACHE_CHAIN_ENABLED
    ? false
    : 'set SIFTKIT_TEST_LIVE_APPROVAL_CACHE_CHAIN=1 and use an existing local status/model server',
}, async () => {
  const { config, model, baseUrl, tools, slotId } = await loadLivePlannerFixture();
  const thinking = {
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  } satisfies PlannerThinkingFlags;
  const transcript = buildLiveContextTranscript({
    runLabel: 'Cache-chain',
    lineCount: CONTEXT_LINE_COUNT,
    request: 'Return {"verdict":"approve","reason":"cache probe"}. Do not call tools.',
  });
  const records: CacheRecord[] = [];

  async function requestPlanner(label: string): Promise<ExecutingPlannerRequest> {
    const messages = serializeProtocolMessages(transcript, thinking.reasoningContentEnabled);
    const executing = captureExecutingPlannerRequest(messages, thinking, tools, slotId, 1_000);
    const response = await requestRepoSearchPlannerProtocolAction({
      config,
      baseUrl,
      model,
      messages,
      slotId,
      timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
      maxTokens: LIVE_PLANNER_MAX_TOKENS,
      ...thinking,
      stage: 'planner_action',
      tools,
      toolChoice: 'none',
      responseSchema: LIVE_STEP_RESPONSE_SCHEMA,
      responseSchemaName: 'siftkit_live_cache_step',
      logger: null,
    });
    records.push(toCacheRecord(label, response));
    return executing;
  }

  async function requestWriteApproval(
    label: string,
    executing: ExecutingPlannerRequest,
    path: string,
    content: string,
    callId: string,
  ): Promise<void> {
    const pending: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path, content }) },
      }],
    };
    const response = await requestApprovalVerdict({
      config,
      baseUrl,
      model,
      transcriptMessages: transcript,
      pendingMessages: [pending],
      question: buildApprovalVerdictQuestion({
        toolName: 'write',
        command: `write path="${path}" bytes=${content.length}`,
        reviewPayload: null,
      }),
      executing,
      timeoutMs: LIVE_REQUEST_TIMEOUT_MS,
      logger: null,
    });
    assert.equal(response.toolCalls.length, 0, `${label}: reviewer must not emit tool calls`);
    const verdict = ApprovalVerdictSchema.parse(parseJsonValueText(response.text));
    assert.equal(verdict.verdict, 'approve', `${label}: ${verdict.reason}`);
    records.push(toCacheRecord(label, response, 'approve'));
    transcript.push(pending, { role: 'tool', tool_call_id: callId, content: 'ok' });
  }

  const first = await requestPlanner('planner_large_context');
  await requestWriteApproval(
    'approval_2k_write',
    first,
    'src/cache-chain-a.txt',
    'x'.repeat(LARGE_TOOL_CONTENT_BYTES),
    'cache-chain-1',
  );

  const second = await requestPlanner('planner_after_approval_1');
  await requestWriteApproval(
    'approval_follow_up_write',
    second,
    'src/cache-chain-b.txt',
    'follow-up',
    'cache-chain-2',
  );

  await requestPlanner('planner_after_approval_2');
  assert.equal(isApprovalExemptReadOnlyTool('read'), true);
  transcript.push(
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'cache-chain-read',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"src/cache-chain-a.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'cache-chain-read', content: 'read result' },
  );
  await requestPlanner('planner_after_exempt_read');

  const seed = records[0];
  assert.ok(seed);
  assert.ok(
    seed.evaluated !== null && seed.evaluated > MIN_LARGE_CONTEXT_TOKENS,
    `seed must evaluate more than ${MIN_LARGE_CONTEXT_TOKENS} tokens: ${JSON.stringify(seed)}`,
  );
  for (const record of records.slice(1)) {
    assert.ok(
      record.cached !== null && record.cached >= seed.evaluated * CACHE_RETENTION_FRACTION,
      `${record.label} lost the large prompt prefix: ${JSON.stringify(record)}`,
    );
  }
});
