import {
  ApprovalModeSchema,
  ChatRunEffectiveSettingsSchema,
  ChatRunRecordKindSchema,
  ChatRunTerminalCauseSchema,
  ChatSessionOperationKindSchema,
  ChatStreamQueuedUserMessageSchema,
  ChatStreamUsageEventSchema,
  ChatToolExecutionStateSchema,
  ChatTranscriptEventSchema,
  ImageDataUrlSchema,
  ImageMetadataSchema,
  PersistedChatTranscriptMessageSchema,
  RepoAgentDecisionSchema,
  ToolActivityKindSchema,
  ToolActivitySubjectSchema,
  ChatApprovalOutcomeSchema,
  ChatRecoveryStatusSchema,
} from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import {
  ChatContextInitSchema,
  ChatContextSpliceSchema,
  PlannerChatMessageSchema,
} from '../repo-search/planner-chat-message.js';

/**
 * The only event format this build writes and the only one it accepts. A row stamped with a version
 * it does not know is a hard failure, not something to interpret optimistically.
 */
export const CHAT_JOURNAL_EVENT_VERSION = 1;
export const ChatJournalEventVersionSchema = z.literal(CHAT_JOURNAL_EVENT_VERSION);

/**
 * Identity of one tool call inside one run. A call has two real names and recovery needs both: the
 * planner call id it is answered by in model history, and the run-scoped id its progress frames,
 * command entries and display rows carry. Recording only one of them forces a later join to guess.
 */
export const ChatToolCallIdentitySchema = z.strictObject({
  toolCallId: z.string().trim().min(1),
  displayToolCallId: z.string().trim().min(1),
  batchId: z.string().trim().min(1),
  turn: z.number().int().positive(),
  indexInBatch: z.number().int().nonnegative(),
});
export type ChatToolCallIdentity = z.infer<typeof ChatToolCallIdentitySchema>;

/** A user edit or deletion, journalled so a rebuild cannot resurrect what the user removed. */
export const ChatHistoryRevisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('message_edited'),
    messageId: z.string().min(1),
    content: z.string(),
  }),
  z.strictObject({
    action: z.literal('message_deleted'),
    messageIds: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    action: z.literal('image_removed'),
    messageId: z.string().min(1),
    imageIndex: z.number().int().nonnegative(),
    imagePathKey: z.string().nullable(),
  }),
  z.strictObject({
    action: z.literal('image_caption_updated'),
    messageId: z.string().min(1),
    imageIndex: z.number().int().nonnegative(),
    caption: z.string(),
  }),
  z.strictObject({
    action: z.literal('condensed'),
    summaryMessageId: z.string().min(1),
    compressedMessageIds: z.array(z.string().min(1)),
  }),
]);
export type ChatHistoryRevision = z.infer<typeof ChatHistoryRevisionSchema>;

/** Where imported evidence came from, kept immutable so a re-import can prove it is the same. */
export const ChatImportProvenanceSchema = z.strictObject({
  importerVersion: z.number().int().positive(),
  sourceKind: z.enum(['saved_chat', 'run_archive', 'repo_agent_state']),
  sourceId: z.string().min(1),
  sourceDigest: z.string().min(1),
});
export type ChatImportProvenance = z.infer<typeof ChatImportProvenanceSchema>;

/**
 * The journal's event families. Conversation events describe what the user sees; context events
 * describe the exact planner message sequence. They live in one ordered log so the display and the
 * model history can never disagree about what happened first.
 */
export const ChatRunStartedEventSchema = z.strictObject({
  kind: z.literal('run_started'),
  sessionId: z.string().min(1),
  operationKind: ChatSessionOperationKindSchema,
  runOrder: z.number().int().positive(),
  userMessageId: z.string().min(1),
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
  imageMeta: z.array(ImageMetadataSchema),
  settings: ChatRunEffectiveSettingsSchema,
  /** The session history revision this run was built on top of. */
  retainedHistoryRevision: z.number().int().nonnegative(),
});

