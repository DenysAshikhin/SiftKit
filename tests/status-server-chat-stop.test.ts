import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { asObject, asObjectArray, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { StoppedChatEngineService } from './helpers/stopped-chat-engine-service.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

const OPERATION_A = '4f9c1f9a-0000-4000-8000-000000000000';
const OPERATION_B = '4f9c1f9a-0000-4000-8000-000000000001';

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
    if (response.statusCode === 200 && response.body.status === status) {
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

async function remainsPending<T>(completion: Promise<T>): Promise<boolean> {
  const pending = Symbol('pending');
  return await Promise.race([completion, Promise.resolve(pending)]) === pending;
}

test('POST stop rejects malformed ownership before checking active state', async (t) => {
  const harness = await startHarness('siftkit-chat-stop-empty-', t);
  const sessionId = await createSession(harness, 'No active operation');
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: '{}',
  });
  assert.equal(response.statusCode, 400);
  const noActive = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
  });
  assert.equal(noActive.statusCode, 409);
});

test('another client cannot stop an operation and status never exposes its ownership id', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-stop-owner-', { parallelSlots: 1 });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('Owned', 'model-a');
    const stream = harness.startChatStream(sessionId, 'owned request', OPERATION_A);
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    const status = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/operation`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.operationKind, 'message');
    assert.equal('operationId' in status.body, false);

    const rejected = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/stop`, {
      method: 'POST', body: JSON.stringify({ operationId: OPERATION_B }),
    });
    assert.equal(rejected.statusCode, 409);
    harness.releaseChatResponse('still running');
    assert.equal(readDoneAssistantContent(await stream), 'still running');
    const released = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/operation`);
    assert.equal(released.statusCode, 404);
  } finally {
    await harness.close();
  }
});

const STOPPABLE_STREAM_CASES = [
  { operationKind: 'message', requestKind: 'dashboard_chat_stream' },
  { operationKind: 'plan', requestKind: 'dashboard_plan_stream' },
  { operationKind: 'repo-search', requestKind: 'dashboard_repo_search_stream' },
] as const;

for (const streamCase of STOPPABLE_STREAM_CASES) {
  test(`stopping a ${streamCase.operationKind} stream persists the marker, releases its lease, and advances the queue`, async () => {
    const harness = new DashboardModelQueueHarness(`siftkit-chat-stop-${streamCase.operationKind}-`, { parallelSlots: 1 });
    await harness.start();
    try {
      const sessionA = await harness.createChatSession('A', 'model-a');
      const sessionB = await harness.createChatSession('B', 'model-a');
      const streamA = harness.startChatOperationStream(
        streamCase.operationKind,
        sessionA,
        `stop ${streamCase.operationKind}`,
        OPERATION_A,
      );
      await harness.waitForActiveRequests(streamCase.requestKind, 1);
      const streamB = harness.startChatStream(sessionB, 'next request');
      await harness.waitForQueuedRequest('dashboard_chat_stream');

      const stopped = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/stop`, {
        method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
      });
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopped.body.operationKind, streamCase.operationKind);
      const stoppedStream = await streamA;
      assert.match(readDoneAssistantContent(stoppedStream), /Stopped by user\./u);
      const stoppedDone = stoppedStream.events.find((event) => event.event === 'done');
      assert.ok(stoppedDone?.payload, 'Expected a done event for the stopped stream.');
      const doneMessages = asObjectArray(asObject(asObject(stoppedDone.payload).session).messages);
      const listed = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions`);
      const listedSessions = asObjectArray(listed.body.sessions);
      const stoppedSession = listedSessions.find((session) => session.id === sessionA);
      assert.ok(stoppedSession, 'Expected the stopped session in the session list.');
      const persistedMessages = asObjectArray(stoppedSession.messages);
      assert.deepEqual(persistedMessages.map((message) => message.kind), doneMessages.map((message) => message.kind));
      assert.deepEqual(persistedMessages.map((message) => message.content), doneMessages.map((message) => message.content));

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
}

test('stopping a repo-agent parked at approval persists an aborted terminal result', async (t) => {
  const harness = await startHarness('siftkit-chat-stop-agent-', t);
  const sessionId = await createSession(harness, 'Agent stop');
  const stream = requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({
      content: 'write a file', repoRoot: process.cwd(), approval: 'interactive', maxTurns: 4,
      operationId: OPERATION_A,
      mockResponses: [
        { toolCalls: [{ name: 'write', arguments: { path: 'stopped.txt', content: 'no' } }] },
        ...repoAgentFinishResponses('unreachable'),
      ],
      mockCommandResults: {},
    }),
  });
  const runId = await waitForRepoAgentStatus(harness, sessionId, 'approval_required');
  const stopped = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.body.operationKind, 'repo-agent');
  assert.equal(readDoneAssistantContent(await stream), 'Repo-agent run stopped by user.');
  assert.equal(readRepoAgentStatus(runId), 'aborted');
  const active = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`);
  assert.equal(active.statusCode, 404);
});

