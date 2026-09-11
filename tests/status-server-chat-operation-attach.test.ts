import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';
import { requestJson, asObject } from './helpers/dashboard-http.js';
import { readChatStream } from './helpers/chat-stream-views.js';
import { ChatOperationProjection } from '../dashboard/src/lib/chat-operation-projection.js';
import { ChatStreamReader } from '../dashboard/src/lib/chat-stream-parser.js';
import { ImageMetadataSchema, type ImageMetadata } from '@siftkit/contracts';
import { closeAllRuntimeDatabases, getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { ChatRuntimeOwnerSchema } from '../src/state/chat-runtime-owner.js';
import { deleteChatMessageImage, getChatSessionPath, readChatSessionFromPath, saveChatSession } from '../src/state/chat-sessions.js';
import { getRuntimeRoot, getConfigPath } from '../src/status-server/paths.js';
import { getDefaultConfig, readConfig } from '../src/status-server/config-store.js';
import { ChatRunRecorder, buildChatRunSettings } from '../src/status-server/chat-run-recorder.js';
import { ChatOperationSseSubscriber } from '../src/status-server/chat-operation-sse-subscriber.js';
import { SseResponseWriter } from '../src/status-server/sse-response-writer.js';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

/** One attach read to EOF, assembled the way the browser assembles it. */
async function attach(harness: StreamedOperationHarness, sessionId: string) {
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  assert.equal(response.status, 200);
  const body = await response.text();
  const events = new SseFrameParser().push(body).map(frame => ({ event: frame.event, payload: asObject(JSON.parse(frame.data)), receivedAtMs: 0 }));
  return { body, ...readChatStream({ statusCode: response.status, events }, sessionId) };
}

function begin(sessionId: string, userMessageId = randomUUID(), images: string[] = [], imageMeta: ImageMetadata[] = []) {
  const session = readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId));
  assert.ok(session);
  const databasePath = getRuntimeDatabasePath();
  const owner = ChatRuntimeOwnerSchema.parse(getRuntimeDatabase(databasePath).prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  return ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
    operationId: randomUUID(), sessionId, ownerEpoch: `${owner.owner_id}:${owner.epoch}`, operationKind: 'repo-agent',
    userMessageId, content: 'accepted prompt', images, imageMeta, retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(), settings: buildChatRunSettings({ session, config: readConfig(getConfigPath()),
      operationKind: 'repo-agent', presetId: 'repo-agent', repoRoot: session.planRepoRoot, approval: 'interactive', maxTurns: 20, webSearchEnabled: false }),
  });
}

