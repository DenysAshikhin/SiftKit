import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { asObject, asObjectArray, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';

// Task 9 discovery:
// 1. Each chat engine request already accepts `abortSignal`; the three stream endpoints currently omit it.
// 2. `acquireModelRequestWithWait` can cancel only from HTTP close/abort, not an arbitrary AbortSignal.
//    A queued Stop therefore fires when that request acquires the model lock (accepted v1 behavior).
// 3. `ChatStreamProgressWriter` retains only unsent delta bookkeeping and exposes no assembled answer text.
//    Abort persistence therefore safely writes the marker without claiming inaccessible partial text.
// 4. `RepoAgentSession.run()` currently sends every thrown abort through `settleFailure`; the fix must
//    transition an aborted controller to terminal `aborted` before the generic failure path.

function readDoneAssistantContent(response: SseResponse): string {
  const done = response.events.find((event) => event.event === 'done');
  assert.ok(done?.payload, 'Expected a done event.');
  const messages = asObjectArray(asObject(done.payload.session).messages);
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (typeof assistant?.content !== 'string') {
    throw new Error('Expected persisted assistant content.');
  }
  return assistant.content;
}

async function createSession(harness: StreamedOperationHarness, title: string): Promise<string> {
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, {
    method: 'POST', body: JSON.stringify({ title }),
  });
  const id = asObject(response.body.session).id;
  if (typeof id !== 'string' || !id) throw new Error('Expected session id.');
  return id;
}

async function waitForRepoAgentStatus(
  harness: StreamedOperationHarness,
  sessionId: string,
  status: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`);
    if (response.statusCode === 200 && asObject(response.body.state).status === status) {
      const runId = response.body.runId;
      if (typeof runId === 'string' && runId) return runId;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for repo-agent status ${status}.`);
}

function readRepoAgentStatus(runId: string): string {
  return new RepoAgentRunStore(path.join(process.cwd(), '.siftkit', 'repo-agent', 'runs'))
    .readState(runId).status;
}

class EngineGate {
  readonly promise: Promise<void>;
  private releasePromise: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.releasePromise = resolve; });
  }

  release(): void {
    const release = this.releasePromise;
    if (!release) throw new Error('Engine gate is not initialized.');
    this.releasePromise = null;
    release();
  }
}

test('POST stop returns 409 when no stoppable operation is active', async (t) => {
  const harness = await startHarness('siftkit-chat-stop-empty-', t);
  const sessionId = await createSession(harness, 'No active operation');
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: '{}',
  });
  assert.equal(response.statusCode, 409);
});

test('stopping a chat stream persists the marker, releases its lease, and advances the queue', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-stop-stream-', { parallelSlots: 1 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'stop me');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    const streamB = harness.startChatStream(sessionB, 'next request');
    await harness.waitForQueuedRequest('dashboard_chat_stream');

    const stopped = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/stop`, {
      method: 'POST', body: '{}',
    });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.body.operationKind, 'message');
    assert.match(readDoneAssistantContent(await streamA), /Stopped by user\./u);

    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    harness.releaseChatResponse('queue advanced');
    assert.equal(readDoneAssistantContent(await streamB), 'queue advanced');

    const available = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/messages`, {
      method: 'POST', body: JSON.stringify({ content: 'after stop', assistantContent: 'available' }),
    });
    assert.equal(available.statusCode, 200);
  } finally {
    await harness.close();
  }
});

test('stopping a repo-agent parked at approval persists an aborted terminal result', async (t) => {
  const harness = await startHarness('siftkit-chat-stop-agent-', t);
  const sessionId = await createSession(harness, 'Agent stop');
  const stream = requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({
      content: 'write a file', repoRoot: process.cwd(), approval: 'interactive', maxTurns: 4,
      mockResponses: [
        { toolCalls: [{ name: 'write', arguments: { path: 'stopped.txt', content: 'no' } }] },
        ...repoAgentFinishResponses('unreachable'),
      ],
      mockCommandResults: {},
    }),
  });
  const runId = await waitForRepoAgentStatus(harness, sessionId, 'approval_required');
  const stopped = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: '{}',
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.body.operationKind, 'repo-agent');
  assert.equal(readDoneAssistantContent(await stream), 'Repo-agent run stopped by user.');
  assert.equal(readRepoAgentStatus(runId), 'aborted');
  const active = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`);
  assert.equal(active.statusCode, 404);
});

test('stopping a generating repo-agent records aborted and clears the chat binding', async (t) => {
  const harness = await startHarness('siftkit-chat-stop-agent-running-', t);
  const sessionId = await createSession(harness, 'Generating agent stop');
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  const gate = new EngineGate();
  StatusEngineService.prototype.executeRepoSearch = async function holdGeneratingAgent(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    if (request.prompt === 'hold generation') await gate.promise;
    return await originalExecute.call(this, request);
  };
  t.after(() => {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    try { gate.release(); } catch { /* already released */ }
  });
  const stream = requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({
      content: 'hold generation', repoRoot: process.cwd(), approval: 'off',
      mockResponses: repoAgentFinishResponses('unreachable'), mockCommandResults: {},
    }),
  });
  const runId = await waitForRepoAgentStatus(harness, sessionId, 'running');
  const stopped = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: '{}',
  });
  assert.equal(stopped.statusCode, 200);
  gate.release();
  assert.equal(readDoneAssistantContent(await stream), 'Repo-agent run stopped by user.');
  assert.equal(readRepoAgentStatus(runId), 'aborted');
  const active = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`);
  assert.equal(active.statusCode, 404);
});