export const ChatJournalEventSchema = z.discriminatedUnion('kind', [
  ChatRunStartedEventSchema,
  z.strictObject({
    kind: z.literal('engine_bound'),
    requestId: z.string().min(1),
    repoAgentSessionId: z.string().min(1).nullable(),
  }),
  z.strictObject({
    kind: z.literal('display'),
    event: ChatTranscriptEventSchema,
  }),
  ChatContextInitSchema.extend({ kind: z.literal('context_initialized') }),
  ChatContextSpliceSchema.extend({ kind: z.literal('context_spliced') }),
  z.strictObject({
    kind: z.literal('tool_proposed'),
    call: ChatToolCallIdentitySchema,
    toolName: z.string().trim().min(1),
    arguments: JsonObjectSchema,
    command: z.string().min(1),
    activityKind: ToolActivityKindSchema,
    activitySubject: ToolActivitySubjectSchema,
    maxTurns: z.number().int().positive(),
    promptTokenCount: z.number().int().nonnegative(),
    executionState: ChatToolExecutionStateSchema,
  }),
  z.strictObject({
    kind: z.literal('tool_started'),
    call: ChatToolCallIdentitySchema,
    startedAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('tool_result'),
    call: ChatToolCallIdentitySchema,
    executionState: ChatToolExecutionStateSchema,
    /** Null for a call that never produced an exit status; never an invented number. */
    exitCode: z.number().int().nullable(),
    /** The complete result, including an empty string for a successful silent command. */
    output: z.string(),
    images: z.array(ImageDataUrlSchema),
    imageMeta: z.array(ImageMetadataSchema),
    outputTokens: z.number().int().nonnegative(),
    outputTokensEstimated: z.boolean(),
    promptTokenCount: z.number().int().nonnegative(),
    finishedAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('tool_result_finalized'),
    call: ChatToolCallIdentitySchema,
    /** Exactly the text inserted into planner history, after any finalization rewrote it. */
    modelVisibleText: z.string(),
    contextRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('approval_requested'),
    call: ChatToolCallIdentitySchema,
    approvalId: z.string().uuid(),
    toolName: z.string().trim().min(1),
    command: z.string().min(1),
    reviewPayload: z.string().nullable(),
    mode: ApprovalModeSchema,
    requestedAtUtc: z.string().datetime(),
    expiresAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('approval_resolved'),
    approvalId: z.string().uuid(),
    outcome: ChatApprovalOutcomeSchema,
    decision: RepoAgentDecisionSchema.nullable(),
    reason: z.string().nullable(),
    decidedAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('queue_delivered'),
    message: ChatStreamQueuedUserMessageSchema,
    requestId: z.string().min(1).nullable(),
    deliveredAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('run_finished'),
    terminalCause: ChatRunTerminalCauseSchema,
    detail: z.string().nullable(),
    usage: ChatStreamUsageEventSchema.nullable(),
    recoveryStatus: ChatRecoveryStatusSchema,
    finishedAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('history_revised'),
    revision: ChatHistoryRevisionSchema,
    expectedSessionRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('baseline_imported'),
    messages: z.array(PersistedChatTranscriptMessageSchema),
    retainedContext: z.array(PlannerChatMessageSchema),
    provenance: ChatImportProvenanceSchema,
  }),
]);
export type ChatJournalEvent = z.infer<typeof ChatJournalEventSchema>;
export type ChatJournalEventKind = ChatJournalEvent['kind'];

/** One committed row, exactly as it will be read back. */
export const ChatJournalEnvelopeSchema = z.strictObject({
  operationId: z.string().uuid(),
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  version: ChatJournalEventVersionSchema,
  recordedAtUtc: z.string().datetime(),
  event: ChatJournalEventSchema,
  payloadDigest: z.string().min(1),
});
export type ChatJournalEnvelope = z.infer<typeof ChatJournalEnvelopeSchema>;

/**
 * A write. `expectedSequence` is the latest sequence the writer has seen: the append lands at
 * `expectedSequence + 1` or fails, so two writers cannot interleave into the same run unnoticed.
 */
export const ChatJournalAppendSchema = z.strictObject({
  operationId: z.string().uuid(),
  ownerEpoch: z.string().min(1),
  expectedSequence: z.number().int().nonnegative(),
  eventId: z.string().min(1),
  occurredAtUtc: z.string().datetime(),
  event: ChatJournalEventSchema,
});
export type ChatJournalAppend = z.infer<typeof ChatJournalAppendSchema>;

export const ChatRunStartSchema = z.strictObject({
  operationId: z.string().uuid(),
  sessionId: z.string().min(1),
  recordKind: ChatRunRecordKindSchema,
  operationKind: ChatSessionOperationKindSchema.nullable(),
  ownerEpoch: z.string().min(1),
  settings: ChatRunEffectiveSettingsSchema.nullable(),
  provenance: ChatImportProvenanceSchema.nullable(),
  createdAtUtc: z.string().datetime(),
});
export type ChatRunStart = z.infer<typeof ChatRunStartSchema>;

export const ChatEngineBindingSchema = z.strictObject({
  operationId: z.string().uuid(),
  ownerEpoch: z.string().min(1),
  requestId: z.string().min(1),
  repoAgentSessionId: z.string().min(1).nullable(),
});
export type ChatEngineBinding = z.infer<typeof ChatEngineBindingSchema>;

export const ChatRunSchema = z.strictObject({
  operationId: z.string().uuid(),
  sessionId: z.string().min(1),
  recordKind: ChatRunRecordKindSchema,
  operationKind: ChatSessionOperationKindSchema.nullable(),
  requestId: z.string().min(1).nullable(),
  repoAgentSessionId: z.string().min(1).nullable(),
  runOrder: z.number().int().positive(),
  ownerEpoch: z.string().min(1),
  createdAtUtc: z.string().datetime(),
  updatedAtUtc: z.string().datetime(),
  terminalCause: ChatRunTerminalCauseSchema.nullable(),
  latestSequence: z.number().int().nonnegative(),
  projectedSequence: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
  settings: ChatRunEffectiveSettingsSchema.nullable(),
  provenance: ChatImportProvenanceSchema.nullable(),
});
export type ChatRun = z.infer<typeof ChatRunSchema>;
