import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';

const isolatedRuntime = new IsolatedRuntime();
before(() => isolatedRuntime.start());
after(() => isolatedRuntime.close());
import path from 'node:path';
import http from 'node:http';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { getAddressInfo, asObjectArray } from './helpers/dashboard-http.js';

import { ChatMessageQueue } from '../src/status-server/chat-message-queue.js';
import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import { ChatMessageQueueStore, type ChatQueueEnqueueInput } from '../src/state/chat-message-queue.js';
import { saveChatSession, type ChatSession } from '../src/state/chat-sessions.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import type { ChatDeliveredMessage, ChatMessageQueueDelivery } from '../src/repo-search/engine/queue-delivery.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import type { ChatMessage } from '../src/repo-search/planner-chat-message.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';

function message(id: string, content: string): ChatQueueEnqueueInput {
  return { id, content, images: [], options: { operationKind: 'message' } };
}

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

class CaptureDelivery implements ChatMessageQueueDelivery {
  readonly rows: ChatDeliveredMessage[];
  snapshots: ChatMessage[][] = [];
  private consumed = false;

  constructor() {
    const now = '2026-09-09T00:00:00.000Z';
    this.rows = [1, 2].map((index) => ({
      sequence: index,
      sessionId: 'session-1',
      id: `4f9c1f9a-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      content: `queued ${index}`,
      images: [],
      imageMeta: [],
      options: { operationKind: 'repo-search' },
      revision: 1,
      state: 'delivered',
      deliveredRequestId: 'request-1',
      deliveredTurn: 1,
      createdAtUtc: now,
    }));
  }

  consume(_turn: number, transcript: TranscriptManager): ChatDeliveredMessage[] {
    if (this.consumed) return [];
    this.consumed = true;
    for (const row of this.rows) transcript.pushUser(row.content, row.images);
    this.snapshots.push(transcript.getMessages().slice());
    return this.rows;
  }

  initial(): ChatDeliveredMessage[] { return []; }
}

test('initial queue delivery claims the fixed force snapshot only at the engine boundary', () => {
  const runtimeRoot = createManagedTempDir('siftkit-queue-initial-');
  try {
    const store = new ChatMessageQueueStore(getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')));
    saveChatSession(runtimeRoot, session());
    const id = '4f9c1f9a-0000-4000-8000-000000000001';
    const forceId = '4f9c1f9a-0000-4000-8000-000000000002';
    store.enqueue('session-1', message(id, 'first'));
    store.beginForce('session-1', { id: forceId, operationId: null }, '4f9c1f9a-0000-4000-8000-000000000003');
    const owner = new ChatMessageQueue(store, new ChatSessionOperationRegistry());
    const recorder = createTestChatRunRecorder(runtimeRoot, session(), mockSiftConfig());
    const delivery = owner.createDelivery({ recorder, sessionId: 'session-1', requestId: 'admitted', operationKind: 'message', modelPreset: session().modelPreset, forceId });
    store.enqueue('session-1', message('4f9c1f9a-0000-4000-8000-000000000004', 'arrived after force'));
    assert.equal(store.get('session-1', id)?.state, 'pending');
    assert.deepEqual(delivery.initial().map((row) => [row.id, row.deliveredTurn, row.deliveredRequestId]), [[id, 0, 'admitted']]);
    assert.equal(store.state('session-1').force, null);
    assert.deepEqual(store.listPending('session-1').map((row) => row.content), ['arrived after force']);
    assert.throws(() => delivery.initial(), /cancelled/u);
  } finally { closeRuntimeDatabase(); }
});

class EventWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

test('the next actual provider request includes the complete tool batch followed by separate queued users', async () => {
  const captured: JsonObject[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/v1/token/encode' || request.url === '/tokenize') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ count: 500 }));
        return;
      }
      captured.push(JsonObjectSchema.parse(parseJsonValueText(body)));
      sendChatCompletionSse(response, { choices: [{ message: captured.length === 1
        ? { content: '', tool_calls: [
          { id: 'tool-1', type: 'function', function: { name: 'git', arguments: '{"operation":"status"}' } },
          { id: 'tool-2', type: 'function', function: { name: 'git', arguments: '{"operation":"diff"}' } },
        ] }
        : { content: 'finished' } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
    const result = await runTaskLoop({ id: 'provider-queue', question: 'original task' }, {
      ...createMockLoopDefaults('siftkit-provider-queue-'),
      baseUrl, config: mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: baseUrl }] } } }),
      timeoutMs: 5000, maxTurns: 2, minToolCallsBeforeFinish: 0,
      queueDelivery: new CaptureDelivery(),
      mockCommandResults: {
        'git operation="status"': { exitCode: 0, stdout: 'full first result' },
        'git operation="diff"': { exitCode: 0, stdout: 'full second result' },
      },
    });
    assert.equal(result.reason, 'finish');
    assert.equal(captured.length, 2);
    const first = asObjectArray(captured[0]?.messages);
    assert.equal(first.some((message) => message.content === 'queued 1'), false);
    const next = asObjectArray(captured[1]?.messages);
    assert.deepEqual(next.slice(-4).map((message) => message.role), ['tool', 'tool', 'user', 'user']);
    assert.match(String(next.at(-4)?.content), /full first result/u);
    assert.match(String(next.at(-3)?.content), /full second result/u);
    assert.deepEqual(next.slice(-2).map((message) => message.content), ['queued 1', 'queued 2']);
    assert.deepEqual(next.slice(0, first.length), first);
    assert.ok(next.some((message) => String(message.content).includes('original task')));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('queue delivery claims and appends one FIFO snapshot at a post-tool boundary', () => {
  const runtimeRoot = createManagedTempDir('siftkit-queue-delivery-');
  try {
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    saveChatSession(runtimeRoot, session());
    const queue = new ChatMessageQueue(
      new ChatMessageQueueStore(database),
      new ChatSessionOperationRegistry(),
    );
    const firstId = '4f9c1f9a-0000-4000-8000-000000000001';
    const secondId = '4f9c1f9a-0000-4000-8000-000000000002';
    assert.equal(queue.store.enqueue('session-1', message(firstId, 'first')).kind, 'enqueued');
    assert.equal(queue.store.enqueue('session-1', message(secondId, 'second')).kind, 'enqueued');
    const delivery = queue.createDelivery({
      recorder: createTestChatRunRecorder(runtimeRoot, session(), mockSiftConfig()),
      sessionId: 'session-1',
      requestId: 'request-1',
      operationKind: 'message',
      modelPreset: session().modelPreset,
    });
    const transcript = new TranscriptManager({
      systemPromptContent: 'system',
      historyMessages: [],
      initialUserContent: 'task',
      initialUserImages: [],
      liveImagePathKeys: new Set<string>(),
    });

    const delivered = delivery.consume(2, transcript);

    assert.deepEqual(delivered.map((entry) => entry.id), [firstId, secondId]);
    assert.deepEqual(transcript.getMessages().slice(-2).map((entry) => entry.content), ['first', 'second']);
    assert.deepEqual(queue.store.listDelivered('session-1', 'request-1').map((entry) => entry.id), [firstId, secondId]);
  } finally {
    closeRuntimeDatabase();
  }
});

test('task loop delivers queued messages after the complete tool batch before the next request', async () => {
  const delivery = new CaptureDelivery();
  const events: Record<string, JsonSerializable>[] = [];
  const progress = new EventWriter();
  const defaults = createMockLoopDefaults('siftkit-queue-loop-');
  const result = await runTaskLoop(
    { id: 'queue-loop', question: 'inspect the repository' },
    {
      ...defaults,
      maxTurns: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ id: 'tool-1', name: 'git', arguments: { operation: 'status' } }] },
        { content: 'done' },
      ],
      mockCommandResults: { 'git operation="status"': { exitCode: 0, stdout: 'clean' } },
      queueDelivery: delivery,
      progressWriter: progress,
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>): void { events.push(event); },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  const snapshot = delivery.snapshots[0];
  assert.ok(snapshot);
  const visible = snapshot.map((message) => `${message.role}:${String(message.content)}`);
  assert.ok(visible.findIndex((entry) => entry.includes('queued 1')) > visible.findIndex((entry) => entry.includes('clean')));
  assert.ok(visible.findIndex((entry) => entry.includes('queued 2')) > visible.findIndex((entry) => entry.includes('queued 1')));
  assert.ok(progress.events.some((event) => event.kind === 'queued_user_message'));
});
