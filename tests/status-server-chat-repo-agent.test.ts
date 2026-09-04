import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ActiveChatRepoAgentResponseSchema,
  ChatRepoAgentApprovalModeResponseSchema,
  ChatSessionResponseSchema,
  ChatStreamApprovalSchema,
  ChatStreamTextDeltaSchema,
} from '@siftkit/contracts';

import { applyChatStreamTextDelta } from '@siftkit/contracts';
import type { JsonObject } from '../src/lib/json-types.js';
import { RepoAgentRunResultSchema } from '../src/repo-agent/run-schemas.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { getActiveModelPreset, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { asObject, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { requestSse as requestOperationSse } from './helpers/sse-http.js';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';

const ACTIVE_RUN_TIMEOUT_MS = 5_000;
const OPERATION_A = '4f9c1f9a-0000-4000-8000-000000000000';
const OPERATION_B = '4f9c1f9a-0000-4000-8000-000000000001';

class EngineGate {
  readonly promise: Promise<void>;
  private resolvePromise: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  release(): void {
    const resolve = this.resolvePromise;
    if (!resolve) {
      throw new Error('Engine gate is not initialized.');
    }
    resolve();
  }
}

class CapturingEngineService extends StatusEngineService {
  readonly requests: RepoSearchExecutionRequest[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.requests.push(request);
    return super.executeRepoSearch(request);
  }
}

class GatedEngineService extends StatusEngineService {
  constructor(private readonly gate: EngineGate) {
    super();
  }

  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    if (request.prompt === 'hold generation') {
      await this.gate.promise;
    }
    return await super.executeRepoSearch(request);
  }
}

async function createSession(harness: StreamedOperationHarness, title: string): Promise<string> {
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  assert.equal(response.statusCode, 200);
  const sessionId = asObject(response.body.session).id;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('Expected the chat session create response to contain an id.');
  }
  return sessionId;
}

async function waitForApproval(harness: StreamedOperationHarness, sessionId: string): Promise<JsonObject> {
  const deadline = Date.now() + ACTIVE_RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
    );
    if (response.statusCode === 200) {
      const active = ActiveChatRepoAgentResponseSchema.parse(response.body);
      if (active.status === 'approval_required') {
        return response.body;
      }
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for the chat repo-agent approval boundary.');
}