test('stopping a generating repo-agent records aborted and clears the chat binding', async (t) => {
  const engineService = new StoppedChatEngineService({
    prompt: 'hold generation',
    progressEvents: [
      { turn: 1, maxTurns: 2, kind: 'thinking', thinkingText: 'agent partial thought' },
      { turn: 1, maxTurns: 2, kind: 'narration', narrationText: 'Agent inspecting files.' },
      { turn: 2, maxTurns: 2, kind: 'answer', answerText: 'agent partial result' },
    ],
  });
  const harness = await startHarness('siftkit-chat-stop-agent-running-', t, { engineService });
  const sessionId = await createSession(harness, 'Generating agent stop');
  const stream = requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({
      content: 'hold generation', repoRoot: process.cwd(), approval: 'off',
      operationId: OPERATION_A,
      mockResponses: repoAgentFinishResponses('unreachable'), mockCommandResults: {},
    }),
  });
  const runId = await waitForRepoAgentStatus(harness, sessionId, 'running');
  await engineService.waitUntilEntered();
  const stopped = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`, {
    method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
  });
  assert.equal(stopped.statusCode, 200);
  const stoppedStream = await stream;
  assert.equal(
    readDoneAssistantContent(stoppedStream),
    'agent partial result\n\nRepo-agent run stopped by user.',
  );
  const done = stoppedStream.events.find((event) => event.event === 'done');
  assert.ok(done?.payload, 'Expected a done event for the stopped repo-agent stream.');
  const messages = asObjectArray(asObject(done.payload.session).messages);
  assert.deepEqual(messages.slice(-3).map((message) => message.kind), [
    'assistant_thinking',
    'assistant_narration',
    'assistant_answer',
  ]);
  assert.deepEqual(messages.slice(-3).map((message) => message.content), [
    'agent partial thought',
    'Agent inspecting files.',
    'agent partial result\n\nRepo-agent run stopped by user.',
  ]);
  assert.equal(readRepoAgentStatus(runId), 'aborted');
  const active = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`);
  assert.equal(active.statusCode, 404);
});

test('stopping a message stream persists the complete generated transcript in turn order', async () => {
  const engineService = new StoppedChatEngineService({
    prompt: 'capture the stopped transcript',
    pauseAfterAbort: true,
    progressEvents: [
      { turn: 1, maxTurns: 2, kind: 'thinking', thinkingText: 'first thought' },
      { turn: 1, maxTurns: 2, kind: 'narration', narrationText: 'Inspecting files.' },
      {
        turn: 1, maxTurns: 2, kind: 'tool_start', toolCallId: 'stopped-tool-1',
        activityKind: 'read', activitySubject: { kind: 'file', value: 'index.ts' },
        command: 'read path="index.ts"', promptTokenCount: 3, thinkingTokenCount: 0, elapsedMs: 1,
      },
      {
        turn: 1, maxTurns: 2, kind: 'tool_start', toolCallId: 'stopped-tool-2',
        activityKind: 'search', activitySubject: { kind: 'none' },
        command: 'search query="transcript"', promptTokenCount: 4, thinkingTokenCount: 0, elapsedMs: 2,
      },
      {
        turn: 1, maxTurns: 2, kind: 'tool_result', toolCallId: 'stopped-tool-2',
        activityKind: 'search', activitySubject: { kind: 'none' },
        command: 'search query="transcript"', exitCode: 0, outputSnippet: 'match found',
        outputTokens: 2, outputTokensEstimated: false, promptTokenCount: 4,
        thinkingTokenCount: 0, elapsedMs: 3,
      },
      { turn: 2, maxTurns: 2, kind: 'thinking', thinkingText: 'second thought' },
      { turn: 2, maxTurns: 2, taskId: 'stopped-task', elapsedMs: 2, kind: 'progress_update', progressText: 'Step 2 of 5' },
      { turn: 2, maxTurns: 2, kind: 'answer', answerText: 'partial answer text' },
    ],
  });
  const harness = new DashboardModelQueueHarness('siftkit-chat-stop-transcript-', {
    parallelSlots: 1,
    engineService,
  });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('Transcript', 'model-a');
    const stream = harness.startChatOperationStream('message', sessionId, 'capture the stopped transcript', OPERATION_A);
    await engineService.waitUntilEntered();
    const stopRequest = requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/stop`, {
      method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
    });
    await engineService.waitUntilAborted();
    const stopWaitedForPersistence = await remainsPending(stopRequest);
    engineService.releaseAfterAbort();
    assert.equal(stopWaitedForPersistence, true);
    const stopped = await stopRequest;
    assert.equal(stopped.statusCode, 200);
    const immediate = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(immediate.statusCode, 200);
    const immediateMessages = asObjectArray(asObject(immediate.body.session).messages);
    assert.equal(immediateMessages.at(-1)?.content, 'partial answer text\n\n*Stopped by user.*');
    const done = await stream;
    const doneEvent = done.events.find((event) => event.event === 'done');
    assert.ok(doneEvent?.payload, 'Expected a done event.');
    const doneMessages = asObjectArray(asObject(asObject(doneEvent.payload).session).messages);
    assert.deepEqual(doneMessages.map((message) => message.kind), [
      'user_text',
      'assistant_thinking',
      'assistant_progress',
      'assistant_tool_call',
      'assistant_tool_call',
      'assistant_thinking',
      'assistant_progress',
      'assistant_answer',
    ]);
    assert.deepEqual(doneMessages.map((message) => message.content), [
      'capture the stopped transcript',
      'first thought',
      'Inspecting files.',
      'read path="index.ts"',
      'search query="transcript"',
      'second thought',
      'Step 2 of 5',
      'partial answer text\n\n*Stopped by user.*',
    ]);
    const doneTools = doneMessages.filter((message) => message.kind === 'assistant_tool_call');
    assert.deepEqual(doneTools.map((message) => message.toolCallStatus), ['stopped', 'done']);
    assert.equal(doneTools[1]?.toolCallOutputSnippet, 'match found');

    const listed = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions`);
    const listedSessions = asObjectArray(listed.body.sessions);
    const persisted = listedSessions.find((session) => session.id === sessionId);
    assert.ok(persisted, 'Expected the stopped session in the session list.');
    const persistedMessages = asObjectArray(persisted.messages);
    assert.deepEqual(persistedMessages.map((message) => message.kind), doneMessages.map((message) => message.kind));
    assert.deepEqual(persistedMessages.map((message) => message.content), doneMessages.map((message) => message.content));
    const persistedTools = persistedMessages.filter((message) => message.kind === 'assistant_tool_call');
    assert.deepEqual(persistedTools.map((message) => message.toolCallStatus), ['stopped', 'done']);
    assert.equal(persistedTools[1]?.toolCallOutputSnippet, 'match found');
  } finally {
    await harness.close();
  }
});

