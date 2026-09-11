import { z } from 'zod';
import {
  ChatMessageQueueStateSchema,
  ChatOperationIdSchema,
  ChatRunTerminalCauseSchema,
  ChatTextRowMetadataSchema,
  ChatTranscriptMessageSchema,
} from './chat.js';
import {
  ChatEventCursorSchema,
  ChatOperationSnapshotSchema,
  ChatRecoveredToolSchema,
  ChatRecoveryIssueSchema,
  ChatSnapshotTokenTurnSchema,
  ChatStreamErrorSchema,
  DurableChatApprovalSchema,
} from './chat-recovery.js';

export const CHAT_PROJECTION_PROTOCOL_VERSION = 2;
/** Upper bound on one encoded `chat_projection` SSE event, escaping and framing included. */
export const CHAT_PROJECTION_MAX_FRAME_BYTES = 64 * 1024;

/**
 * Where a projected view stands. The revision count lets a deletion advance the view without any
 * execution event, so an unchanged sequence never implies an unchanged projection.
 */
export const ChatProjectionCursorSchema = ChatEventCursorSchema.extend({
  historyRevision: z.number().int().nonnegative(),
});
export type ChatProjectionCursor = z.infer<typeof ChatProjectionCursorSchema>;

/** Both components are monotonic on one operation; equal cursors are a legal (queue-only) step. */
export function advancesChatProjectionCursor(before: ChatProjectionCursor, after: ChatProjectionCursor): boolean {
  return before.operationId === after.operationId
    && after.sequence >= before.sequence && after.historyRevision >= before.historyRevision;
}

/** One transaction's view, projection cursor and queue; the source every transfer is generated from. */
export const ChatProjectionCaptureSchema = z.strictObject({
  snapshot: ChatOperationSnapshotSchema,
  cursor: ChatProjectionCursorSchema,
  queue: ChatMessageQueueStateSchema,
}).refine(
  capture => capture.snapshot.operationId === capture.cursor.operationId && capture.snapshot.cursor.sequence === capture.cursor.sequence,
  { message: 'Chat projection capture must bind its snapshot and cursor to one operation and sequence.' },
);
export type ChatProjectionCapture = z.infer<typeof ChatProjectionCaptureSchema>;

/** Run state that is not a collection, identity, approval or cursor: carried once per transfer. */
export const ChatProjectionStateSchema = ChatOperationSnapshotSchema.omit({
  sessionId: true, operationId: true, cursor: true,
  messages: true, tools: true, approval: true, tokenTurns: true, warnings: true, issues: true,
});
export type ChatProjectionState = z.infer<typeof ChatProjectionStateSchema>;

const MessageIdSchema = z.string().min(1);

const ChatProjectionBeginRecordSchema = z.strictObject({
  kind: z.literal('begin'),
  mode: z.enum(['snapshot', 'update']),
  sessionId: z.string().min(1),
  operationId: ChatOperationIdSchema,
  /** The committed cursor an update stages over; a snapshot starts from empty staged state. */
  after: ChatProjectionCursorSchema.nullable(),
  cursor: ChatProjectionCursorSchema,
  state: ChatProjectionStateSchema,
}).refine(
  begin => begin.cursor.operationId === begin.operationId
    && (begin.mode === 'snapshot' ? begin.after === null : begin.after !== null && advancesChatProjectionCursor(begin.after, begin.cursor)),
  { message: 'A snapshot begins from nothing; an update begins after a cursor its own cursor does not precede.' },
);

/** Insert or replace one full row; `afterMessageId` null places it first. */
const ChatProjectionMessageRecordSchema = z.strictObject({
  kind: z.literal('message'),
  message: ChatTranscriptMessageSchema,
  afterMessageId: MessageIdSchema.nullable(),
}).refine(record => record.afterMessageId !== record.message.id, { message: 'A message cannot anchor on itself.' });

/** Extend a streamed text row at a UTF-16 offset; preserved fields stay as the receiver holds them. */
const ChatProjectionAppendTextRecordSchema = z.strictObject({
  kind: z.literal('append_text'),
  messageId: MessageIdSchema,
  offset: z.number().int().nonnegative(),
  text: z.string().min(1),
  metadata: ChatTextRowMetadataSchema,
});

const ChatProjectionRemoveMessageRecordSchema = z.strictObject({
  kind: z.literal('remove_message'),
  messageId: MessageIdSchema,
});