async function waitForRunStatus(
  harness: StreamedOperationHarness,
  sessionId: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + ACTIVE_RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
    );
    if (response.statusCode === 200
      && ActiveChatRepoAgentResponseSchema.parse(response.body).status === expectedStatus) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for chat repo-agent status ${expectedStatus}.`);
}

function readDoneResponse(response: SseResponse): ReturnType<typeof ChatSessionResponseSchema.parse> {
  const done = response.events.find((event) => event.event === 'done');
  assert.ok(done?.payload, 'Expected a done SSE event.');
  return ChatSessionResponseSchema.parse(done.payload);
}

function cipherThinkingMockResponses() {
  return [
    {
      thinking: 'inspecting the cipher',
      toolCalls: [{ name: 'write', arguments: { path: 'cipher-note.txt', content: 'cipher' } }],
    },
    // approval:'auto' consults the LLM reviewer before the write; without a verdict mock the
    // run parks at approval_required and the chat stream cannot end with a done payload.
    { content: '{"verdict":"approve","reason":"task-scoped write"}' },
    ...repoAgentFinishResponses('done'),
  ];
}

async function startApprovalRun(
  harness: StreamedOperationHarness,
  sessionId: string,
  filename: string,
): Promise<SseResponse> {
  return await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a file',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: filename, content: 'approved' } }] },
          ...repoAgentFinishResponses('wrote it'),
        ],
        mockCommandResults: {},
      }),
    },
  );
}

test('chat repo-agent decision endpoints reject sessions without active runs', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-empty-', t);
  const sessionId = await createSession(harness, 'No run');

  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 409);

  const active = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
  );
  assert.equal(active.statusCode, 404);

  const invalidMocks = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({ content: 'bad mocks', repoRoot: process.cwd(), mockResponses: 'invalid' }),
    },
  );
  assert.equal(invalidMocks.statusCode, 400);
});

test('chat repo-agent approval holds the lease, resumes the stream, and persists an audit row', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-approve-', t, { engineService });
  const sessionId = await createSession(harness, 'Approve run');
  const seeded = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'prior question', assistantContent: 'prior answer' }),
  });
  assert.equal(seeded.statusCode, 200);

  getRuntimeDatabase().exec(`
    CREATE TEMP TRIGGER require_repo_agent_approval_before_answer
    BEFORE INSERT ON chat_messages
    WHEN NEW.kind = 'assistant_answer'
      AND NEW.source_run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM chat_messages
        WHERE session_id = NEW.session_id
          AND kind = 'repo_agent_approval'
          AND source_run_id = NEW.source_run_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'repo-agent approval must precede its answer');
    END;
  `);

  const stream = startApprovalRun(harness, sessionId, 'approved.txt');
  const active = await waitForApproval(harness, sessionId);
  const parsedActive = ActiveChatRepoAgentResponseSchema.parse(active);
  assert.equal(parsedActive.status, 'approval_required');
  assert.equal(parsedActive.approval.command.includes('approved.txt'), true);
  assert.equal('state' in active, false);
  const runId = active.runId;
  assert.equal(typeof runId, 'string');

  const busy = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'must be rejected while agent runs', operationId: OPERATION_B }),
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.operationKind, 'repo-agent');

  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  assert.equal(decide.body.runId, runId);
  assert.match(String(decide.body.decidedAtUtc), /^\d{4}-\d{2}-\d{2}T/u);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  const approvalEvent = response.events.find((event) => event.event === 'approval');
  assert.ok(approvalEvent?.payload);
  assert.equal(ChatStreamApprovalSchema.parse(approvalEvent.payload).runId, runId);
  const completed = readDoneResponse(response);
  const messages = completed.session.messages;
  assert.deepEqual(messages.slice(-4).map((message) => message.kind), [
    'user_text',
    'assistant_tool_call',
    'repo_agent_approval',
    'assistant_answer',
  ]);
  const approval = messages.at(-2);
  assert.equal(approval?.kind, 'repo_agent_approval');
  if (approval?.kind === 'repo_agent_approval') {
    assert.equal(approval.approvalDecision, 'approve');
    assert.equal(approval.approvalReason, null);
  }
  assert.equal(messages.at(-1)?.sourceRunId, runId);
  const chatAgentRequest = engineService.requests.find((request) => request.taskKind === 'repo-agent');
  assert.ok(chatAgentRequest);
  assert.equal(chatAgentRequest.prompt, 'write a file');
  assert.deepEqual(chatAgentRequest.history, [
    { role: 'user', content: 'prior question' },
    { role: 'assistant', content: 'prior answer' },
  ]);
  assert.equal('systemPrompt' in chatAgentRequest, false);

  const inactive = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
  );
  assert.equal(inactive.statusCode, 404);

  await requestSse(`${harness.baseUrl}/repo-agent`, {
    method: 'POST',
    timeoutMs: 20_000,
    body: JSON.stringify({
      prompt: 'standalone run',
      repoRoot: process.cwd(),
      approval: 'off',
      model: 'mock-model',
      availableModels: ['mock-model'],
      mockResponses: repoAgentFinishResponses('standalone done'),
      mockCommandResults: {},
    }),
  });
  const standaloneRequest = engineService.requests.find((request) => request.prompt === 'standalone run');
  assert.ok(standaloneRequest);
  assert.equal('history' in standaloneRequest, false);
});

test('a repo-agent follow-up receives the preceding repo-agent turn as replayable history', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-follow-up-', t, { engineService });
  const sessionId = await createSession(harness, 'Follow-up context');
  const endpoint = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`;
  const configPath = getRuntimeDatabasePath();
  const config = readConfig(configPath);
  const originalModelPreset = getActiveModelPreset(config);
  const replacementModelPreset = {
    ...originalModelPreset,
    id: 'replacement-model-preset',
    label: 'Replacement model preset',
    NumCtx: originalModelPreset.NumCtx + 1_024,
  };
  config.Server.ModelPresets = {
    Presets: [...config.Server.ModelPresets.Presets, replacementModelPreset],
    ActivePresetId: replacementModelPreset.id,
  };
  writeConfig(configPath, config);

  const firstStream = startApprovalRun(harness, sessionId, 'history-tool.txt');
  await waitForApproval(harness, sessionId);
  const decision = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decision.statusCode, 200);
  const first = await firstStream;
  assert.equal(first.statusCode, 200);
  const firstDone = readDoneResponse(first);
  assert.equal(firstDone.session.modelPresetId, originalModelPreset.id);

  const second = await requestSse(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      content: 'follow up using that result',
      repoRoot: process.cwd(),
      approval: 'off',
      operationId: OPERATION_B,
      maxTurns: 2,
      mockResponses: repoAgentFinishResponses('second repo-agent result'),
      mockCommandResults: {},
    }),
  });
  assert.equal(second.statusCode, 200);

  const followUp = engineService.requests.find((request) => request.prompt === 'follow up using that result');
  assert.ok(followUp);
  assert.equal(followUp.presetId, 'repo-agent');
  assert.deepEqual(followUp.history?.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'user',
    'assistant',
  ]);
  const approvalHistory = followUp.history?.[3];
  assert.equal(typeof approvalHistory?.content, 'string');
  if (typeof approvalHistory?.content === 'string') {
    assert.match(approvalHistory.content, /^\[repo-agent approval\] approve write:/u);
  }
  assert.equal(followUp.modelPresetId, firstDone.session.modelPresetId);
  assert.deepEqual(followUp.modelPreset, originalModelPreset);
  assert.ok(followUp.config);
  const requestModelPreset = getActiveModelPreset(followUp.config);
  const { id: requestPresetId, ...requestModelFields } = requestModelPreset;
  const { id: sessionPresetId, ...sessionModelFields } = originalModelPreset;
  assert.equal(requestPresetId, replacementModelPreset.id);
  assert.equal(sessionPresetId, firstDone.session.modelPresetId);
  assert.deepEqual(requestModelFields, sessionModelFields);
});

