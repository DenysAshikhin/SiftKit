import { createHash } from 'node:crypto';
import {
  ApprovalModeSchema,
  ChatApprovalOutcomeSchema,
  ChatQueuedMessageIdSchema,
  ChatRecoveryStatusSchema,
  ChatRunPresentationEventSchema,
  ChatRunTerminalCauseSchema,
  ChatStreamUsageEventSchema,
  ChatToolExecutionStateSchema,
  ChatTranscriptEventSchema,
  ImageDataUrlSchema,
  ImageMetadataSchema,
  PersistedChatTranscriptMessageSchema,
  RepoAgentDecisionSchema,
  ToolActivityKindSchema,
  ToolActivitySubjectSchema,
} from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { stableStringify } from '../../lib/json.js';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.js';
import {
  ChatContextInitSchema,
  ChatContextSpliceReasonSchema,
  PlannerChatMessagesSchema,
} from '../../repo-search/planner-chat-message.js';
import {
  ChatHistoryRevisionSchema,
  ChatImportProvenanceSchema,
  ChatRunStartedEventSchema,
  ChatToolCallIdentitySchema,
} from '../chat-journal-schema.js';
import { ApprovalVerdictSchema } from '../../repo-search/approval-verdict.js';
import type { RuntimeDatabase } from '../database-handle.js';

const LEGACY_EVENT_VERSION = 1;
const UPGRADED_EVENT_VERSION = 2;

/** The v1 queue payload before schema 70 kept metadata beside the message; this shape is migration-only. */
const LegacyQueuedUserMessageSchema = z.strictObject({
  id: ChatQueuedMessageIdSchema,
  turn: z.number().int().nonnegative(),
  boundary: z.enum(['post_tool_batch', 'successor_start']),
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
});

/** Schema 70 wrote the same v1 event with metadata already nested in the message. */
const LegacyQueuedUserMessageWithImageMetaSchema = LegacyQueuedUserMessageSchema.extend({
  imageMeta: z.array(ImageMetadataSchema),
});

/** Frozen v1 splice: the exact top-level keys that shipped. Migration-only. */
const LegacyContextSplicedEventSchema = z.strictObject({
  kind: z.literal('context_spliced'),
  compressedMessageIds: z.array(z.string()).optional(),
  queueMessageIds: z.array(z.string()).optional(),
  expectedRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().positive(),
  startIndex: z.number().int().nonnegative(),
  deleteCount: z.number().int().nonnegative(),
  inserted: PlannerChatMessagesSchema,
  turnBoundary: z.number().int().nonnegative(),
  reason: ChatContextSpliceReasonSchema,
});

const LegacyQueueDeliveredTopLevelEventSchema = z.strictObject({
  kind: z.literal('queue_delivered'),
  message: LegacyQueuedUserMessageSchema,
  imageMeta: z.array(ImageMetadataSchema),
  requestId: z.string().min(1).nullable(),
  deliveredAtUtc: z.string().datetime(),
});

const LegacyQueueDeliveredNestedEventSchema = z.strictObject({
  kind: z.literal('queue_delivered'),
  message: LegacyQueuedUserMessageWithImageMetaSchema,
  requestId: z.string().min(1).nullable(),
  deliveredAtUtc: z.string().datetime(),
});

const LegacyQueueDeliveredEventSchema = z.union([
  LegacyQueueDeliveredTopLevelEventSchema,
  LegacyQueueDeliveredNestedEventSchema,
]);

