import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { buildChatRunMessageIdPrefix } from '@siftkit/contracts';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { deleteChatMessage, deleteChatMessageImage, updateChatMessageImageCaption, readChatSessionFromPath, getChatSessionPath, saveChatSession } from '../src/state/chat-sessions.js';
import { importChatSessionBaseline } from '../src/status-server/chat-history-import.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { findPlannerContextViolation } from '../src/repo-search/planner-chat-message.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, asObject, asObjectArray } from './helpers/dashboard-http.js';
import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { buildCompactionSummaryMessage } from '../src/repo-search/engine/transcript-compactor.js';

function savedImageRun() {
  const root = createManagedTempDir('chat-image-purge-');
  const session = createTestChatSession(root);
  const payload = 'data:image/png;base64,AA==';
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject(), {
    operationKind: 'message', content: 'describe image', images: [payload], imageMeta: [],
  });
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'describe image',
    initialUserImages: [payload], liveImagePathKeys: new Set(), contextRecorder: recorder });
  transcript.pushAssistant({ role: 'assistant', content: 'description' });
  recorder.completeAnswer({ content: 'description' });
  return { root, session, recorder, payload, database: getRuntimeDatabase(join(root, 'runtime.sqlite')) };
}

test('saved baseline images receive native identities before privacy deletion', () => {
  const root = createManagedTempDir('chat-baseline-image-');
  const session = createTestChatSession(root);
  const payload = 'data:image/png;base64,AA==';
  session.messages = [{ id: 'legacy-image', role: 'user', kind: 'user_text', content: 'legacy image', images: [payload],
    inputTokensEstimate: 2, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: session.createdAtUtc }];
  saveChatSession(root, session);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  importChatSessionBaseline(database, session, getDefaultConfigObject());
  const before = buildRecoveredChatHistory(database, session.id);
  assert.equal(before.messages[0]?.chatMessageId, 'legacy-image');
  deleteChatMessageImage(root, session.id, 'legacy-image', 0);
  for (const run of new ChatJournalStore(database).listSessionRuns(session.id)) rebuildChatRun(database, run.operationId);
  assert.equal(JSON.stringify(buildRecoveredChatHistory(database, session.id)).includes(payload), false);
});

test('an image projection failure rolls back the payload purge and history revision together', () => {
  const { root, session, recorder, payload, database } = savedImageRun();
  const store = new ChatJournalStore(database);
  const before = store.listSessionRuns(session.id);
  database.exec("CREATE TRIGGER reject_image_update BEFORE UPDATE OF images ON chat_messages BEGIN SELECT RAISE(ABORT, 'image projection unavailable'); END;");
  assert.throws(() => deleteChatMessageImage(root, session.id, recorder.userMessageId, 0), /image projection unavailable/u);
  assert.deepEqual(store.listSessionRuns(session.id), before);
  assert.equal(JSON.stringify([...store.readAll(recorder.operationId)]).includes(payload), true);
  database.exec('DROP TRIGGER reject_image_update');
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  assert.equal(JSON.stringify([...store.readAll(recorder.operationId)]).includes(payload), false);
});

test('deleting an image-bearing message purges its pixels from journal history', () => {
  const { root, session, recorder, payload, database } = savedImageRun();
  assert.ok(deleteChatMessage(root, session.id, recorder.userMessageId));
  assert.equal(JSON.stringify([...new ChatJournalStore(database).readAll(recorder.operationId)]).includes(payload), false);
  database.prepare('DELETE FROM chat_messages WHERE session_id=?').run(session.id);
  rebuildChatRun(database, recorder.operationId);
  assert.equal(JSON.stringify(buildRecoveredChatHistory(database, session.id)).includes(payload), false);
});

