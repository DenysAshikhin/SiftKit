import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { ChatMessageQueueStore, type ChatQueueEnqueueInput } from '../src/state/chat-message-queue.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession, type ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, requestSse, asObject, asObjectArray } from './helpers/dashboard-http.js';
import { HoldingCaptureEngineService } from './helpers/holding-capture-engine-service.js';
import { buildRepoToolRequestedCommand } from '../src/repo-search/engine/repo-tools.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RepoSearchExecutionRequest } from '../src/repo-search/types.js';
import { awaitRepoSearchRunPersistence } from '../src/repo-search/execute.js';
import { z } from '../src/lib/zod.js';

class FailAfterExecutionService extends HoldingCaptureEngineService {
  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<never> {
    await super.executeRepoSearch(request);
    throw new Error('provider failed after delivery');
  }
}

class TerminalHoldService extends HoldingCaptureEngineService {
  private notifyReady: (() => void) | null = null;
  private notifyRelease: (() => void) | null = null;
  readonly ready = new Promise<void>((resolve) => { this.notifyReady = resolve; });
  private readonly terminalReleased = new Promise<void>((resolve) => { this.notifyRelease = resolve; });
  constructor(private readonly failed: boolean | 'throw') { super('unused'); }
  release(): void { this.notifyRelease?.(); }
  override async executeRepoSearch(request: RepoSearchExecutionRequest) {
    const result = await super.executeRepoSearch(request);
    if (request.prompt.includes('original task')) {
      this.notifyReady?.();
      await this.terminalReleased;
      if (this.failed === 'throw') throw new Error('terminal persistence failed');
      if (this.failed) return { ...result, scorecard: { ...result.scorecard, verdict: 'fail' as const, tasks: result.scorecard.tasks.map((task) => ({ ...task, reason: 'max_turns' as const })) } };
    }
    return result;
  }
}

for (const failed of [false, true, 'throw'] as const) test(`terminal ${failed === 'throw' ? 'nonstream error retains' : failed ? 'failure retains' : 'normal finish automatically sends'} pending follow-ups`, async (t) => {
  const service = new TerminalHoldService(failed);
  const harness = await startHarness('siftkit-queue-terminal-', t, { engineService: service });
  t.after(() => service.release());
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'terminal' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const running = requestSse(`${url}/${failed === 'throw' ? 'plan' : 'messages/stream'}`, { method: 'POST', body: JSON.stringify({ operationId: randomUUID(), content: 'original task', repoRoot: process.cwd(), mockResponses: [{ content: 'finished' }] }) });
  await service.ready;
  assert.equal((await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), content: 'follow-up', images: [], options: { operationKind: failed === 'throw' ? 'plan' : 'message', mockResponses: [{ content: 'continued' }] } }) })).statusCode, 200);
  service.release();
  await running;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (asObjectArray((await requestJson(`${harness.baseUrl}/dashboard/chat/operations`)).body.operations).length === 0) break;
    await delay(10);
  }
  const state = asObject((await requestJson(`${url}/queue`)).body.queue);
  assert.equal(service.requests.length, failed ? 1 : 2);
  assert.equal(asObjectArray(state.messages).length, failed ? 1 : 0);
  assert.equal(state.paused, Boolean(failed));
});

for (const fail of [false, true]) test(`normal queued delivery retains safe chronology${fail ? ' when the provider fails' : ''}`, async (t) => {
  const command = buildRepoToolRequestedCommand('read', { path: 'package.json' });
  const service = fail ? new FailAfterExecutionService(command) : new HoldingCaptureEngineService(command);
  const harness = await startHarness('siftkit-normal-queue-', t, { engineService: service });
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'normal' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const original = requestSse(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), content: 'original task', repoRoot: process.cwd(), maxTurns: 3,
    mockResponses: [{ toolCalls: [{ name: 'read', arguments: { path: 'package.json' } }] }, { content: 'answer after steering' }],
    mockCommandResults: { [command]: { exitCode: 0, stdout: 'complete tool evidence', delayMs: 500 } },
  }) });
  await service.waitUntilHoldingTool();
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) assert.equal((await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id, content: `steering ${index}`, images: [], options: { operationKind: 'repo-search' } }) })).statusCode, 200);
  const response = await original;
  assert.deepEqual(response.events.filter((event) => event.event === 'queued_user_message').map((event) => event.payload?.id), ids);
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  assert.deepEqual(messages.filter((row) => row.role === 'user').map((row) => row.content), ['original task', 'steering 0', 'steering 1']);
  const toolIndex = messages.findIndex((row) => row.kind === 'assistant_tool_call');
  assert.ok(toolIndex >= 0 && toolIndex < messages.findIndex((row) => row.id === ids[0]));
  assert.equal(service.requests.length, 1);
  const state = asObject((await requestJson(`${url}/queue`)).body.queue);
  assert.equal(asObjectArray(state.messages).length, 0);
  if (fail) {
    assert.equal(state.paused, true);
    assert.match(String(messages.at(-1)?.content), /provider failed after delivery/u);
  }
});

