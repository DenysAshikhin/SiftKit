import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { deleteChatMessageImage, saveChatSession, type ChatSession } from '../src/state/chat-sessions.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import type { ChatMessage } from '../src/repo-search/planner-chat-message.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { buildCompactionSummaryMessage } from '../src/repo-search/engine/transcript-compactor.js';
import { buildUserContent } from '../src/llm-protocol/image-attachments.js';

const IMAGE_A = 'data:image/png;base64,AAAA';
const IMAGE_B = 'data:image/png;base64,BBBB';
const IMAGE_C = 'data:image/png;base64,CCCC';

function liveImageRun(
  images: readonly string[],
  historyMessages: readonly ChatMessage[] = [],
  session: ChatSession = createTestChatSession(createManagedTempDir('chat-live-image-')),
) {
  const root = session.planRepoRoot;
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject(), {
    operationKind: 'message', content: 'compare', images: [...images], imageMeta: [],
  });
  const transcript = new TranscriptManager({ systemPromptContent: 'system', historyMessages, initialUserContent: 'compare',
    initialUserImages: images, liveImagePathKeys: new Set(), contextRecorder: recorder });
  recorder.readSession();
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  return { root, session, recorder, transcript, database, store: new ChatJournalStore(database) };
}

function imagesOf(messages: readonly ChatMessage[], chatMessageId: string): string[] {
  const message = messages.find(candidate => candidate.chatMessageId === chatMessageId && Array.isArray(candidate.content));
  if (!message || !Array.isArray(message.content)) throw new Error(`No image-bearing message ${chatMessageId}`);
  return message.content.flatMap(part => part.type === 'image_url' && part.image_url ? [part.image_url.url] : []);
}

function pruneAfterNewThinking(transcript: TranscriptManager): void {
  transcript.beginTurn(2);
  transcript.pushAssistant({ role: 'assistant', content: 'next', reasoning_content: 'new thinking' });
  transcript.pruneThinking(false);
}

function latestSplice(store: ChatJournalStore, operationId: string) {
  const latest = [...store.readAll(operationId)].at(-1);
  if (latest?.event.kind !== 'context_spliced') throw new Error('Expected the latest event to be a context splice.');
  return latest.event;
}

test('a deletion during a live transcript is not reintroduced by later thinking pruning', () => {
  const { root, session, recorder, transcript, database, store } = liveImageRun([IMAGE_A, IMAGE_B]);
  transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'old thinking' });
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  pruneAfterNewThinking(transcript);
  assert.equal(JSON.stringify([...store.readAll(recorder.operationId)]).includes(IMAGE_A), false);
  const history = buildRecoveredChatHistory(database, session.id);
  assert.equal(JSON.stringify(history).includes(IMAGE_A), false);
  assert.deepEqual(imagesOf(transcript.getMessages(), recorder.userMessageId), [IMAGE_B]);
  assert.deepEqual(imagesOf(history.messages, recorder.userMessageId), [IMAGE_B]);
  assert.equal(transcript.getMessages().at(-1)?.reasoning_content, 'new thinking');
  assert.equal(transcript.getMessages().filter(message => message.reasoning_content !== undefined).length, 1);
  assert.equal(transcript.contextRevision, 3);
});

test('a compaction replacement captured before a deletion commits only the surviving attachment', () => {
  const { root, session, recorder, transcript, database, store } = liveImageRun([IMAGE_A, IMAGE_B]);
  const captured = [...transcript.getMessages()];
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  transcript.replaceWith([...captured, buildCompactionSummaryMessage('summary')], null);
  const compaction = [...store.readAll(recorder.operationId)]
    .find(envelope => envelope.event.kind === 'context_spliced' && envelope.event.reason === 'compacted');
  assert.ok(compaction);
  assert.equal(JSON.stringify(compaction).includes(IMAGE_A), false);
  assert.deepEqual(imagesOf(transcript.getMessages(), recorder.userMessageId), [IMAGE_B]);
  assert.equal(transcript.getMessages().length, captured.length + 1);
  assert.equal(JSON.stringify(buildRecoveredChatHistory(database, session.id)).includes(IMAGE_A), false);
});

for (const [deleted, expected] of [[0, [IMAGE_B, IMAGE_C]], [1, [IMAGE_A, IMAGE_C]], [2, [IMAGE_A, IMAGE_B]]] as const) {
  test(`deleting attachment ${String(deleted)} keeps its siblings in order through later context writes`, () => {
    const { root, session, recorder, transcript, store } = liveImageRun([IMAGE_A, IMAGE_B, IMAGE_C]);
    transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'old thinking' });
    deleteChatMessageImage(root, session.id, recorder.userMessageId, deleted);
    pruneAfterNewThinking(transcript);
    assert.deepEqual(imagesOf(transcript.getMessages(), recorder.userMessageId), [...expected]);
    assert.deepEqual(imagesOf(latestSplice(store, recorder.operationId).inserted, recorder.userMessageId), [...expected]);
  });
}