test('tool images retain their display owner and deletion purges every native copy', () => {
  const root = createManagedTempDir('chat-tool-image-owner-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const payload = 'data:image/png;base64,AA==';
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target',
    initialUserImages: [], liveImagePathKeys: new Set(), contextRecorder: recorder });
  const call = { toolCallId: 'native', displayToolCallId: 'display', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'read', arguments: { path: 'image.png' }, command: 'read image.png',
    activityKind: 'read', activitySubject: { kind: 'file', value: 'image.png' }, maxTurns: 3, promptTokenCount: 5, executionState: 'proposed' });
  recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output: 'image result', images: [payload], imageMeta: [],
    outputTokens: 3, outputTokensEstimated: true, promptTokenCount: 5, finishedAtUtc: new Date().toISOString() });
  const start = transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: 'image.png' } }, toolCallId: call.toolCallId, toolContent: 'image result' }], '');
  transcript.insertUserAfter(start + 1, 'image', [payload], 'image.png', call.toolCallId);
  transcript.beginTurn(2);
  transcript.pushAssistant({ role: 'assistant', content: 'final' });
  const saved = recorder.completeAnswer({ content: 'final' });
  const tool = saved.messages.find(message => message.kind === 'assistant_tool_call');
  assert.ok(tool);
  assert.deepEqual(tool.images, [payload]);
  deleteChatMessageImage(root, session.id, tool.id, 0);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  rebuildChatRun(database, recorder.operationId);
  assert.equal(JSON.stringify([...new ChatJournalStore(database).readAll(recorder.operationId)]).includes(payload), false);
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(JSON.stringify(history.messages).includes(payload), false);
});

test('deleting one tool exchange cannot delete another exchange with the same native call ID', () => {
  const root = createManagedTempDir('chat-delete-reused-call-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target',
    initialUserImages: [], liveImagePathKeys: new Set(), contextRecorder: recorder });
  for (const turn of [1, 2]) {
    transcript.beginTurn(turn);
    const call = { toolCallId: 'reused-native', displayToolCallId: `display-${turn}`, batchId: `batch-${turn}`, turn, indexInBatch: 0 };
    recorder.recordToolProposed({ call, toolName: 'read', arguments: { path: `file-${turn}` }, command: `read file-${turn}`,
      activityKind: 'read', activitySubject: { kind: 'file', value: `file-${turn}` }, maxTurns: 3, promptTokenCount: 5, executionState: 'proposed' });
    recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output: `result-${turn}`, images: [], imageMeta: [],
      outputTokens: 3, outputTokensEstimated: true, promptTokenCount: 5, finishedAtUtc: new Date().toISOString() });
    transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: `file-${turn}` } }, toolCallId: call.toolCallId, toolContent: `result-${turn}` }], '');
  }
  transcript.pushAssistant({ role: 'assistant', content: 'final' });
  const saved = recorder.completeAnswer({ content: 'final' });
  const second = saved.messages?.find(message => message.kind === 'assistant_tool_call' && message.toolCallCommand === 'read file-2');
  assert.ok(second);
  deleteChatMessage(root, session.id, second.id);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.deepEqual(history.messages.filter(message => message.role === 'tool').map(message => message.content), ['result-1']);
  assert.equal(findPlannerContextViolation(history.messages), null);
});

test('compaction records exactly which current-run tool rows left native history', () => {
  const root = createManagedTempDir('chat-tool-compaction-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target',
    initialUserImages: [], liveImagePathKeys: new Set(), contextRecorder: recorder });
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'read', arguments: { path: 'file' }, command: 'read file',
    activityKind: 'read', activitySubject: { kind: 'file', value: 'file' }, maxTurns: 3, promptTokenCount: 5, executionState: 'proposed' });
  recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output: 'full old output', images: [], imageMeta: [],
    outputTokens: 3, outputTokensEstimated: true, promptTokenCount: 5, finishedAtUtc: new Date().toISOString() });
  transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: 'file' } }, toolCallId: call.toolCallId, toolContent: 'full old output' }], '');
  transcript.replaceWith([buildCompactionSummaryMessage('summary replaces the old tool')], null);
  transcript.beginTurn(2);
  transcript.pushAssistant({ role: 'assistant', content: 'final' });
  const saved = recorder.completeAnswer({ content: 'final' });
  const toolIndex = saved.messages?.findIndex(message => message.kind === 'assistant_tool_call') ?? -1;
  const summaryIndex = saved.messages?.findIndex(message => message.kind === 'compaction_summary') ?? -1;
  assert.ok(toolIndex >= 0);
  assert.equal(saved.messages?.[toolIndex]?.compressedIntoSummary, true);
  assert.ok(summaryIndex > toolIndex);
  const recovered = buildRecoveredChatHistory(getRuntimeDatabase(join(root, 'runtime.sqlite')), session.id);
  assert.equal(recovered.messages.some(message => message.role === 'tool'), false);
});

