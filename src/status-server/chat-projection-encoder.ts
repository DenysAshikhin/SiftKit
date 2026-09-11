import {
  CHAT_PROJECTION_MAX_FRAME_BYTES,
  CHAT_PROJECTION_PROTOCOL_VERSION,
  ChatProjectionFrameSchema,
  ChatProjectionStateSchema,
  ChatTextRowKindSchema,
  ChatTextRowMetadataSchema,
  advancesChatProjectionCursor,
  type ChatOperationSnapshot,
  type ChatProjectionCapture,
  type ChatProjectionCommitCounts,
  type ChatProjectionFrame,
  type ChatProjectionRecord,
  type ChatTextRowMetadata,
  type ChatTranscriptMessage,
} from '@siftkit/contracts';
import { JsonValueSchema, type JsonSerializable } from '../lib/json-types.js';
import { stableStringify } from '../lib/json.js';

export const CHAT_PROJECTION_EVENT_NAME = 'chat_projection';
/** Raw code units escaped per string segment; escaping can grow each unit to six bytes. */
const STRING_SEGMENT_CODE_UNITS = 4096;

type Frame =
  | { close: ']'; items: readonly JsonSerializable[]; index: number }
  | { close: '}'; entries: [string, JsonSerializable][]; index: number };

/** A string as JSON text, escaped a bounded slice at a time; surrogate pairs are never split. */
function* stringSegments(text: string): Generator<string> {
  yield '"';
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + STRING_SEGMENT_CODE_UNITS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield JSON.stringify(text.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

function* openValue(value: JsonSerializable, stack: Frame[]): Generator<string> {
  if (typeof value === 'string') { yield* stringSegments(value); return; }
  if (value === null || value === undefined) { yield 'null'; return; }
  if (typeof value === 'number') { yield Number.isFinite(value) ? JSON.stringify(value) : 'null'; return; }
  if (typeof value === 'boolean') { yield value ? 'true' : 'false'; return; }
  if (Array.isArray(value)) { stack.push({ close: ']', items: value, index: 0 }); yield '['; return; }
  const entries = Object.entries(value).filter((entry): entry is [string, JsonSerializable] => entry[1] !== undefined);
  stack.push({ close: '}', entries, index: 0 });
  yield '{';
}

/** JSON.stringify semantics over an explicit stack, emitted as bounded segments instead of one string. */
export function* jsonSegments(root: JsonSerializable): Generator<string> {
  const stack: Frame[] = [];
  yield* openValue(root, stack);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    if (top.close === ']') {
      if (top.index >= top.items.length) { stack.pop(); yield ']'; continue; }
      if (top.index > 0) yield ',';
      const item = top.items[top.index];
      top.index += 1;
      yield* openValue(item === undefined ? null : item, stack);
      continue;
    }
    const entry = top.entries[top.index];
    if (entry === undefined) { stack.pop(); yield '}'; continue; }
    if (top.index > 0) yield ',';
    top.index += 1;
    yield `${JSON.stringify(entry[0])}:`;
    yield* openValue(entry[1], stack);
  }
}

export function serializeChatProjectionFrame(frame: ChatProjectionFrame): string {
  return `event: ${CHAT_PROJECTION_EVENT_NAME}\ndata: ${JSON.stringify(frame)}\n\n`;
}

function frameOf(transferId: string, recordIndex: number, chunkIndex: number, finalChunk: boolean, data: string): ChatProjectionFrame {
  return ChatProjectionFrameSchema.parse({ version: CHAT_PROJECTION_PROTOCOL_VERSION, transferId, recordIndex, chunkIndex, finalChunk, data });
}

/** Bytes of a frame's wire form once `data` is escaped a second time; segments never split surrogate pairs, so sums are exact. */
function escapedBytes(segment: string): number {
  return Buffer.byteLength(JSON.stringify(segment), 'utf8') - 2;
}

/** Fragments one record's JSON across frames whose complete SSE wire form stays within the budget. */
export function* encodeChatProjectionRecord(
  record: ChatProjectionRecord, transferId: string, recordIndex: number, maxFrameBytes = CHAT_PROJECTION_MAX_FRAME_BYTES,
): Generator<ChatProjectionFrame> {
  let chunkIndex = 0;
  let data = '';
  let dataBytes = 0;
  let budget = maxFrameBytes - Buffer.byteLength(serializeChatProjectionFrame(frameOf(transferId, recordIndex, chunkIndex, false, '')), 'utf8');
  for (const segment of jsonSegments(record)) {
    const bytes = escapedBytes(segment);
    if (dataBytes + bytes > budget && dataBytes > 0) {
      yield frameOf(transferId, recordIndex, chunkIndex, false, data);
      chunkIndex += 1;
      data = '';
      dataBytes = 0;
      budget = maxFrameBytes - Buffer.byteLength(serializeChatProjectionFrame(frameOf(transferId, recordIndex, chunkIndex, false, '')), 'utf8');
    }
    if (bytes > budget) throw new Error(`Chat projection segment of ${String(bytes)} bytes exceeds the ${String(maxFrameBytes)}-byte frame budget.`);
    data += segment;
    dataBytes += bytes;
  }
  yield frameOf(transferId, recordIndex, chunkIndex, true, data);
}

export function* encodeChatProjectionRecords(
  records: Iterable<ChatProjectionRecord>, transferId: string, maxFrameBytes = CHAT_PROJECTION_MAX_FRAME_BYTES,
): Generator<ChatProjectionFrame> {
  let recordIndex = 0;
  for (const record of records) {
    yield* encodeChatProjectionRecord(record, transferId, recordIndex, maxFrameBytes);
    recordIndex += 1;
  }
}

function commitCounts(snapshot: ChatOperationSnapshot): ChatProjectionCommitCounts {
  return { messages: snapshot.messages.length, tools: snapshot.tools.length, tokenTurns: snapshot.tokenTurns.length,
    warnings: snapshot.warnings.length, issues: snapshot.issues.length };
}

/** A complete transfer: every collection from empty staged state, the captured queue, then commit. */
export function* createChatSnapshotRecords(capture: ChatProjectionCapture): Generator<ChatProjectionRecord> {
  const { snapshot, cursor, queue } = capture;
  yield { kind: 'begin', mode: 'snapshot', sessionId: snapshot.sessionId, operationId: snapshot.operationId, after: null, cursor,
    state: ChatProjectionStateSchema.strip().parse(snapshot) };
  let previousId: string | null = null;
  for (const message of snapshot.messages) {
    yield { kind: 'message', message, afterMessageId: previousId };
    previousId = message.id;
  }
  for (const tool of snapshot.tools) yield { kind: 'tool', tool };
  for (const tokenTurn of snapshot.tokenTurns) yield { kind: 'token_turn', tokenTurn };
  for (const [index, warning] of snapshot.warnings.entries()) yield { kind: 'warning', index, warning };
  for (const [index, issue] of snapshot.issues.entries()) yield { kind: 'issue', index, issue };
  yield { kind: 'approval', approval: snapshot.approval };
  yield { kind: 'queue', queue };
  yield { kind: 'commit', cursor, counts: commitCounts(snapshot) };
}

/** Structural equality with JSON semantics: omitted and undefined fields compare alike. */
function same(a: JsonSerializable, b: JsonSerializable): boolean {
  return stableStringify(JsonValueSchema.parse(JSON.parse(JSON.stringify(a ?? null))))
    === stableStringify(JsonValueSchema.parse(JSON.parse(JSON.stringify(b ?? null))));
}

function isPrefix(before: readonly JsonSerializable[], after: readonly JsonSerializable[]): boolean {
  return before.length <= after.length && before.every((entry, index) => same(entry, after[index]));
}

/** The suffix and metadata an append record may carry, or null when the row changed in any other way. */
function textSuffix(before: ChatTranscriptMessage, after: ChatTranscriptMessage): { text: string; metadata: ChatTextRowMetadata } | null {
  if (!ChatTextRowKindSchema.safeParse(after.kind).success || !ChatTextRowKindSchema.safeParse(before.kind).success) return null;
  if (after.content.length <= before.content.length || !after.content.startsWith(before.content)) return null;
  const metadata = ChatTextRowMetadataSchema.strip().parse(after);
  if (!same({ ...before, ...metadata, content: '' }, { ...after, content: '' })) return null;
  return { text: after.content.slice(before.content.length), metadata };
}

/**
 * Only what changed between two captures. Order is expressed by positional inserts and moves,
 * text growth by suffixes, and a shrink the records cannot express restarts as a full snapshot.
 */
export function* createChatUpdateRecords(before: ChatProjectionCapture, after: ChatProjectionCapture): Generator<ChatProjectionRecord> {
  if (before.snapshot.operationId !== after.snapshot.operationId || before.snapshot.sessionId !== after.snapshot.sessionId) {
    throw new Error('Chat projection update operation mismatch.');
  }
  if (!advancesChatProjectionCursor(before.cursor, after.cursor)) throw new Error('Chat projection cursor moved backwards.');
  const beforeTurns = new Map(before.snapshot.tokenTurns.map(tokenTurn => [tokenTurn.turn, tokenTurn]));
  const beforeTools = new Map(before.snapshot.tools.map(tool => [tool.messageId, tool]));
  const afterIds = new Set(after.snapshot.messages.map(message => message.id));
  const afterTools = new Set(after.snapshot.tools.map(tool => tool.messageId));
  const expressible = isPrefix(before.snapshot.warnings, after.snapshot.warnings) && isPrefix(before.snapshot.issues, after.snapshot.issues)
    && after.snapshot.tokenTurns.length >= beforeTurns.size && before.snapshot.tokenTurns.every(tokenTurn => after.snapshot.tokenTurns.some(candidate => candidate.turn === tokenTurn.turn))
    && before.snapshot.tools.every(tool => !afterIds.has(tool.messageId) || afterTools.has(tool.messageId));
  if (!expressible) {
    yield* createChatSnapshotRecords(after);
    return;
  }
  yield { kind: 'begin', mode: 'update', sessionId: after.snapshot.sessionId, operationId: after.snapshot.operationId, after: before.cursor,
    cursor: after.cursor, state: ChatProjectionStateSchema.strip().parse(after.snapshot) };
  const beforeById = new Map(before.snapshot.messages.map((message, index) => [message.id, { message, index }]));
  for (const message of before.snapshot.messages) {
    if (!afterIds.has(message.id)) yield { kind: 'remove_message', messageId: message.id };
  }
  let previousId: string | null = null;
  let highestKeptIndex = -1;
  for (const message of after.snapshot.messages) {
    const existing = beforeById.get(message.id);
    if (existing === undefined) {
      yield { kind: 'message', message, afterMessageId: previousId };
    } else {
      // Rows whose relative order held stay put; any other row is placed after its new predecessor.
      const moved = existing.index < highestKeptIndex;
      if (!moved) highestKeptIndex = existing.index;
      // Identity is the cheap unchanged check; a refold after a revision keeps rows only structurally equal.
      if (existing.message !== message) {
        const suffix = moved ? null : textSuffix(existing.message, message);
        if (suffix) yield { kind: 'append_text', messageId: message.id, offset: existing.message.content.length, text: suffix.text, metadata: suffix.metadata };
        else if (!same(existing.message, message)) yield { kind: 'message', message, afterMessageId: previousId };
        else if (moved) yield { kind: 'move_message', messageId: message.id, afterMessageId: previousId };
      } else if (moved) {
        yield { kind: 'move_message', messageId: message.id, afterMessageId: previousId };
      }
    }
    previousId = message.id;
  }
  for (const tool of after.snapshot.tools) {
    const previous = beforeTools.get(tool.messageId);
    if (previous === undefined || !same(previous, tool)) yield { kind: 'tool', tool };
  }
  for (const tokenTurn of after.snapshot.tokenTurns) {
    const previous = beforeTurns.get(tokenTurn.turn);
    if (previous === undefined || !same(previous, tokenTurn)) yield { kind: 'token_turn', tokenTurn };
  }
  for (let index = before.snapshot.warnings.length; index < after.snapshot.warnings.length; index += 1) {
    const warning = after.snapshot.warnings[index];
    if (warning !== undefined) yield { kind: 'warning', index, warning };
  }
  for (let index = before.snapshot.issues.length; index < after.snapshot.issues.length; index += 1) {
    const issue = after.snapshot.issues[index];
    if (issue !== undefined) yield { kind: 'issue', index, issue };
  }
  if (!same(before.snapshot.approval, after.snapshot.approval)) yield { kind: 'approval', approval: after.snapshot.approval };
  if (!same(before.queue, after.queue)) yield { kind: 'queue', queue: after.queue };
  yield { kind: 'commit', cursor: after.cursor, counts: commitCounts(after.snapshot) };
}
