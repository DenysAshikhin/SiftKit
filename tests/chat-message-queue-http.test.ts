import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ChatMessageQueueResponseSchema, ChatQueueForceRequestSchema, ChatQueueMessageResponseSchema } from '@siftkit/contracts';
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { requestJson } from './helpers/dashboard-http.js';

test('queue HTTP validates, lists bounded previews, edits and removes durable entries', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-queue-http-', { parallelSlots: 1 });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('queue', 'mock');
    const url = `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/queue`;
    const id = randomUUID();
    const body = { id, content: 'x'.repeat(300), images: [], options: { operationKind: 'message' } };
    const enqueue = await requestJson(url, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(enqueue.statusCode, 200);
    const queue = ChatMessageQueueResponseSchema.parse(enqueue.body).queue;
    assert.equal(queue.messages[0]?.preview.length, 200);
    const detail = await requestJson(`${url}/${id}`);
    assert.equal(detail.statusCode, 200);
    assert.equal(ChatQueueMessageResponseSchema.parse(detail.body).message.content, body.content);
    assert.equal((await requestJson(url, { method: 'POST', body: JSON.stringify(body) })).statusCode, 200);
    assert.equal((await requestJson(url, { method: 'POST', body: JSON.stringify({ ...body, content: 'conflict' }) })).statusCode, 409);
    assert.equal((await requestJson(`${url}/${id}`, { method: 'PUT', body: JSON.stringify({ content: 'edited', revision: 1 }) })).statusCode, 200);
    assert.equal((await requestJson(`${url}/${id}`, { method: 'PUT', body: JSON.stringify({ content: 'stale', revision: 1 }) })).statusCode, 409);
    assert.equal((await requestJson(`${url}/${id}`, { method: 'DELETE' })).statusCode, 200);
    assert.deepEqual(ChatMessageQueueResponseSchema.parse((await requestJson(url)).body).queue.messages, []);
    assert.equal((await requestJson(url, { method: 'POST', body: JSON.stringify({ ...body, content: '' }) })).statusCode, 400);
    assert.equal((await requestJson(url, { method: 'POST', body: JSON.stringify({ ...body, images: ['data:image/png;base64,AA=='] }) })).statusCode, 400);
    assert.deepEqual(ChatMessageQueueResponseSchema.parse((await requestJson(url)).body).queue.messages, []);
  } finally { await harness.close(); }
});

test('force requests require a stable idempotency key and explicit operation identity', () => {
  assert.equal(ChatQueueForceRequestSchema.safeParse({ operationId: randomUUID() }).success, false);
  assert.equal(ChatQueueForceRequestSchema.safeParse({ id: randomUUID(), operationId: randomUUID() }).success, true);
});

test('queue routes reject malformed encoded session identities as bad requests', async () => {
  const harness = new DashboardModelQueueHarness('chat-queue-invalid-session-', { parallelSlots: 1 });
  await harness.start();
  try {
    for (const suffix of ['', '/stream', '/force']) {
      const response = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/%/queue${suffix}`,
        suffix === '/force' ? { method: 'POST', body: '{}' } : undefined);
      assert.equal(response.statusCode, 400, suffix);
    }
  } finally { await harness.close(); }
});

