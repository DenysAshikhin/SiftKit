import test from 'node:test';
import assert from 'node:assert/strict';

import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { asObject, requestJson, requestSse } from './helpers/dashboard-http.js';

// A chat turn is reported to /status twice when both the dashboard route and the engine
// post for the same turn: every character, token and millisecond lands in the runtime
// totals once per poster. These E2Es drive the real endpoints against a live status
// server and pin each total to a single contribution.
const CHAT_PROMPT = 'What is 2+2?';
const CHAT_ANSWER = '4';
const MOCK_FINISH_RESPONSE = `{"action":"finish","output":"${CHAT_ANSWER}"}`;

test('a model-backed chat turn contributes to runtime metrics exactly once', async () => {
  const server = await DashboardTestServer.start('siftkit-chat-metrics-');
  try {
    const created = await requestJson(`${server.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'metrics' }),
    });
    assert.equal(created.statusCode, 200);
    const sessionId = String(asObject(created.body.session).id);

    const response = await requestJson(`${server.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify({
        content: CHAT_PROMPT,
        mockResponses: [MOCK_FINISH_RESPONSE],
      }),
    });
    assert.equal(response.statusCode, 200);

    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.taskTotals.chat.inputCharactersTotal, CHAT_PROMPT.length, 'prompt characters counted twice');
    assert.equal(metrics.taskTotals.chat.outputCharactersTotal, CHAT_ANSWER.length, 'answer characters counted twice');
    assert.equal(metrics.inputCharactersTotal, CHAT_PROMPT.length);
    assert.equal(metrics.outputCharactersTotal, CHAT_ANSWER.length);
    assert.equal(metrics.taskTotals.chat.completedRequestCount, 1);
    assert.equal(metrics.completedRequestCount, 1);
  } finally {
    await server.close();
  }
});

test('a client-supplied assistant message still reaches runtime metrics', async () => {
  const server = await DashboardTestServer.start('siftkit-chat-metrics-provided-');
  try {
    const created = await requestJson(`${server.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'metrics-provided' }),
    });
    assert.equal(created.statusCode, 200);
    const sessionId = String(asObject(created.body.session).id);

    const response = await requestJson(`${server.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify({
        content: CHAT_PROMPT,
        assistantContent: CHAT_ANSWER,
      }),
    });
    assert.equal(response.statusCode, 200);

    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.taskTotals.chat.inputCharactersTotal, CHAT_PROMPT.length, 'the no-engine path must report itself');
    assert.equal(metrics.taskTotals.chat.outputCharactersTotal, CHAT_ANSWER.length);
    assert.equal(metrics.taskTotals.chat.completedRequestCount, 1);
  } finally {
    await server.close();
  }
});

test('a streamed chat turn contributes to runtime metrics exactly once', async () => {
  const server = await DashboardTestServer.start('siftkit-chat-metrics-stream-');
  try {
    const created = await requestJson(`${server.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'metrics-stream' }),
    });
    assert.equal(created.statusCode, 200);
    const sessionId = String(asObject(created.body.session).id);

    const sse = await requestSse(`${server.baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: 10_000,
      body: JSON.stringify({
        content: CHAT_PROMPT,
        webSearchOverride: 'off',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [MOCK_FINISH_RESPONSE],
      }),
    });
    assert.equal(sse.statusCode, 200);
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));

    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.taskTotals.chat.inputCharactersTotal, CHAT_PROMPT.length, 'prompt characters counted twice');
    assert.equal(metrics.taskTotals.chat.outputCharactersTotal, CHAT_ANSWER.length, 'answer characters counted twice');
    assert.equal(metrics.inputCharactersTotal, CHAT_PROMPT.length);
    assert.equal(metrics.outputCharactersTotal, CHAT_ANSWER.length);
    assert.equal(metrics.taskTotals.chat.completedRequestCount, 1);
  } finally {
    await server.close();
  }
});
