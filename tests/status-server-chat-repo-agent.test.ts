import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ChatSessionResponseSchema, ChatStreamApprovalSchema } from '@siftkit/contracts';

import type { JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { asObject, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';

const ACTIVE_RUN_TIMEOUT_MS = 5_000;

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
      const state = asObject(response.body.state);
      if (state.status === 'approval_required') {
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
    if (response.statusCode === 200 && asObject(response.body.state).status === expectedStatus) {
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
  const harness = await startHarness('siftkit-chat-repo-agent-approve-', t);
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  const engineRequests: RepoSearchExecutionRequest[] = [];
  StatusEngineService.prototype.executeRepoSearch = function captureRepoAgentRequest(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    engineRequests.push(request);
    return originalExecute.call(this, request);
  };
  t.after(() => {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
  });
  const sessionId = await createSession(harness, 'Approve run');
  const seeded = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'prior question', assistantContent: 'prior answer' }),
  });
  assert.equal(seeded.statusCode, 200);

  const stream = startApprovalRun(harness, sessionId, 'approved.txt');
  const active = await waitForApproval(harness, sessionId);
  const runId = active.runId;
  assert.equal(typeof runId, 'string');

  const busy = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'must be rejected while agent runs' }),
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.operationKind, 'repo-agent');

  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  assert.equal(decide.body.runId, runId);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  const approvalEvent = response.events.find((event) => event.event === 'approval');
  assert.ok(approvalEvent?.payload);
  assert.equal(ChatStreamApprovalSchema.parse(approvalEvent.payload).runId, runId);
  const completed = readDoneResponse(response);
  const messages = completed.session.messages;
  assert.deepEqual(messages.slice(-3).map((message) => message.kind), [
    'user_text',
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
  const chatAgentRequest = engineRequests.find((request) => request.taskKind === 'repo-agent');
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
  const standaloneRequest = engineRequests.find((request) => request.prompt === 'standalone run');
  assert.ok(standaloneRequest);
  assert.equal('history' in standaloneRequest, false);
});

test('chat repo-agent decide rejects a run that is generating instead of parked', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-running-', t);
  const sessionId = await createSession(harness, 'Running run');
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  const engineGate = new EngineGate();
  StatusEngineService.prototype.executeRepoSearch = async function holdRepoAgentRequest(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    if (request.prompt === 'hold generation') {
      await engineGate.promise;
    }
    return await originalExecute.call(this, request);
  };
  t.after(() => {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
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
