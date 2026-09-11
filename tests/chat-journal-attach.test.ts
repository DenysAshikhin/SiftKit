import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { ChatOperationSnapshotSchema } from '@siftkit/contracts';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { ChatOperationSnapshotReader, pageChatOperationSnapshot, diffChatOperationSnapshots } from '../src/status-server/chat-operation-snapshot.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { ChatStreamProgressWriter } from '../src/status-server/chat-stream-progress-writer.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { recordChatHistoryRevision } from '../src/state/chat-history-revisions.js';

const NO_LIVE_BINDING = { approval: null, controlOperationId: null };

function fixture() {
  const root = createManagedTempDir('chat-journal-attach-');
  const at = new Date().toISOString();
  saveChatSession(root, {
    id: 'session', title: 'Attach', modelPresetId: 'model', modelPreset: mockModelPreset(),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: at, updatedAtUtc: at, messages: [],
  });
  const databasePath = join(root, 'runtime.sqlite');
  const recorder = ChatRunRecorder.begin(databasePath, {
    operationId: randomUUID(), sessionId: 'session', ownerEpoch: 'test-owner', operationKind: 'repo-agent',
    userMessageId: 'accepted-user', content: 'Find the answer', images: [], imageMeta: [], retainedHistoryRevision: 0,
    startedAtUtc: at, settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'model', model: 'mock', repoRoot: 'C:/repo',
      approval: 'interactive', maxTurns: 200, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
    },
  });
  return { recorder, database: getRuntimeDatabase(databasePath), reader: new ChatOperationSnapshotReader(recorder.operationId) };
}

test('snapshot paging retains more than 8 MiB and freezes the committed high-water view', () => {
  const { recorder, database, reader } = fixture();
  const text = 'x'.repeat(64 * 1024);
  for (let turn = 1; turn <= 130; turn++) recorder.recordDisplay({ kind: 'narration', delta: { turn, offset: 0, text } });
  const snapshot = reader.capture(database, NO_LIVE_BINDING);
  const highWater = snapshot.cursor.sequence;
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 131, offset: 0, text: 'after snapshot' } });
  const pages = [...pageChatOperationSnapshot(snapshot, 7)].map(page => ChatOperationSnapshotSchema.parse(page));
  assert.equal(pages.at(-1)?.complete, true);
  assert.ok(pages.slice(0, -1).every(page => !page.complete));
  assert.ok(pages.every(page => page.cursor.sequence === highWater && page.messages.length <= 7));
  assert.deepEqual(pages.map(page => page.messageOffset), pages.map((_, index) => index * 7));
  const messages = pages.flatMap(page => page.messages);
  assert.equal(messages.length, 131);
  assert.equal(new Set(messages.map(message => message.id)).size, 131);
  assert.equal(messages.filter(message => message.kind === 'assistant_narration').map(message => message.content).join('').length, 130 * text.length);
  assert.equal(messages.some(message => message.content === 'after snapshot'), false);
  assert.equal(reader.capture(database, NO_LIVE_BINDING).cursor.sequence, highWater + 1);
});

test('finished snapshots survive without a live registry and preserve uncertain tool state', () => {
  const { recorder, database, reader } = fixture();
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'file', value: 'a.ts' }, maxTurns: 200, promptTokenCount: 0, executionState: 'proposed' });
  recorder.recordToolStarted({ call, startedAtUtc: new Date().toISOString() });
  recorder.finish({ terminalCause: 'server_restart', detail: null, usage: null, recoveryStatus: 'recovery_needed' });
  const snapshot = reader.capture(database, NO_LIVE_BINDING);
  assert.equal(snapshot.terminalCause, 'server_restart');
  assert.equal(snapshot.status, 'recovery_needed');
  assert.equal(snapshot.tools[0]?.executionState, 'uncertain');
  assert.equal(snapshot.tools[0]?.toolCallId, call.toolCallId);
  assert.deepEqual(reader.capture(database, NO_LIVE_BINDING), snapshot);
});