for (const mode of ['message', 'plan', 'repo-search', 'repo-agent'] as const) {
  test(`Force now ${mode} persists separate FIFO users and a late retry cannot start again`, async (t) => {
    const harness = await startHarness(`siftkit-force-${mode}-`, t);
    const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'force' }) });
    const sessionId = String(asObject(created.body.session).id);
    const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const added = await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id, content: `queued-${index}`, images: [], options: { operationKind: mode, repoRoot: process.cwd(), mockResponses: [{ content: 'finished' }, { content: 'finished' }] } }) });
      assert.equal(added.statusCode, 200);
    }
    const force = { id: randomUUID(), operationId: null };
    const started = await requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify(force) });
    assert.equal(started.statusCode, 200);
    for (let attempt = 0; attempt < 200; attempt++) {
      const active = await requestJson(`${harness.baseUrl}/dashboard/chat/operations`);
      if (asObjectArray(active.body.operations).length === 0) break;
      await delay(10);
    }
    const saved = await requestJson(url);
    const rows = asObjectArray(asObject(saved.body.session).messages);
    assert.deepEqual(rows.filter((row) => row.role === 'user').map((row) => row.id), ids);
    assert.deepEqual(rows.filter((row) => row.role === 'user').map((row) => row.content), ['queued-0', 'queued-1']);
    const retry = await requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify(force) });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.successorOperationId, started.body.successorOperationId);
    assert.equal(asObjectArray(asObject((await requestJson(url)).body.session).messages).length, rows.length);
  });
}

test('a separate send cannot overtake durable pending users', async (t) => {
  const service = new HoldingCaptureEngineService('unused');
  const harness = await startHarness('siftkit-queue-admission-order-', t, { engineService: service });
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'order' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), content: 'first', images: [], options: { operationKind: 'message' } }) });
  const later = await requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({ operationId: randomUUID(), content: 'second', mockResponses: [{ content: 'overtook' }] }) });
  assert.equal(later.statusCode, 409);
  assert.equal(service.requests.length, 0);
});

test('an automatic busy enqueue arriving after normal completion still starts one successor', async (t) => {
  const service = new HoldingCaptureEngineService('unused');
  const harness = await startHarness('siftkit-queue-late-enqueue-', t, { engineService: service });
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'late' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const operationId = randomUUID();
  await requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({ operationId, content: 'original', mockResponses: [{ content: 'done' }] }) });
  const response = await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), afterOperationId: operationId, content: 'late follow-up', images: [], options: { operationKind: 'message', mockResponses: [{ content: 'continued' }] } }) });
  assert.equal(response.statusCode, 200);
  for (let attempt = 0; attempt < 100 && service.requests.length < 2; attempt++) await delay(10);
  assert.equal(service.requests.length, 2);
});