test('deleting one of two identical attachments keeps exactly one surviving copy', () => {
  const { root, session, recorder, transcript, store } = liveImageRun([IMAGE_A, IMAGE_A]);
  transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'old thinking' });
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  pruneAfterNewThinking(transcript);
  assert.deepEqual(imagesOf(transcript.getMessages(), recorder.userMessageId), [IMAGE_A]);
  assert.deepEqual(imagesOf(latestSplice(store, recorder.operationId).inserted, recorder.userMessageId), [IMAGE_A]);
});

test('a deletion by display index removes the right sibling when retention already aged an earlier part out', () => {
  const root = createManagedTempDir('chat-live-image-retention-');
  const session = createTestChatSession(root);
  session.messages = [{ id: 'legacy-image', role: 'user', kind: 'user_text', content: 'legacy', images: [IMAGE_A, IMAGE_B, IMAGE_C],
    inputTokensEstimate: 2, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: session.createdAtUtc }];
  saveChatSession(root, session);
  // Live retention already dropped IMAGE_A; the display row still shows all three.
  const aged: ChatMessage = { role: 'user', content: buildUserContent('legacy', [IMAGE_B, IMAGE_C]), chatMessageId: 'legacy-image' };
  const { recorder, transcript, store } = liveImageRun([], [aged], session);
  transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'old thinking' });
  deleteChatMessageImage(root, session.id, 'legacy-image', 0);
  pruneAfterNewThinking(transcript);
  assert.deepEqual(imagesOf(transcript.getMessages(), 'legacy-image'), [IMAGE_B, IMAGE_C]);
  assert.deepEqual(imagesOf(latestSplice(store, recorder.operationId).inserted, 'legacy-image'), [IMAGE_B, IMAGE_C]);
  deleteChatMessageImage(root, session.id, 'legacy-image', 0);
  transcript.reconcileHistory();
  assert.deepEqual(imagesOf(transcript.getMessages(), 'legacy-image'), [IMAGE_C]);
  assert.deepEqual(imagesOf(latestSplice(store, recorder.operationId).inserted, 'legacy-image'), [IMAGE_C]);
});

test('a deleted tool image cannot return through later context writes while unrelated owners keep theirs', () => {
  const { root, session, recorder, transcript, store } = liveImageRun([IMAGE_C]);
  const call = { toolCallId: 'native', displayToolCallId: 'display', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'read', arguments: { path: 'image.png' }, command: 'read image.png',
    activityKind: 'read', activitySubject: { kind: 'file', value: 'image.png' }, maxTurns: 3, promptTokenCount: 5, executionState: 'proposed' });
  recorder.recordToolResult({ call, executionState: 'completed', exitCode: 0, output: 'image result', images: [IMAGE_A, IMAGE_B], imageMeta: [],
    outputTokens: 3, outputTokensEstimated: true, promptTokenCount: 5, finishedAtUtc: new Date().toISOString() });
  const start = transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: 'image.png' } }, toolCallId: call.toolCallId, toolContent: 'image result' }], 'old thinking');
  transcript.insertUserAfter(start + 1, 'image', [IMAGE_A, IMAGE_B], 'image.png', call.toolCallId);
  const toolMessageId = recorder.resolveToolMessageId(call.toolCallId);
  assert.ok(toolMessageId);
  recorder.readSession();
  deleteChatMessageImage(root, session.id, toolMessageId, 1);
  pruneAfterNewThinking(transcript);
  assert.deepEqual(imagesOf(transcript.getMessages(), toolMessageId), [IMAGE_A]);
  assert.deepEqual(imagesOf(transcript.getMessages(), recorder.userMessageId), [IMAGE_C]);
  const splice = latestSplice(store, recorder.operationId);
  assert.deepEqual(imagesOf(splice.inserted, toolMessageId), [IMAGE_A]);
  assert.deepEqual(imagesOf(splice.inserted, recorder.userMessageId), [IMAGE_C]);
  assert.equal(JSON.stringify(splice).includes(IMAGE_B), false);
});

test('a context write carrying a deleted payload without a display owner fails instead of guessing', () => {
  const { root, session, recorder, transcript } = liveImageRun([IMAGE_A]);
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  assert.throws(() => transcript.pushUser('orphan', [IMAGE_A]), /display owner/u);
  assert.equal(JSON.stringify(transcript.getMessages()).includes('orphan'), false);
});

test('a failed context append leaves the live transcript and journal unchanged', () => {
  const { root, session, recorder, transcript, database, store } = liveImageRun([IMAGE_A, IMAGE_B]);
  transcript.pushAssistant({ role: 'assistant', content: 'first', reasoning_content: 'old thinking' });
  deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
  const before = [...transcript.getMessages()];
  const sequenceBefore = store.readRun(recorder.operationId)?.latestSequence;
  database.exec("CREATE TRIGGER reject_context BEFORE INSERT ON chat_run_events WHEN NEW.kind='context_spliced' BEGIN SELECT RAISE(ABORT, 'context append unavailable'); END;");
  assert.throws(() => pruneAfterNewThinking(transcript), /context append unavailable/u);
  database.exec('DROP TRIGGER reject_context');
  assert.deepEqual(transcript.getMessages(), before);
  assert.equal(store.readRun(recorder.operationId)?.latestSequence, sequenceBefore);
});