test('approval snapshot retains its original deadline and only its exact live binding is actionable', () => {
  const { recorder, database, reader } = fixture();
  const runId = randomUUID();
  recorder.bindEngine({ requestId: 'request', repoAgentSessionId: runId });
  const requestedAtUtc = '2026-09-10T12:00:00.000Z';
  const expiresAtUtc = '2026-09-10T12:10:00.000Z';
  const approvalId = randomUUID();
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'file', value: 'a.ts' }, maxTurns: 200, promptTokenCount: 0, executionState: 'pending_approval' });
  recorder.recordApprovalRequested({ call, approvalId, toolName: 'run', command: 'work', reviewPayload: null,
    mode: 'interactive', requestedAtUtc, expiresAtUtc });
  const binding = { approval: { runId, approvalId }, controlOperationId: randomUUID() };
  const now = Date.parse(requestedAtUtc) + 1;
  assert.equal(reader.capture(database, binding, now).controlOperationId, binding.controlOperationId);
  assert.equal(reader.capture(database, binding, now).approval?.actionable, true);
  assert.equal(reader.capture(database, NO_LIVE_BINDING, now).approval?.actionable, false);
  assert.equal(reader.capture(database, { approval: { runId: randomUUID(), approvalId }, controlOperationId: binding.controlOperationId }, now).approval?.actionable, false);
  const expired = reader.capture(database, binding, Date.parse(expiresAtUtc));
  assert.equal(expired.approval?.actionable, false);
  assert.equal(expired.approval?.expiresAtUtc, expiresAtUtc);
  recorder.recordApprovalResolved({ approvalId, outcome: 'denied', decision: { decision: 'deny', reason: 'no' }, reason: 'no', decidedAtUtc: expiresAtUtc });
  const resolved = reader.capture(database, binding, now);
  assert.equal(resolved.approval?.outcome, 'denied');
  assert.equal(resolved.approval?.actionable, false);
});

test('prompt measurements and warnings survive reconnect without private model context', () => {
  const { recorder, database, reader } = fixture();
  const writer = new ChatStreamProgressWriter({ writeEvent: () => {} }, null, true, recorder);
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'system', content: 'PRIVATE MODEL POLICY' }] });
  writer.write({ kind: 'prompt', turn: 1, maxTurns: 200, promptTokens: 1234, charsPerToken: 3.5, elapsedMs: 1 });
  writer.write({ kind: 'context_warning', warningText: 'Context is nearly full.', elapsedMs: 2 });
  const snapshot = reader.capture(database, NO_LIVE_BINDING);
  assert.equal(snapshot.tokenTurns[0]?.prompt?.promptTokens, 1234);
  assert.deepEqual(snapshot.warnings, ['Context is nearly full.']);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE MODEL POLICY'), false);
});

test('updates cover the committed cursor range and send only changed message bodies', () => {
  const { recorder, database, reader } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'stable narration' } });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: 0, text: 'partial' } });
  const before = reader.capture(database, NO_LIVE_BINDING);
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'system', content: 'private' }] });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: 7, text: ' answer' } });
  const after = reader.capture(database, NO_LIVE_BINDING);
  const update = diffChatOperationSnapshots(before, after);
  assert.equal(update.afterSequence, before.cursor.sequence);
  assert.equal(update.cursor.sequence, before.cursor.sequence + 2);
  assert.deepEqual(update.messages.map(message => message.content), ['partial answer']);
  assert.deepEqual(update.messageOrder, after.messages.map(message => message.id));
  assert.equal(JSON.stringify(update).includes('private'), false);
  assert.throws(() => diffChatOperationSnapshots(after, before), /cursor/i);
});

test('successive snapshots read only new journal events and retain unchanged message objects', t => {
  const { recorder, database, reader } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'x'.repeat(1024 * 1024) } });
  let before = reader.capture(database, NO_LIVE_BINDING);
  const read = t.mock.method(ChatJournalStore.prototype, 'readAfter');
  for (let index = 0; index < 10; index += 1) {
    recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: index, text: 'a' } });
    const after = reader.capture(database, NO_LIVE_BINDING);
    assert.equal(after.messages[1], before.messages[1], 'unchanged large rows retain identity');
    assert.deepEqual(diffChatOperationSnapshots(before, after).messages.map(message => message.content), ['a'.repeat(index + 1)]);
    before = after;
  }
  assert.equal(read.mock.callCount(), 10);
  assert.ok(read.mock.calls.every(call => call.arguments[1] > 0));
});

test('a cached snapshot incorporates history edits and deletions even without new execution events', () => {
  const { recorder, database, reader } = fixture();
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'original answer' } });
  const before = reader.capture(database, NO_LIVE_BINDING);
  const answer = before.messages.find(message => message.kind === 'assistant_answer');
  assert.ok(answer);
  recordChatHistoryRevision(database, 'session', { action: 'message_edited', messageId: answer.id, content: 'edited answer' });
  const edited = reader.capture(database, NO_LIVE_BINDING);
  assert.equal(edited.cursor.sequence, before.cursor.sequence);
  assert.equal(edited.messages.find(message => message.id === answer.id)?.content, 'edited answer');
  recordChatHistoryRevision(database, 'session', { action: 'message_deleted', messageIds: [answer.id] });
  const deleted = reader.capture(database, NO_LIVE_BINDING);
  assert.equal(deleted.messages.some(message => message.id === answer.id), false);
  assert.equal(diffChatOperationSnapshots(edited, deleted).messageOrder.includes(answer.id), false);
});