test('snapshot image admission fails before any queued row is claimed or engine is called', async (t) => {
  const service = new HoldingCaptureEngineService('unused');
  const harness = await startHarness('siftkit-force-image-admission-', t, { engineService: service });
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'admission' }) })).body.session).id);
  const store = new ChatMessageQueueStore(getRuntimeDatabase());
  store.enqueue(sessionId, { id: randomUUID(), content: 'first', images: [], options: { operationKind: 'message' } });
  store.enqueue(sessionId, { id: randomUUID(), content: 'invalid retained image', images: ['data:image/png;base64,AA=='], options: { operationKind: 'message' } });
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/queue/force`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), operationId: null }) });
  assert.equal(response.statusCode, 500);
  assert.equal(store.listPending(sessionId).length, 2);
  assert.equal(service.requests.length, 0);
});

for (const cancel of [false, true]) test(`Force now ${cancel ? 'is superseded by ordinary Stop' : 'waits for persistence and replays full evidence before the FIFO successor'}`, async (t) => {
  const holdCommand = buildRepoToolRequestedCommand('grep', { pattern: 'hold' });
  const service = new HoldingCaptureEngineService(holdCommand, true);
  const harness = await startHarness('siftkit-force-settlement-', t, { engineService: service });
  t.after(() => service.releaseAfterAbort());
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'settle' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const operationId = randomUUID();
  const fullResult = `${'evidence '.repeat(100)}FULL_RESULT_SENTINEL`;
  const original = requestSse(`${url}/repo-search/stream`, { method: 'POST', timeoutMs: 15000, body: JSON.stringify({
    operationId, content: 'original task', repoRoot: process.cwd(), maxTurns: 3,
    mockResponses: [{ toolCalls: [{ name: 'read', arguments: { path: 'package.json' } }] }, { toolCalls: [{ name: 'grep', arguments: { pattern: 'hold' } }] }],
    mockCommandResults: {
      [buildRepoToolRequestedCommand('read', { path: 'package.json' })]: { exitCode: 0, stdout: fullResult },
      [holdCommand]: { exitCode: 0, stdout: 'not executed', delayMs: 30000 },
    },
  }) });
  await service.waitUntilHoldingTool();
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) assert.equal((await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id, content: `steer ${index}`, images: [], options: { operationKind: 'repo-search', repoRoot: process.cwd(), mockResponses: [{ content: 'done' }] } }) })).statusCode, 200);
  const force = { id: randomUUID(), operationId };
  const forcing = requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify(force), timeoutMs: 15000 });
  await service.waitUntilUnwound();
  assert.equal(service.requests.length, 1);
  assert.equal(asObjectArray(asObject((await requestJson(url)).body.session).messages).length, 0);
  assert.equal((await requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify(force) })).statusCode, 200);
  assert.equal((await requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), operationId: randomUUID() }) })).statusCode, 409);
  if (cancel) {
    const stopping = requestJson(`${url}/stop`, { method: 'POST', body: JSON.stringify({ operationId }) });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (asObject((await requestJson(`${url}/queue`)).body.queue).force === null) break;
      await delay(10);
    }
    assert.equal(asObject((await requestJson(`${url}/queue`)).body.queue).force, null);
    assert.equal(service.requests.length, 1);
    service.releaseAfterAbort();
    assert.equal((await stopping).statusCode, 200);
    assert.equal((await forcing).statusCode, 409);
    await original;
    const queue = asObject((await requestJson(`${url}/queue`)).body.queue);
    assert.equal(queue.paused, true);
    assert.equal(asObjectArray(queue.messages).filter((message) => message.state === 'pending').length, 2);
    assert.equal(service.requests.length, 1);
    return;
  }
  service.releaseAfterAbort();
  assert.equal((await forcing).statusCode, 200);
  await original;
  for (let attempt = 0; attempt < 200 && service.requests.length < 2; attempt++) await delay(10);
  const successor = service.requireRequest('steer 0');
  assert.match(JSON.stringify(successor.history), /FULL_RESULT_SENTINEL/u);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (asObjectArray((await requestJson(`${harness.baseUrl}/dashboard/chat/operations`)).body.operations).length === 0) break;
    await delay(10);
  }
  await awaitRepoSearchRunPersistence();
  const transcript = z.object({ repo_search_transcript_jsonl: z.string() }).parse(getRuntimeDatabase().prepare('SELECT repo_search_transcript_jsonl FROM run_logs WHERE request_id = ?').get(successor.requestId)).repo_search_transcript_jsonl;
  const events = transcript.trim().split('\n').map((line) => z.object({ kind: z.string(), id: z.string().optional() }).parse(JSON.parse(line)));
  assert.deepEqual(events.filter((event) => event.kind === 'queued_user_message').map((event) => event.id), ids);
  assert.equal(service.requests.length, 2);
});

function session(): ChatSession {
  const now = '2026-09-09T00:00:00.000Z';
  return {
    id: 'session-1',
    title: 'Session',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'mock', NumCtx: 8192 }),
    planRepoRoot: process.cwd(),
    presetId: 'chat',
    mode: 'chat',
    createdAtUtc: now,
    updatedAtUtc: now,
    messages: [],
  };
}

function entry(index: number): ChatQueueEnqueueInput {
  return {
    id: `4f9c1f9a-0000-4000-8000-${String(index).padStart(12, '0')}`,
    content: `queued ${index}`,
    images: [],
    options: { operationKind: 'message' },
  };
}

test('force intent snapshots pending IDs durably and retries by idempotency key', () => {
  const runtimeRoot = createManagedTempDir('siftkit-queue-force-');
  try {
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    saveChatSession(runtimeRoot, session());
    const store = new ChatMessageQueueStore(database);
    assert.equal(store.enqueue('session-1', entry(1)).kind, 'enqueued');
    assert.equal(store.enqueue('session-1', entry(2)).kind, 'enqueued');

    const request = {
      id: '4f9c1f9a-0000-4000-8000-000000000099',
      operationId: '4f9c1f9a-0000-4000-8000-000000000100',
    };
    const started = store.beginForce('session-1', request, '4f9c1f9a-0000-4000-8000-000000000101');

    assert.equal(started.kind, 'started');
    assert.deepEqual(store.state('session-1').force, {
      id: request.id,
      operationId: request.operationId,
      phase: 'stopping',
      messageIds: [entry(1).id, entry(2).id],
      successorOperationId: '4f9c1f9a-0000-4000-8000-000000000101',
      failureDetail: null,
    });
    const retried = store.beginForce('session-1', request, '4f9c1f9a-0000-4000-8000-000000000101');
    assert.equal(retried.kind, 'duplicate');
    assert.equal(store.beginForce('session-1', {
      id: '4f9c1f9a-0000-4000-8000-000000000102',
      operationId: request.operationId,
    }, '4f9c1f9a-0000-4000-8000-000000000103').kind, 'conflict');
  } finally {
    closeRuntimeDatabase();
  }
});