/** Complete v1 event validation stays here; runtime readers never use this schema. */
const LegacyChatJournalEventSchema = z.union([
  z.strictObject({ kind: z.literal('stop_requested'), requestedAtUtc: z.string().datetime() }),
  z.strictObject({ kind: z.literal('presentation'), event: ChatRunPresentationEventSchema }),
  z.strictObject({ kind: z.literal('submission_cancelled'), userMessageId: z.string().min(1), reason: z.literal('client_disconnected_before_dispatch') }),
  ChatRunStartedEventSchema,
  z.strictObject({ kind: z.literal('engine_bound'), requestId: z.string().min(1), repoAgentSessionId: z.string().min(1).nullable() }),
  z.strictObject({ kind: z.literal('display'), event: ChatTranscriptEventSchema }),
  ChatContextInitSchema.extend({ kind: z.literal('context_initialized') }),
  LegacyContextSplicedEventSchema,
  z.strictObject({
    kind: z.literal('tool_proposed'), call: ChatToolCallIdentitySchema, toolName: z.string().trim().min(1), arguments: JsonObjectSchema,
    command: z.string().min(1), activityKind: ToolActivityKindSchema, activitySubject: ToolActivitySubjectSchema,
    maxTurns: z.number().int().positive(), promptTokenCount: z.number().int().nonnegative(), executionState: ChatToolExecutionStateSchema,
  }),
  z.strictObject({ kind: z.literal('tool_started'), call: ChatToolCallIdentitySchema, startedAtUtc: z.string().datetime() }),
  z.strictObject({
    kind: z.literal('tool_result'), call: ChatToolCallIdentitySchema, executionState: ChatToolExecutionStateSchema,
    exitCode: z.number().int().nullable(), output: z.string(), images: z.array(ImageDataUrlSchema), imageMeta: z.array(ImageMetadataSchema),
    outputTokens: z.number().int().nonnegative(), outputTokensEstimated: z.boolean(), promptTokenCount: z.number().int().nonnegative(),
    finishedAtUtc: z.string().datetime(),
  }),
  z.strictObject({ kind: z.literal('tool_result_finalized'), call: ChatToolCallIdentitySchema, modelVisibleText: z.string(), contextRevision: z.number().int().nonnegative() }),
  z.strictObject({
    kind: z.literal('approval_reviewed'), call: ChatToolCallIdentitySchema, toolName: z.string().trim().min(1),
    command: z.string().min(1), verdict: ApprovalVerdictSchema.shape.verdict, reason: z.string(), reviewedAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('approval_requested'), call: ChatToolCallIdentitySchema, approvalId: z.string().uuid(), toolName: z.string().trim().min(1),
    command: z.string().min(1), reviewPayload: z.string().nullable(), mode: ApprovalModeSchema,
    requestedAtUtc: z.string().datetime(), expiresAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('approval_resolved'), approvalId: z.string().uuid(), outcome: ChatApprovalOutcomeSchema,
    decision: RepoAgentDecisionSchema.nullable(), reason: z.string().nullable(), decidedAtUtc: z.string().datetime(),
  }),
  LegacyQueueDeliveredEventSchema,
  z.strictObject({
    kind: z.literal('run_finished'), terminalCause: ChatRunTerminalCauseSchema, detail: z.string().nullable(),
    usage: ChatStreamUsageEventSchema.nullable(), recoveryStatus: ChatRecoveryStatusSchema, finishedAtUtc: z.string().datetime(),
  }),
  z.strictObject({ kind: z.literal('history_revised'), revision: ChatHistoryRevisionSchema, expectedSessionRevision: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('baseline_imported'), messages: z.array(PersistedChatTranscriptMessageSchema), retainedContext: PlannerChatMessagesSchema, provenance: ChatImportProvenanceSchema }),
]);

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), event_id: z.string(),
  version: z.number().int(), kind: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

function digestBody(body: z.infer<typeof JsonValueSchema>): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * 70 -> 71. Journal events move to version 2: historical splices gain an empty coalescing list and
 * queue metadata moves into the queued message. Every row is validated and its digest is verified
 * before it is touched; an unknown version or corrupt row aborts the whole transaction.
 */
export function upgradeChatJournalEventsToVersion2(database: RuntimeDatabase): void {
  const rows = EventRowsSchema.parse(database.prepare(
    'SELECT operation_id, sequence, event_id, version, kind, body_json, payload_digest FROM chat_run_events ORDER BY operation_id, sequence',
  ).all());
  const update = database.prepare('UPDATE chat_run_events SET version = ?, body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?');
  for (const row of rows) {
    const label = `Chat journal event ${row.event_id} in run ${row.operation_id}`;
    if (row.version !== LEGACY_EVENT_VERSION) throw new Error(`${label} has unsupported version ${String(row.version)}; expected ${String(LEGACY_EVENT_VERSION)}.`);
    let body: z.infer<typeof JsonObjectSchema>;
    try { body = JsonObjectSchema.parse(JSON.parse(row.body_json)); }
    catch (error) { throw new Error(`${label} has a malformed payload.`, { cause: error }); }
    if (digestBody(body) !== row.payload_digest) throw new Error(`${label} has a corrupt payload digest.`);
    let event: z.infer<typeof LegacyChatJournalEventSchema>;
    try { event = LegacyChatJournalEventSchema.parse(body); }
    catch (error) { throw new Error(`${label} has an invalid version-1 payload.`, { cause: error }); }
    if (row.kind !== event.kind) throw new Error(`${label} has a kind column that disagrees with its payload.`);
    if (event.kind === 'context_spliced') {
      const upgraded = JsonObjectSchema.parse({ ...event, coalescedToolCallIds: [] });
      update.run(UPGRADED_EVENT_VERSION, stableStringify(upgraded), digestBody(upgraded), row.operation_id, row.sequence);
    } else if (event.kind === 'queue_delivered') {
      if ('imageMeta' in event) {
        const { imageMeta, ...eventWithoutImageMeta } = event;
        const upgraded = JsonObjectSchema.parse({ ...eventWithoutImageMeta, message: { ...event.message, imageMeta } });
        update.run(UPGRADED_EVENT_VERSION, stableStringify(upgraded), digestBody(upgraded), row.operation_id, row.sequence);
      } else {
        update.run(UPGRADED_EVENT_VERSION, row.body_json, row.payload_digest, row.operation_id, row.sequence);
      }
    } else {
      update.run(UPGRADED_EVENT_VERSION, row.body_json, row.payload_digest, row.operation_id, row.sequence);
    }
  }
}