test('manual condense survives losing every display row and retains only the summary for continuation', async t => {
  const harness = await startHarness('chat-condense-rebuild-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'condense' }) });
  const sessionId = String(asObject(created.body.session).id);
  await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, { method: 'POST',
    body: JSON.stringify({ content: 'original detailed question', assistantContent: 'original detailed answer' }) });
  const condensed = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/condense`, { method: 'POST',
    body: JSON.stringify({ mockResponses: [{ content: 'durable summary' }] }) });
  assert.equal(condensed.statusCode, 200);
  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  database.prepare('DELETE FROM chat_messages WHERE session_id=?').run(sessionId);
  const rebuilt = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  const messages = asObjectArray(asObject(rebuilt.body.session).messages);
  assert.equal(messages.filter(message => message.kind === 'compaction_summary' && message.content === 'durable summary').length, 1);
  assert.equal(messages.filter(message => String(message.content).startsWith('original detailed')).length, 2);
  assert.equal(messages.filter(message => String(message.content).startsWith('original detailed')).every(message => message.compressedIntoSummary === true), true);
  assert.equal(messages.some(message => message.role === 'user' && message.content === ''), false);
  const history = buildRecoveredChatHistory(database, sessionId);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(history.messages.length, 1);
  assert.match(String(history.messages[0]?.content), /durable summary/u);
});

test('answer-only streaming shares its native message identity and is not recovered as duplicate partial text', () => {
  const root = createManagedTempDir('chat-answer-only-identity-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target',
    initialUserImages: [], liveImagePathKeys: new Set(), contextRecorder: recorder });
  transcript.pushAssistant({ role: 'assistant', content: 'answer without narration' });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'answer without narration' } });
  recorder.completeAnswer({ content: 'answer without narration' });
  const history = buildRecoveredChatHistory(getRuntimeDatabase(join(root, 'runtime.sqlite')), session.id);
  assert.equal(history.status, 'ok');
  assert.equal(history.messages.filter(message => message.role === 'assistant').length, 1);
  assert.deepEqual(history.interruptionNotices, []);
});

test('image removal purges durable payloads and survives display and native-context rebuilds', () => {
  const root = createManagedTempDir('chat-image-purge-');
  const session = createTestChatSession(root);
  const removed = 'data:image/png;base64,AAAA';
  const retained = 'data:image/png;base64,BBBB';
  const metadata = { width: 1, height: 1, originalWidth: 1, originalHeight: 1, mime: 'image/png', byteLength: 3, tokenEstimate: 1, resized: false, caption: null } as const;
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject(), {
    operationKind: 'message', content: 'compare these images', images: [removed, retained], imageMeta: [metadata, metadata],
  });
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'compare these images',
    initialUserImages: [removed, retained], liveImagePathKeys: new Set(), contextRecorder: recorder });
  transcript.pushAssistant({ role: 'assistant', content: 'comparison' });
  recorder.completeAnswer({ content: 'comparison' });
  updateChatMessageImageCaption(root, session.id, recorder.userMessageId, 0, 'removed image caption');
  updateChatMessageImageCaption(root, session.id, recorder.userMessageId, 1, 'retained image caption');
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  rebuildChatRun(database, recorder.operationId);
  const saved = readChatSessionFromPath(getChatSessionPath(root, session.id));
  assert.deepEqual(saved?.messages?.find(message => message.id === recorder.userMessageId)?.images, [retained]);
  assert.equal(saved?.messages?.find(message => message.id === recorder.userMessageId)?.imageMeta?.[0]?.caption, 'retained image caption');
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(JSON.stringify(history.messages).includes(removed), false);
  assert.equal(JSON.stringify(history.messages).includes(retained), true);
  const source = new ChatJournalStore(database).readAfter(recorder.operationId, 0, 500);
  assert.equal(JSON.stringify(source).includes(removed), false, 'tombstones must also remove the payload from source evidence');
  database.prepare("UPDATE chat_run_events SET payload_digest='corrupt' WHERE kind='history_revised'").run();
  assert.throws(() => rebuildChatRun(database, recorder.operationId), /corrupt|digest/u);
});

test('an active transcript applies image deletion before its next retention and model boundary', () => {
  const root = createManagedTempDir('chat-live-image-removal-');
  const session = createTestChatSession(root);
  const removed = 'data:image/png;base64,AAAA';
  const retained = 'data:image/png;base64,BBBB';
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject(), {
    operationKind: 'message', content: 'compare', images: [removed, retained], imageMeta: [],
  });
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages: [], initialUserContent: 'compare',
    initialUserImages: [removed, retained], liveImagePathKeys: new Set(), contextRecorder: recorder });
  recorder.readSession();
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  transcript.pruneImages(2);
  assert.equal(JSON.stringify(transcript.getMessages()).includes(removed), false);
  assert.equal(JSON.stringify(transcript.getMessages()).includes(retained), true);
  transcript.pruneImages(2);
  assert.equal(JSON.stringify(transcript.getMessages()).includes(retained), true, 'a revision is applied once');
});

test('deleting batch narration preserves its native calls and their results', () => {
  const root = createManagedTempDir('chat-retention-batch-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({
    systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target', initialUserImages: [],
    liveImagePathKeys: new Set(), contextRecorder: recorder,
  });
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, text: 'private narration', offset: 0 } });
  const call = { toolCallId: 'call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'read', arguments: { path: 'file' }, command: 'read file',
    activityKind: 'read', activitySubject: { kind: 'file', value: 'file' }, maxTurns: 3, promptTokenCount: 5, executionState: 'proposed' });
  recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output: 'result', images: [], imageMeta: [],
    outputTokens: 3, outputTokensEstimated: true, promptTokenCount: 5, finishedAtUtc: new Date().toISOString() });
  transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: 'file' } }, toolCallId: 'call', toolContent: 'result' }], '', 'private narration');
  transcript.beginTurn(2);
  transcript.pushAssistant({ role: 'assistant', content: 'final answer' });
  const saved = recorder.completeAnswer({ content: 'final answer' });
  const narration = saved.messages?.find(message => message.content === 'private narration');
  assert.ok(narration);
  assert.ok(deleteChatMessage(root, session.id, narration.id));
  const history = buildRecoveredChatHistory(getRuntimeDatabase(join(root, 'runtime.sqlite')), session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(findPlannerContextViolation(history.messages), null);
  assert.equal(history.messages.some(message => message.tool_call_id === 'call' && message.content === 'result'), true);
  assert.equal(JSON.stringify(history.messages).includes('private narration'), false);
});

for (const streamed of [false, true]) test(`deleting an answer removes the completed native message (streamed=${streamed})`, () => {
  const root = createManagedTempDir('chat-retention-stream-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({
    systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target', initialUserImages: [],
    liveImagePathKeys: new Set(), contextRecorder: recorder,
  });
  if (streamed) recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, text: 'answer to remove', offset: 0 } });
  transcript.pushAssistant({ role: 'assistant', content: 'answer to remove' });
  if (streamed) recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, text: 'answer to remove', offset: 0 } });
  const saved = recorder.completeAnswer({ content: 'answer to remove' });
  const answer = saved.messages?.find(message => message.kind === 'assistant_answer');
  assert.ok(answer);
  assert.ok(deleteChatMessage(root, session.id, answer.id));
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(history.messages.some(message => message.role === 'user'), true);
  assert.equal(JSON.stringify(history.messages).includes('answer to remove'), false);
});

test('deleting an admitted user message removes its native transcript without removing the answer', () => {
  const root = createManagedTempDir('chat-retention-user-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const transcript = new TranscriptManager({
    systemPromptContent: 'system', historyMessages: [], initialUserContent: 'find target', initialUserImages: [],
    liveImagePathKeys: new Set(), contextRecorder: recorder,
  });
  transcript.pushAssistant({ role: 'assistant', content: 'retained answer' });
  const saved = recorder.completeAnswer({ content: 'retained answer' });
  const user = saved.messages?.find(message => message.role === 'user');
  assert.ok(user);
  assert.ok(deleteChatMessage(root, session.id, user.id));
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(history.messages.some(message => message.role === 'user'), false);
  assert.equal(history.messages.some(message => message.content === 'retained answer'), true);
});

test('deleted answer stays absent from display rebuild and retained model context', () => {
  const root = createManagedTempDir('chat-retention-delete-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const answerId = `${buildChatRunMessageIdPrefix(recorder.operationId)}-answer-final`;
  recorder.recordContextInitialized({ messages: [
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'removed answer', chatMessageId: answerId },
  ], contextRevision: 0, turnBoundary: 0 });
  recorder.completeAnswer({ content: 'removed answer' });
  assert.ok(deleteChatMessage(root, session.id, answerId));
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  rebuildChatRun(database, recorder.operationId);
  assert.equal(readChatSessionFromPath(getChatSessionPath(root, session.id))?.messages?.some(message => message.id === answerId), false);
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(JSON.stringify(history.messages).includes('removed answer'), false);
  assert.deepEqual(history.messages, [{ role: 'user', content: 'question' }]);
});