test('Stop reports persistence failure instead of claiming success', async () => {
  const engineService = new StoppedChatEngineService({
    prompt: 'fail stopped persistence',
    progressEvents: [
      { turn: 1, maxTurns: 1, kind: 'answer', answerText: 'partial' },
    ],
    pauseAfterAbort: true,
  });
  const harness = new DashboardModelQueueHarness('siftkit-chat-stop-persistence-failure-', {
    parallelSlots: 1,
    engineService,
  });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('Persistence failure', 'model-a');
    const stream = harness.startChatOperationStream('message', sessionId, 'fail stopped persistence', OPERATION_A);
    await engineService.waitUntilEntered();
    const stopRequest = requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/stop`, {
      method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
    });
    await engineService.waitUntilAborted();
    getRuntimeDatabase(path.join(process.cwd(), '.siftkit', 'runtime.sqlite')).exec('DROP TABLE chat_messages;');
    engineService.releaseAfterAbort();
    const stopped = await stopRequest;
    assert.equal(stopped.statusCode, 500);
    await stream;
  } finally {
    engineService.releaseAfterAbort();
    await harness.close();
  }
});

test('stopping a message stream with no generated segments persists only the marker', async () => {
  const engineService = new StoppedChatEngineService({
    prompt: 'stop before anything streams',
    progressEvents: [
      { turn: 1, maxTurns: 1, kind: 'thinking', thinkingText: '' },
      { turn: 1, maxTurns: 1, kind: 'narration', narrationText: '' },
      { turn: 1, maxTurns: 1, kind: 'answer', answerText: '' },
    ],
  });
  const harness = new DashboardModelQueueHarness('siftkit-chat-stop-empty-partial-', {
    parallelSlots: 1,
    engineService,
  });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('Empty partial', 'model-a');
    const stream = harness.startChatOperationStream('message', sessionId, 'stop before anything streams', OPERATION_A);
    await engineService.waitUntilEntered();
    const stopped = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/stop`, {
      method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }),
    });
    assert.equal(stopped.statusCode, 200);
    const done = await stream;
    const doneEvent = done.events.find((event) => event.event === 'done');
    assert.ok(doneEvent?.payload, 'Expected a done event.');
    const doneMessages = asObjectArray(asObject(asObject(doneEvent.payload).session).messages);
    assert.deepEqual(doneMessages.map((message) => message.kind), ['user_text', 'assistant_answer']);
    assert.deepEqual(doneMessages.map((message) => message.content), [
      'stop before anything streams',
      '*Stopped by user.*',
    ]);
  } finally {
    await harness.close();
  }
});
