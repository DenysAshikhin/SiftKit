import test from 'node:test';
import assert from 'node:assert/strict';

import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { asObject, asObjectArray, requestJson, type SseResponse } from './helpers/dashboard-http.js';

function readDoneSessionId(response: SseResponse): string {
  for (const event of response.events) {
    if (event.event !== 'done') {
      continue;
    }
    const session = asObject(asObject(event.payload).session);
    if (typeof session.id === 'string' && session.id) {
      return session.id;
    }
  }
  throw new Error('Expected SSE done event containing a session id.');
}

function readDoneAssistantContent(response: SseResponse): string {
  for (const event of response.events) {
    if (event.event !== 'done') continue;
    const session = asObject(asObject(event.payload).session);
    const messages = asObjectArray(session.messages);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && typeof message.content === 'string') {
        return message.content;
      }
    }
  }
  throw new Error('Expected SSE done event containing assistant content.');
}

test('exl3 streams different chat sessions concurrently without mixing results', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-parallel-', { exl3ActivePreset: true, parallelSlots: 4 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    const streamB = harness.startChatStream(sessionB, 'prompt-b');
    await harness.waitForActiveRequests('dashboard_chat_stream', 2);
    harness.releaseChatResponse('answer-a');
    harness.releaseChatResponse('answer-b');
    const [resultA, resultB] = await Promise.all([streamA, streamB]);
    assert.equal(readDoneSessionId(resultA), sessionA);
    assert.equal(readDoneSessionId(resultB), sessionB);
    assert.equal(readDoneAssistantContent(resultA), 'answer-a');
    assert.equal(readDoneAssistantContent(resultB), 'answer-b');
  } finally {
    await harness.close();
  }
});

test('inference requests serialize fifo and keep session status independent', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-fifo-', { parallelSlots: 1 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    const streamB = harness.startChatStream(sessionB, 'prompt-b');
    await harness.waitForQueuedRequest('dashboard_chat_stream');
    harness.releaseChatResponse('answer-a');
    const resultA = await streamA;
    assert.equal(readDoneSessionId(resultA), sessionA);
    assert.equal(readDoneAssistantContent(resultA), 'answer-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    harness.releaseChatResponse('answer-b');
    const resultB = await streamB;
    assert.equal(readDoneSessionId(resultB), sessionB);
    assert.equal(readDoneAssistantContent(resultB), 'answer-b');
  } finally {
    await harness.close();
  }
});

test('aborting one concurrent session releases only that session lease', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-abort-', { exl3ActivePreset: true, parallelSlots: 4 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    const streamB = harness.startChatStream(sessionB, 'prompt-b');
    await harness.waitForActiveRequests('dashboard_chat_stream', 2);
    harness.abortChatStream(sessionA);
    const busySession = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'while active', assistantContent: 'blocked' }),
    });
    assert.equal(busySession.statusCode, 409);
    harness.releaseChatResponse('answer-b');
    const resultB = await streamB;
    assert.equal(readDoneSessionId(resultB), sessionB);
    try {
      const resultA = await streamA;
      assert.equal(resultA.events.some((event) => event.event === 'done'), false);
      assert.equal(resultA.events.some((event) => event.event === 'error'), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /aborted|hang up|econnreset|socket/iu);
    }
    const availableSession = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'after abort', assistantContent: 'available' }),
    });
    assert.equal(availableSession.statusCode, 200);
  } finally {
    await harness.close();
  }
});

test('condense is rejected while the same session is streaming and allowed once it settles', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-condense-', { exl3ActivePreset: true, parallelSlots: 4 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);

    const busyCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/condense`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(busyCondense.statusCode, 409);
    assert.equal(asObject(busyCondense.body).operationKind, 'message');

    // Condense now issues its own summarization request, so it needs a mock response
    // exactly like any other turn driven through this harness.
    const otherCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}/condense`,
      { method: 'POST', body: JSON.stringify({ mockResponses: [{ content: 'summary-b' }] }) },
    );
    assert.equal(otherCondense.statusCode, 200);

    harness.releaseChatResponse('answer-a');
    await streamA;

    const settledCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/condense`,
      { method: 'POST', body: JSON.stringify({ mockResponses: [{ content: 'summary-a' }] }) },
    );
    assert.equal(settledCondense.statusCode, 200);
    const condensedMessages = asObjectArray(asObject(asObject(settledCondense.body).session).messages);
    assert.equal(condensedMessages.at(-1)?.kind, 'compaction_summary');
    assert.equal(condensedMessages.at(-1)?.content, 'summary-a');
  } finally {
    await harness.close();
  }
});