test('chat repo-agent decide rejects a run that is generating instead of parked', async (t) => {
  const engineGate = new EngineGate();
  const harness = await startHarness('siftkit-chat-repo-agent-running-', t, {
    engineService: new GatedEngineService(engineGate),
  });
  const sessionId = await createSession(harness, 'Running run');
  t.after(() => {
    engineGate.release();
  });

  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'hold generation',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('released'),
        mockCommandResults: {},
      }),
    },
  );
  await waitForRunStatus(harness, sessionId, 'running');
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 409);
  engineGate.release();
  readDoneResponse(await stream);
});

test('chat repo-agent persists deny reasons and abort outcomes', async (t) => {
  for (const scenario of [
    { decision: 'deny', reason: 'wrong file', expected: 'wrote it' },
    { decision: 'abort', reason: null, expected: 'Repo-agent run stopped by user.' },
  ] as const) {
    const harness = await startHarness(`siftkit-chat-repo-agent-${scenario.decision}-`, t);
    const sessionId = await createSession(harness, `${scenario.decision} run`);
    const stream = startApprovalRun(harness, sessionId, `${scenario.decision}.txt`);
    await waitForApproval(harness, sessionId);
    const payload = scenario.decision === 'deny'
      ? { decision: scenario.decision, reason: scenario.reason }
      : { decision: scenario.decision };
    const decide = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    assert.equal(decide.statusCode, 200);
    const completed = readDoneResponse(await stream);
    const messages = completed.session.messages;
    const approval = messages.at(-2);
    assert.equal(approval?.kind, 'repo_agent_approval');
    if (approval?.kind === 'repo_agent_approval') {
      assert.equal(approval.approvalDecision, scenario.decision);
      assert.equal(approval.approvalReason, scenario.reason);
    }
    assert.equal(messages.at(-1)?.content, scenario.expected);
    await harness.close();
  }
});

test('chat repo-agent streams thinking deltas', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-thinking-', t);
  const sessionId = await createSession(harness, 'Thinking run');
  const response = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'inspect the cipher',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: cipherThinkingMockResponses(),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 200);
  const thinkingFrames = response.events.filter((event) => event.event === 'thinking');
  assert.ok(
    thinkingFrames.length >= 1,
    `expected at least one thinking frame, got events: ${JSON.stringify(response.events.map((event) => event.event))}`,
  );
  let assembled = '';
  for (const frame of thinkingFrames) {
    assert.ok(frame.payload, 'thinking frames must carry a payload');
    assembled = applyChatStreamTextDelta(assembled, ChatStreamTextDeltaSchema.parse(frame.payload));
  }
  assert.ok(
    assembled.includes('inspecting the cipher'),
    `reassembled thinking text must contain the mock thinking, got: ${assembled}`,
  );
  assert.ok(
    response.events.some((event) => event.event === 'tool_start'),
    `tool_start frames must still arrive, got events: ${JSON.stringify(response.events.map((event) => event.event))}`,
  );
  readDoneResponse(response);
});

test('chat repo-agent persists its thinking trace', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-persist-trace-', t);
  const sessionId = await createSession(harness, 'Persisted trace run');
  const response = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'inspect the cipher',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: cipherThinkingMockResponses(),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 200);
  const completed = readDoneResponse(response);
  const messages = completed.session.messages;
  const answerIndex = messages.findIndex((message) => message.kind === 'assistant_answer');
  assert.ok(answerIndex >= 0, 'expected an assistant_answer row in the persisted transcript');
  const beforeAnswer = messages.slice(0, answerIndex);
  const thinkingRows = beforeAnswer.filter((message) => message.kind === 'assistant_thinking');
  assert.ok(
    thinkingRows.some((message) => message.content.includes('inspecting the cipher')),
    `expected an assistant_thinking row containing the mock thinking before the answer, got: ${JSON.stringify(thinkingRows.map((message) => message.content))}`,
  );
  assert.ok(
    beforeAnswer.some((message) => message.kind === 'assistant_tool_call'),
    `expected at least one assistant_tool_call row before the answer, got: ${JSON.stringify(beforeAnswer.map((message) => message.kind))}`,
  );
});

