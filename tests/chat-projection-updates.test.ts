import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { ChatProjectionCaptureSchema, ChatTranscriptMessageSchema, type ChatProjectionCapture, type ChatProjectionRecord, type ChatStreamUsageEvent, type ChatTranscriptMessage } from '@siftkit/contracts';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { recordChatHistoryRevision } from '../src/state/chat-history-revisions.js';
import { ChatMessageQueueStore } from '../src/state/chat-message-queue.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { ChatOperationSnapshotReader } from '../src/status-server/chat-operation-snapshot.js';
import { createChatSnapshotRecords, createChatUpdateRecords, encodeChatProjectionRecords } from '../src/status-server/chat-projection-encoder.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { applyChatProjectionRecords, asWireView, chatProjectionWireBytes, decodeChatProjectionFrames } from './helpers/chat-projection-decoder.js';

const NO_LIVE_BINDING = { approval: null, controlOperationId: null, activeOperation: null };
const TRANSFER_ID = 'e08682f5-9b0d-49ab-b4ef-cc0f027089ff';
const AT = '2026-09-10T12:09:36.905Z';
const MIB = 1024 * 1024;

function fixture() {
  const root = createManagedTempDir('chat-projection-updates-');
  saveChatSession(root, {
    id: 'session', title: 'Updates', modelPresetId: 'model', modelPreset: mockModelPreset(),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: AT, updatedAtUtc: AT, messages: [],
  });
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const recorder = ChatRunRecorder.begin(database, {
    operationId: randomUUID(), sessionId: 'session', ownerEpoch: 'test-owner', operationKind: 'repo-agent',
    userMessageId: 'accepted-user', content: 'Find the answer', images: [toDataUrl('image/png', rasterBuffer('png', 8, 8))],
    imageMeta: [{ width: 8, height: 8, originalWidth: 8, originalHeight: 8, mime: 'image/png', byteLength: 1, tokenEstimate: 1, resized: false, caption: null }],
    retainedHistoryRevision: 0, startedAtUtc: AT, settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'model', model: 'mock', repoRoot: 'C:/repo',
      approval: 'interactive', maxTurns: 200, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
    },
  });
  const reader = new ChatOperationSnapshotReader(recorder.operationId);
  return { database, recorder, reader, capture: () => reader.capture(database, NO_LIVE_BINDING) };
}

/** Encodes, decodes and applies an update, asserting the receiver lands exactly on `after`. */
function roundTrip(before: ChatProjectionCapture, after: ChatProjectionCapture): ChatProjectionRecord[] {
  const frames = [...encodeChatProjectionRecords(createChatUpdateRecords(before, after), TRANSFER_ID)];
  const records = decodeChatProjectionFrames(frames, TRANSFER_ID);
  const applied = applyChatProjectionRecords(records, before);
  assert.deepEqual(applied.snapshot, asWireView(after.snapshot));
  assert.deepEqual(applied.queue, JSON.stringify(before.queue) === JSON.stringify(after.queue) ? null : after.queue);
  return records;
}

function usage(turn: number, outputTokens: number): ChatStreamUsageEvent {
  return { turn, maxTurns: 200, charsPerToken: 4,
    record: { turn, promptTokens: 10, thinkingTokens: 0, outputTokens, toolTokens: 0, generatedChars: outputTokens * 4, thinkingTokensEstimated: false, outputTokensEstimated: false },
    totals: { promptTokens: 10 * turn, thinkingTokens: 0, outputTokens, toolTokens: 0, thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0 } };
}

test('a snapshot transfer rebuilds the captured view from empty staged state', () => {
  const { recorder, capture } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'looking around' } });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'done' } });
  const current = capture();
  const records = decodeChatProjectionFrames(encodeChatProjectionRecords(createChatSnapshotRecords(current), TRANSFER_ID), TRANSFER_ID);
  assert.equal(records[0]?.kind, 'begin');
  assert.equal(records.at(-1)?.kind, 'commit');
  const applied = applyChatProjectionRecords(records, null);
  assert.deepEqual(applied.snapshot, asWireView(current.snapshot));
  assert.deepEqual(applied.queue, current.queue);
});