test('the real subscriber and dashboard assembler reject an image-bearing transfer revised mid-drain', async t => {
  const root = createManagedTempDir('chat-attach-slow-image-delete-real-');
  const context = createTestServerContext(`${root}/config.json`, root);
  const session = createTestChatSession(root);
  session.id = 'slow-delete-session';
  session.modelPreset = mockModelPreset();
  session.modelPresetId = session.modelPreset.id;
  const image = toDataUrl('image/png', rasterBuffer('png', 1, 1));
  const imageMeta = ImageMetadataSchema.parse({ width: 1, height: 1, originalWidth: 1, originalHeight: 1,
    mime: 'image/png', byteLength: 1, tokenEstimate: 1, resized: false, caption: null });
  const userMessageId = randomUUID();
  session.messages = [{ id: userMessageId, role: 'user', kind: 'user_text', content: 'image prompt',
    inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: session.createdAtUtc,
    images: [image], imageMeta: [imageMeta] }];
  saveChatSession(root, session);
  const operationId = randomUUID();
  const acquired = context.chatSessionOperations.acquire(session.id, 'repo-agent', operationId, Date.now());
  assert.equal(acquired.kind, 'acquired');
  const lease = acquired.lease;
  const recorder = ChatRunRecorder.begin(context.runtimeDatabase, {
    operationId, sessionId: session.id, ownerEpoch: context.chatRunOwnerEpoch, operationKind: 'repo-agent',
    userMessageId, content: 'image prompt', images: [image], imageMeta: [imageMeta], retainedHistoryRevision: 0,
    startedAtUtc: session.createdAtUtc, settings: buildChatRunSettings({ session, config: getDefaultConfig(),
      operationKind: 'repo-agent', presetId: 'repo-agent', repoRoot: session.planRepoRoot, approval: 'off', maxTurns: 20, webSearchEnabled: false }),
  });
  lease.recorder = recorder;
  for (let turn = 1; turn <= 140; turn += 1) {
    recorder.recordDisplay({ kind: 'narration', delta: { turn, offset: 0, text: 'x'.repeat(64 * 1024) } });
  }
  const broadcast = context.chatSessionOperations.getBroadcast(session.id);
  assert.ok(broadcast);
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res);
    writer.open();
    const subscriber = new ChatOperationSseSubscriber(writer, { ctx: context, sessionId: session.id, operationId, database: context.runtimeDatabase });
    broadcast.attach(subscriber);
    subscriber.start();
    res.on('close', () => broadcast.detach(subscriber));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeAllRuntimeDatabases();
    assert.equal(await removeDirectoryWithRetries(root), true);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/operation/stream`);
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body);
  const stream = new ChatStreamReader(body.getReader());
  const projection = new ChatOperationProjection(session.id);
  let imageBearingViewPublished = false;
  let firstFrame = true;
  for await (const event of stream.events()) {
    if (event.kind !== 'projection') continue;
    if (firstFrame) {
      firstFrame = false;
      deleteChatMessageImage(root, session.id, userMessageId, 0);
      broadcast.notifyHistoryRevised();
      recorder.finish({ terminalCause: 'user_stop', detail: null, usage: null, recoveryStatus: 'recovery_needed' });
      assert.equal(context.chatSessionOperations.finish(lease, { kind: 'completed' }), true);
    }
    const delivery = projection.acceptFrame(event.frame);
    if (delivery?.kind === 'view' && delivery.snapshot.messages.some(message => message.images?.includes(image) === true)) {
      imageBearingViewPublished = true;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }

  const snapshot = projection.snapshot;
  assert.ok(snapshot);
  assert.equal(imageBearingViewPublished, false, 'a stale transfer must not publish the deleted image');
  assert.equal(snapshot.messages.some(message => message.images?.includes(image) === true), false);
  assert.equal(snapshot.terminalCause, 'user_stop');
});

test('attach reports the exact corrupt journal identity without echoing source payloads', async t => {
  const harness = await startHarness('chat-attach-corruption-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'corruption' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'NEVER_ECHO_SECRET_PAYLOAD' } });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  getRuntimeDatabase().prepare('UPDATE chat_run_events SET version=999 WHERE operation_id=? AND sequence=2').run(recorder.operationId);
  const { body, views, terminal, failure } = await attach(harness, sessionId);
  assert.ok(failure);
  assert.equal(failure.issue?.code, 'unknown_event_version');
  assert.equal(failure.issue?.operationId, recorder.operationId);
  assert.equal(failure.issue?.sequence, 2);
  assert.match(failure.error, /unknown_event_version/u);
  assert.doesNotMatch(body, /NEVER_ECHO_SECRET_PAYLOAD/u);
  assert.deepEqual(views, []);
  assert.equal(terminal, null);
});

test('attach returns accepted content and partial output from a terminal journal with no active lease', async t => {
  const harness = await startHarness('chat-attach-terminal-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'attach' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial answer' } });
  recorder.finish({ terminalCause: 'user_stop', detail: null, usage: null, recoveryStatus: 'ok' });
  const { views, terminal, failure } = await attach(harness, sessionId);
  assert.equal(failure, null);
  const snapshot = views[0]?.snapshot;
  assert.ok(snapshot);
  assert.equal(views.length, 1);
  assert.equal(snapshot.operationId, recorder.operationId);
  assert.equal(snapshot.terminalCause, 'user_stop');
  assert.deepEqual(snapshot.messages.map(message => message.content), ['accepted prompt', 'partial answer']);
  assert.equal(snapshot.approval, null);
  assert.equal(terminal?.terminalCause, 'user_stop');
  assert.deepEqual(terminal?.cursor, { ...snapshot.cursor, historyRevision: 0 });
});

test('attach reads durable approval outcome instead of replaying a stale approval card', async t => {
  const harness = await startHarness('chat-attach-approval-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'approval' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  const runId = randomUUID();
  recorder.bindEngine({ requestId: randomUUID(), repoAgentSessionId: runId });
  const approvalId = randomUUID();
  const at = new Date().toISOString();
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 20, promptTokenCount: 0, executionState: 'pending_approval' });
  recorder.recordApprovalRequested({ call, approvalId, toolName: 'run', command: 'work', reviewPayload: null,
    mode: 'interactive', requestedAtUtc: at, expiresAtUtc: new Date(Date.parse(at) + 600_000).toISOString() });
  recorder.recordApprovalResolved({ approvalId, outcome: 'denied', decision: { decision: 'deny', reason: 'no' }, reason: 'no', decidedAtUtc: at });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  const { views, terminal } = await attach(harness, sessionId);
  const snapshot = views.at(-1)?.snapshot;
  assert.ok(snapshot);
  assert.equal(terminal?.terminalCause, 'completed');
  assert.equal(snapshot.approval?.approvalId, approvalId);
  assert.equal(snapshot.approval?.outcome, 'denied');
  assert.equal(snapshot.approval?.actionable, false);
  assert.ok(snapshot.messages.some(message => message.kind === 'repo_agent_approval' && message.approvalDecision === 'deny'));
});

test('attach does not invent a run for a session with no accepted operation', async t => {
  const harness = await startHarness('chat-attach-empty-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'empty' }) });
  const sessionId = String(asObject(created.body.session).id);
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`);
  assert.equal(response.status, 404);
});
