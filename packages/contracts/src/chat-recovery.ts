import { z } from 'zod';
import {
  ApprovalModeSchema,
  ChatOperationIdSchema,
  ChatSessionModeSchema,
  ChatSessionOperationKindSchema,
  ChatStreamApprovalSchema,
  ChatToolExecutionStateSchema,
  ChatTranscriptMessageSchema,
  ToolCallStatusSchema,
} from './chat.js';

/**
 * One approval waits ten minutes from the moment it was requested. Refreshing the page, reattaching
 * a stream, or reloading the server does not extend it, so the deadline is stored with the request
 * rather than recomputed from whenever it is next looked at.
 */
export const CHAT_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * What a journal run row represents. Only `execution` is a real model run; the other two are
 * committed records of imported history and of user edits, so reconstruction never has to invent a
 * fake run to explain where a message came from.
 */
export const ChatRunRecordKindSchema = z.enum(['execution', 'baseline', 'history_revision']);
export type ChatRunRecordKind = z.infer<typeof ChatRunRecordKindSchema>;

/** How a run ended. These stay distinct: a stop is not a failure and a restart is not a completion. */
export const ChatRunTerminalCauseSchema = z.enum([
  'completed',
  'user_stop',
  'approval_timeout',
  'provider_failure',
  'execution_failure',
  'storage_failure',
  'server_restart',
]);
export type ChatRunTerminalCause = z.infer<typeof ChatRunTerminalCauseSchema>;

/**
 * The settings a run actually executed under, kept for audit. A continuation uses the currently
 * selected settings; this record explains what the interrupted run did, it does not dictate what
 * the next one does.
 */
export const ChatRunEffectiveSettingsSchema = z.strictObject({
  operationKind: ChatSessionOperationKindSchema,
  mode: ChatSessionModeSchema,
  modelPresetId: z.string().trim().min(1),
  model: z.string().nullable(),
  repoRoot: z.string().trim().min(1),
  approval: ApprovalModeSchema.nullable(),
  maxTurns: z.number().int().positive().nullable(),
  thinkingEnabled: z.boolean(),
  webSearchEnabled: z.boolean(),
  contextWindowTokens: z.number().int().nonnegative(),
});
export type ChatRunEffectiveSettings = z.infer<typeof ChatRunEffectiveSettingsSchema>;

/** Sequence 0 means "nothing applied yet"; committed events start at 1. */
export const ChatEventCursorSchema = z.strictObject({
  operationId: ChatOperationIdSchema,
  sequence: z.number().int().nonnegative(),
});
export type ChatEventCursor = z.infer<typeof ChatEventCursorSchema>;

export const ChatRecoveryStatusSchema = z.enum(['ok', 'recovery_needed', 'recovery_failed']);
export type ChatRecoveryStatus = z.infer<typeof ChatRecoveryStatusSchema>;

/**
 * Why reconciliation could not finish. The code and the identities are the whole payload: a recovery
 * report is shown to a user and written to logs, so it never carries prompt or tool content.
 */
export const ChatRecoveryIssueCodeSchema = z.enum([
  'malformed_event',
  'unknown_event_version',
  'sequence_gap',
  'conflicting_event',
  'missing_run',
  'context_gap',
  'projection_failed',
  'storage_unavailable',
  'ambiguous_import',
]);
export type ChatRecoveryIssueCode = z.infer<typeof ChatRecoveryIssueCodeSchema>;

export const CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS = 200;

export const ChatRecoveryIssueSchema = z.strictObject({
  code: ChatRecoveryIssueCodeSchema,
  operationId: ChatOperationIdSchema,
  eventId: z.string().nullable(),
  sequence: z.number().int().nonnegative().nullable(),
  /** A reason, never a payload; bounded so a malformed body cannot be echoed back through it. */
  detail: z.string().max(CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS),
});
export type ChatRecoveryIssue = z.infer<typeof ChatRecoveryIssueSchema>;

export const ChatRecoveryReportSchema = z.strictObject({
  sessionId: z.string().min(1),
  operationId: ChatOperationIdSchema,
  status: ChatRecoveryStatusSchema,
  terminalCause: ChatRunTerminalCauseSchema.nullable(),
  appliedSequence: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  /** False when reconciliation found nothing to do, which is what makes repeated startup a no-op. */
  changed: z.boolean(),
  issues: z.array(ChatRecoveryIssueSchema),
});
export type ChatRecoveryReport = z.infer<typeof ChatRecoveryReportSchema>;

export const ChatApprovalOutcomeSchema = z.enum([
  'approved',
  'denied',
  'aborted',
  'timeout',
  'interrupted',
]);
export type ChatApprovalOutcome = z.infer<typeof ChatApprovalOutcomeSchema>;

/**
 * An approval as durable evidence. `actionable` is the only part that depends on a live process:
 * a decided or orphaned approval is still shown as history, but its button does not send a decision
 * to a run that no longer exists.
 */
export const DurableChatApprovalSchema = ChatStreamApprovalSchema.extend({
  toolCallId: z.string().trim().min(1),
  mode: ApprovalModeSchema,
  requestedAtUtc: z.string().datetime(),
  expiresAtUtc: z.string().datetime(),
  outcome: ChatApprovalOutcomeSchema.nullable(),
  decidedAtUtc: z.string().datetime().nullable(),
  actionable: z.boolean(),
});
export type DurableChatApproval = z.infer<typeof DurableChatApprovalSchema>;

/** One projected tool call, carrying the execution state its display status is derived from. */
export const ChatRecoveredToolSchema = z.strictObject({
  toolCallId: z.string().trim().min(1),
  messageId: z.string().min(1),
  executionState: ChatToolExecutionStateSchema,
  toolCallStatus: ToolCallStatusSchema,
});
export type ChatRecoveredTool = z.infer<typeof ChatRecoveredToolSchema>;

/**
 * The consistent view an attaching client starts from: the projected transcript at a known
 * sequence, plus the state that is not a message. Everything after `cursor` arrives as events.
 */
export const ChatOperationSnapshotSchema = z.strictObject({
  sessionId: z.string().min(1),
  operationId: ChatOperationIdSchema,
  operationKind: ChatSessionOperationKindSchema,
  recordKind: ChatRunRecordKindSchema,
  startedAtUtc: z.string().datetime(),
  terminalCause: ChatRunTerminalCauseSchema.nullable(),
  status: ChatRecoveryStatusSchema,
  cursor: ChatEventCursorSchema,
  messages: z.array(ChatTranscriptMessageSchema),
  tools: z.array(ChatRecoveredToolSchema),
  approval: DurableChatApprovalSchema.nullable(),
  issues: z.array(ChatRecoveryIssueSchema),
  /** False while more pages of `messages` remain; the client applies events only once complete. */
  complete: z.boolean(),
});
export type ChatOperationSnapshot = z.infer<typeof ChatOperationSnapshotSchema>;