test('text growth travels as suffixes with metadata while unchanged rows, images and token history stay home', () => {
  const { recorder, capture } = fixture();
  recorder.recordPresentation({ kind: 'prompt', prompt: { turn: 1, maxTurns: 200, promptTokens: 40, charsPerToken: 4 } });
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'looking ' } });
  const before = capture();
  assert.equal(before.snapshot.messages[0]?.images?.length, 1);
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 8, text: 'around' } });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: 0, text: 'found it' } });
  const after = capture();
  const records = roundTrip(before, after);
  const kinds = records.map(record => record.kind);
  assert.deepEqual(kinds, ['begin', 'append_text', 'message', 'commit']);
  const append = records[1];
  assert.equal(append?.kind, 'append_text');
  if (append?.kind !== 'append_text') return;
  assert.equal(append.text, 'around');
  assert.equal(append.offset, 'looking '.length);
  assert.equal(append.metadata.kind, 'assistant_narration');
  assert.equal(JSON.stringify(records).includes('data:image/png'), false);
  assert.equal(records.some(record => record.kind === 'token_turn'), false);
});

test('a usage-only text-row update carries metadata without resending its body', () => {
  const { recorder, capture } = fixture();
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'a'.repeat(1024 * 1024) } });
  const before = capture();
  recorder.recordDisplay({ kind: 'usage', usage: usage(1, 256) });
  const after = capture();

  const records = roundTrip(before, after);
  assert.deepEqual(records.map(record => record.kind), ['begin', 'append_text', 'token_turn', 'commit']);
  const append = records[1];
  assert.equal(append?.kind, 'append_text');
  if (append?.kind !== 'append_text') return;
  assert.equal(append.text, '');
  const beforeAnswer = before.snapshot.messages.find(message => message.kind === 'assistant_answer');
  const afterAnswer = after.snapshot.messages.find(message => message.kind === 'assistant_answer');
  assert.ok(beforeAnswer);
  assert.ok(afterAnswer);
  assert.equal(append.offset, beforeAnswer.content.length);
  assert.equal(append.metadata.outputTokensEstimate, afterAnswer.outputTokensEstimate);
});

test('a rewrite and kind conversion use replacements while usage changes use metadata updates', () => {
  const { recorder, capture } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'first draft' } });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: 0, text: 'partial' } });
  const before = capture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 6, text: 'rewrite' } });
  recorder.recordDisplay({ kind: 'usage', usage: usage(1, 12) });
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'file', value: 'a.ts' }, maxTurns: 200, promptTokenCount: 0, executionState: 'proposed' });
  const after = capture();
  const records = roundTrip(before, after);
  const replaced = records.filter(record => record.kind === 'message').map(record => record.kind === 'message' ? record.message.kind : '');
  assert.deepEqual(replaced.sort(), ['assistant_progress', 'assistant_tool_call']);
  assert.equal(records.filter(record => record.kind === 'append_text').length, 1);
  assert.equal(records.some(record => record.kind === 'append_text' && record.text === ''), true);
  assert.deepEqual(records.filter(record => record.kind === 'tool').length, 1);
  assert.deepEqual(records.filter(record => record.kind === 'token_turn').length, 1);
});

test('a history deletion advances only the revision and travels as a removal', () => {
  const { database, recorder, capture } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'to be deleted' } });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: 0, text: 'kept' } });
  const before = capture();
  const narration = before.snapshot.messages.find(message => message.kind === 'assistant_narration');
  assert.ok(narration);
  recordChatHistoryRevision(database, 'session', { action: 'message_deleted', messageIds: [narration.id] });
  const after = capture();
  assert.equal(after.cursor.sequence, before.cursor.sequence);
  assert.equal(after.cursor.historyRevision, before.cursor.historyRevision + 1);
  const records = roundTrip(before, after);
  assert.deepEqual(records.map(record => record.kind), ['begin', 'remove_message', 'commit']);
});