const ChatProjectionMoveMessageRecordSchema = z.strictObject({
  kind: z.literal('move_message'),
  messageId: MessageIdSchema,
  afterMessageId: MessageIdSchema.nullable(),
}).refine(record => record.afterMessageId !== record.messageId, { message: 'A message cannot anchor on itself.' });

const ChatProjectionToolRecordSchema = z.strictObject({ kind: z.literal('tool'), tool: ChatRecoveredToolSchema });
const ChatProjectionTokenTurnRecordSchema = z.strictObject({ kind: z.literal('token_turn'), tokenTurn: ChatSnapshotTokenTurnSchema });
const ChatProjectionWarningRecordSchema = z.strictObject({
  kind: z.literal('warning'), index: z.number().int().nonnegative(), warning: z.string(),
});
const ChatProjectionIssueRecordSchema = z.strictObject({
  kind: z.literal('issue'), index: z.number().int().nonnegative(), issue: ChatRecoveryIssueSchema,
});
const ChatProjectionApprovalRecordSchema = z.strictObject({ kind: z.literal('approval'), approval: DurableChatApprovalSchema.nullable() });
const ChatProjectionQueueRecordSchema = z.strictObject({ kind: z.literal('queue'), queue: ChatMessageQueueStateSchema });

export const ChatProjectionCommitCountsSchema = z.strictObject({
  messages: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  tokenTurns: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
});
export type ChatProjectionCommitCounts = z.infer<typeof ChatProjectionCommitCountsSchema>;

/** Makes the staged transfer visible; counts must match what the receiver staged. */
const ChatProjectionCommitRecordSchema = z.strictObject({
  kind: z.literal('commit'),
  cursor: ChatProjectionCursorSchema,
  counts: ChatProjectionCommitCountsSchema,
});

export const ChatProjectionTerminalRecordSchema = z.strictObject({
  kind: z.literal('terminal'), cursor: ChatProjectionCursorSchema,
  terminalCause: ChatRunTerminalCauseSchema, issue: ChatRecoveryIssueSchema.nullable(),
});
export type ChatProjectionTerminalRecord = z.infer<typeof ChatProjectionTerminalRecordSchema>;

export const ChatProjectionErrorRecordSchema = z.strictObject({
  kind: z.literal('error'), failure: ChatStreamErrorSchema,
});
export type ChatProjectionErrorRecord = z.infer<typeof ChatProjectionErrorRecordSchema>;

export const ChatProjectionRecordSchema = z.discriminatedUnion('kind', [
  ChatProjectionBeginRecordSchema,
  ChatProjectionMessageRecordSchema,
  ChatProjectionAppendTextRecordSchema,
  ChatProjectionRemoveMessageRecordSchema,
  ChatProjectionMoveMessageRecordSchema,
  ChatProjectionToolRecordSchema,
  ChatProjectionTokenTurnRecordSchema,
  ChatProjectionWarningRecordSchema,
  ChatProjectionIssueRecordSchema,
  ChatProjectionApprovalRecordSchema,
  ChatProjectionQueueRecordSchema,
  ChatProjectionCommitRecordSchema,
  ChatProjectionTerminalRecordSchema,
  ChatProjectionErrorRecordSchema,
]);
export type ChatProjectionRecord = z.infer<typeof ChatProjectionRecordSchema>;

/** One `chat_projection` SSE event: a fragment of exactly one logical record's JSON. */
export const ChatProjectionFrameSchema = z.strictObject({
  version: z.literal(CHAT_PROJECTION_PROTOCOL_VERSION),
  transferId: z.string().uuid(),
  recordIndex: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  finalChunk: z.boolean(),
  data: z.string().max(CHAT_PROJECTION_MAX_FRAME_BYTES),
});
export type ChatProjectionFrame = z.infer<typeof ChatProjectionFrameSchema>;

/** What a decoder hands the application once a transfer, terminal or error is complete. */
export const ChatProjectionDeliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view'), snapshot: ChatOperationSnapshotSchema, queue: ChatMessageQueueStateSchema.nullable() }),
  z.strictObject({ kind: z.literal('terminal'), terminal: ChatProjectionTerminalRecordSchema }),
  z.strictObject({ kind: z.literal('failure'), failure: ChatStreamErrorSchema }),
]);
export type ChatProjectionDelivery = z.infer<typeof ChatProjectionDeliverySchema>;