test('repo-agent operation stream omits thinking', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-op-livtext-', t);
  const response = await requestOperationSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'inspect the cipher',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 4,
      approval: 'auto',
      availableModels: ['mock-model'],
      mockResponses: cipherThinkingMockResponses(),
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.ok(response.result, response.rawBody);
  const result = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(result.status, 'completed');
  const liveTextFrames = response.progress.filter((event) =>
    event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'progress_update');
  assert.equal(
    liveTextFrames.length,
    0,
    `operation stream must not forward live-text frames, got: ${JSON.stringify(liveTextFrames)}`,
  );
});

test('chat repo-agent stream rejects a request without an approval mode', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-no-mode-', t);
  const sessionId = await createSession(harness, 'No mode');
  const response = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'write a file', repoRoot: process.cwd(), operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('never'), mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'approval must be one of: interactive, auto, off.');
});

test('approval-mode endpoint rejects sessions without an active run and invalid modes', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-mode-409-', t);
  const sessionId = await createSession(harness, 'Mode without run');
  const idle = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(idle.statusCode, 409);
  const invalid = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'manual' }) },
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'approval must be one of: interactive, auto, off.');
});

test('switching a parked chat run to off approves the pending command and skips later approvals', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-switch-off-', t);
  const sessionId = await createSession(harness, 'Switch to off');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write two files',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 6,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'first.txt', content: 'one' } }] },
          { toolCalls: [{ name: 'write', arguments: { path: 'second.txt', content: 'two' } }] },
          ...repoAgentFinishResponses('wrote both'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = await waitForApproval(harness, sessionId);
  const parsedActive = ActiveChatRepoAgentResponseSchema.parse(active);
  assert.equal(parsedActive.approvalMode, 'interactive');
  assert.equal(parsedActive.status, 'approval_required');
  const parkedApprovalId = parsedActive.status === 'approval_required' ? parsedActive.approval.approvalId : null;

  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(switched.statusCode, 200);
  const switchedBody = ChatRepoAgentApprovalModeResponseSchema.parse(switched.body);
  assert.equal(switchedBody.approval, 'off');
  assert.equal(switchedBody.released?.approvalId, parkedApprovalId);
  assert.match(String(switchedBody.released?.decidedAtUtc), /^\d{4}-\d{2}-\d{2}T/u);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  // Exactly one approval frame: the second write ran under `off` without parking.
  assert.equal(response.events.filter((event) => event.event === 'approval').length, 1);
  const completed = readDoneResponse(response);
  const approvals = completed.session.messages.filter((message) => message.kind === 'repo_agent_approval');
  assert.equal(approvals.length, 1);
  const approval = approvals[0];
  assert.equal(approval?.kind === 'repo_agent_approval' ? approval.approvalDecision : null, 'approve');
  assert.equal(completed.session.messages.at(-1)?.content.includes('wrote both'), true);
});

test('active endpoint reports the live mode and a running chat run switches modes without parking', async (t) => {
  const gate = new EngineGate();
  const harness = await startHarness('siftkit-chat-repo-agent-mode-running-', t, {
    engineService: new GatedEngineService(gate),
  });
  const sessionId = await createSession(harness, 'Mode while running');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'hold generation', repoRoot: process.cwd(), approval: 'auto', operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('held then done'), mockCommandResults: {},
      }),
    },
  );
  await waitForRunStatus(harness, sessionId, 'running');
  const before = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(before.approvalMode, 'auto');
  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'interactive' }) },
  );
  assert.equal(switched.statusCode, 200);
  assert.equal(ChatRepoAgentApprovalModeResponseSchema.parse(switched.body).released, null);
  const after = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(after.approvalMode, 'interactive');
  gate.release();
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal(readDoneResponse(response).session.messages.filter((m) => m.kind === 'repo_agent_approval').length, 0);
});

test('an auto-mode chat run whose reviewer is unsure surfaces an approval frame instead of ending the stream', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-auto-unsure-', t);
  const sessionId = await createSession(harness, 'Auto unsure');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a file',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'unsure.txt', content: 'x' } }] },
          { content: '{"verdict":"unsure","reason":"cannot judge"}' },
          ...repoAgentFinishResponses('escalated and approved'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = ActiveChatRepoAgentResponseSchema.parse(await waitForApproval(harness, sessionId));
  assert.equal(active.status, 'approval_required');
  assert.equal(active.approvalMode, 'auto');
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal(response.events.some((event) => event.event === 'approval'), true);
  assert.equal(response.events.some((event) => event.event === 'error'), false);
  assert.equal(readDoneResponse(response).session.messages.at(-1)?.content.includes('escalated and approved'), true);
});