test('queue, approval, warnings and issues travel only when they change', () => {
  const { database, recorder, capture } = fixture();
  recorder.bindEngine({ requestId: 'request', repoAgentSessionId: randomUUID() });
  const before = capture();
  const unchanged = roundTrip(before, capture());
  assert.deepEqual(unchanged.map(record => record.kind), ['begin', 'commit']);
  new ChatMessageQueueStore(database).setPaused('session', true);
  recorder.recordPresentation({ kind: 'warning', warning: 'slow provider' });
  const call = { toolCallId: 'native-call', displayToolCallId: 'display-call', batchId: 'batch', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'work' }, command: 'work',
    activityKind: 'command', activitySubject: { kind: 'file', value: 'a.ts' }, maxTurns: 200, promptTokenCount: 0, executionState: 'pending_approval' });
  recorder.recordApprovalRequested({ call, approvalId: randomUUID(), toolName: 'run', command: 'work', reviewPayload: null,
    mode: 'interactive', requestedAtUtc: AT, expiresAtUtc: '2026-09-10T12:19:36.905Z' });
  const after = capture();
  const records = roundTrip(before, after);
  assert.deepEqual(records.map(record => record.kind), ['begin', 'message', 'tool', 'warning', 'approval', 'queue', 'commit']);
  assert.equal(records.find(record => record.kind === 'warning')?.kind === 'warning', true);
});

test('a shrink the records cannot express restarts as a snapshot transfer', () => {
  const { capture } = fixture();
  const before = capture();
  const shrunk = ChatProjectionCaptureSchema.parse({ ...before, snapshot: { ...before.snapshot, warnings: ['one'] } });
  const grown = ChatProjectionCaptureSchema.parse({ ...before, snapshot: { ...before.snapshot, warnings: ['two'] } });
  const records = [...createChatUpdateRecords(shrunk, grown)];
  assert.equal(records[0]?.kind === 'begin' && records[0].mode, 'snapshot');
  assert.deepEqual(applyChatProjectionRecords(records, shrunk).snapshot, grown.snapshot);
});

test('updates refuse a cursor regression or another operation', () => {
  const { capture } = fixture();
  const before = capture();
  const regressed = ChatProjectionCaptureSchema.parse({ ...before, cursor: { ...before.cursor, historyRevision: before.cursor.historyRevision + 1 } });
  assert.throws(() => [...createChatUpdateRecords(regressed, before)], /cursor/u);
  const otherId = randomUUID();
  const other = ChatProjectionCaptureSchema.parse({ ...before, snapshot: { ...before.snapshot, operationId: otherId, cursor: { ...before.snapshot.cursor, operationId: otherId } },
    cursor: { ...before.cursor, operationId: otherId } });
  assert.throws(() => [...createChatUpdateRecords(before, other)], /mismatch/u);
});

function syntheticCapture(base: ChatProjectionCapture, ids: readonly string[], sequence: number): ChatProjectionCapture {
  const messages = ids.map(id => ChatTranscriptMessageSchema.parse({ id, role: 'assistant', kind: 'assistant_answer', content: `body ${id}`,
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: AT, sourceRunId: base.snapshot.operationId }));
  return ChatProjectionCaptureSchema.parse({ ...base, cursor: { ...base.cursor, sequence },
    snapshot: { ...base.snapshot, cursor: { ...base.snapshot.cursor, sequence }, messages } });
}

test('positional inserts, moves and removals reproduce any reordering exactly', () => {
  const { capture } = fixture();
  const base = capture();
  let seed = 12345;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 60; round += 1) {
    const size = 1 + Math.floor(random() * 8);
    const beforeIds = Array.from({ length: size }, (_, index) => `m${String(index)}`);
    const afterIds = beforeIds.filter(() => random() > 0.25);
    for (let extra = 0; extra < 3; extra += 1) if (random() > 0.5) afterIds.splice(Math.floor(random() * (afterIds.length + 1)), 0, `n${String(round)}-${String(extra)}`);
    afterIds.sort(() => random() - 0.5);
    const before = syntheticCapture(base, beforeIds, 1);
    const after = syntheticCapture(base, afterIds, 2);
    const records = [...createChatUpdateRecords(before, after)];
    assert.deepEqual(applyChatProjectionRecords(records, before).snapshot.messages.map(message => message.id), afterIds, JSON.stringify({ beforeIds, afterIds }));
    const unchangedKept = afterIds.filter(id => beforeIds.includes(id));
    const moves = records.filter(record => record.kind === 'move_message').length;
    if (unchangedKept.map(id => beforeIds.indexOf(id)).every((index, position, all) => position === 0 || index > (all[position - 1] ?? -1))) assert.equal(moves, 0);
  }
});

function streamAnswer(totalBytes: number): { bytes: number; appends: number; suffixOnly: boolean } {
  const { recorder, capture } = fixture();
  const piece = 'a'.repeat(4096);
  let previous = capture();
  let bytes = chatProjectionWireBytes(encodeChatProjectionRecords(createChatSnapshotRecords(previous), TRANSFER_ID));
  let appends = 0;
  let suffixOnly = true;
  let offset = 0;
  for (let turn = 1; offset < totalBytes; turn += 1) {
    recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset, text: piece } });
    offset += piece.length;
    if (turn % 4 === 0) recorder.recordDisplay({ kind: 'usage', usage: usage(1, offset / 4) });
    const next = capture();
    const records = [...createChatUpdateRecords(previous, next)];
    bytes += chatProjectionWireBytes(encodeChatProjectionRecords(records, TRANSFER_ID));
    for (const record of records) {
      if (record.kind === 'append_text') { appends += 1; suffixOnly &&= record.text === piece && record.offset === offset - piece.length; }
      // The first delta creates the row; every later delta must travel as a suffix.
      if (record.kind === 'message' && record.message.kind === 'assistant_answer' && offset > piece.length) suffixOnly = false;
      if (record.kind === 'token_turn') suffixOnly &&= record.tokenTurn.usage !== null;
    }
    previous = next;
  }
  return { bytes, appends, suffixOnly };
}

test('a streamed answer costs linear traffic: only suffixes, offsets and changed usage travel', { timeout: 120_000 }, t => {
  const one = streamAnswer(MIB);
  const two = streamAnswer(2 * MIB);
  t.diagnostic(`one_mib_bytes=${String(one.bytes)} two_mib_bytes=${String(two.bytes)} appends=${String(one.appends)}/${String(two.appends)}`);
  assert.equal(one.suffixOnly && two.suffixOnly, true);
  assert.equal(one.appends, MIB / 4096 - 1);
  assert.equal(two.appends, 2 * MIB / 4096 - 1);
  assert.ok(two.bytes <= one.bytes * 2.2, `${String(two.bytes)} > 2.2 * ${String(one.bytes)}`);
  assert.ok(one.bytes < MIB * 1.5, `snapshot plus deltas should stay near the text size, got ${String(one.bytes)}`);
});

test('token turns are resent only when they change and never per text delta', () => {
  const { recorder, capture } = fixture();
  recorder.recordPresentation({ kind: 'prompt', prompt: { turn: 1, maxTurns: 200, promptTokens: 40, charsPerToken: 4 } });
  recorder.recordDisplay({ kind: 'usage', usage: usage(1, 3) });
  let previous = capture();
  let tokenRecords = 0;
  for (let index = 0; index < 5; index += 1) {
    recorder.recordDisplay({ kind: 'answer', delta: { turn: 2, offset: index, text: 'x' } });
    const next = capture();
    tokenRecords += [...createChatUpdateRecords(previous, next)].filter(record => record.kind === 'token_turn').length;
    previous = next;
  }
  assert.equal(tokenRecords, 0);
  recorder.recordDisplay({ kind: 'usage', usage: usage(2, 5) });
  const records = [...createChatUpdateRecords(previous, capture())];
  assert.deepEqual(records.filter(record => record.kind === 'token_turn').map(record => record.kind === 'token_turn' ? record.tokenTurn.turn : -1), [2]);
});

/** Type guard used above; keeps the message kind narrowing explicit for the linter. */
function isMessage(message: ChatTranscriptMessage | undefined): message is ChatTranscriptMessage { return message !== undefined; }
void isMessage;
