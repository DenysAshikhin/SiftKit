import { z } from 'zod';
import { AssistantConfigSchema } from './config.ts';

export const NODE_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const AssistantStatusResponseSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  ownerId: z.string(),
}).strict();
export type AssistantStatusResponse = z.infer<typeof AssistantStatusResponseSchema>;

const CountSchema = z.number().int().min(0);

/** One persisted background-work decision: the reason discriminates its `details` payload. */
function backgroundWorkDecision<Reason extends string, Details extends z.ZodRawShape>(
  reason: Reason,
  details: Details,
) {
  return z.object({
    recordedAtUtc: z.string(),
    reason: z.literal(reason),
    queuedJobCount: CountSchema,
    pendingCaptureCount: CountSchema,
    details: z.object(details).strict(),
  }).strict();
}

export const AssistantBackgroundWorkDecisionDtoSchema = z.discriminatedUnion('reason', [
  backgroundWorkDecision('drain_blocked', { drainBlockers: z.number().int().min(1) }),
  backgroundWorkDecision('assistant_disabled', {}),
  backgroundWorkDecision('drain_already_running', {}),
  backgroundWorkDecision('preemption_requested', {}),
  backgroundWorkDecision('server_busy', {}),
  backgroundWorkDecision('environment_heartbeat_missing', {}),
  backgroundWorkDecision('model_recently_active', {
    secondsSinceModelActivity: CountSchema, requiredIdleSeconds: CountSchema,
  }),
  backgroundWorkDecision('mouse_idle_below_threshold', {
    mouseIdleSeconds: CountSchema, requiredIdleSeconds: CountSchema,
  }),
  backgroundWorkDecision('keyboard_idle_below_threshold', {
    keyboardIdleSeconds: CountSchema, requiredIdleSeconds: CountSchema,
  }),
  backgroundWorkDecision('on_battery', {}),
  backgroundWorkDecision('battery_below_minimum', {}),
  backgroundWorkDecision('daily_gpu_limit', {}),
  backgroundWorkDecision('model_not_resident', {}),
  backgroundWorkDecision('image_capability_unavailable', {}),
  backgroundWorkDecision('no_claimable_job', {}),
]);
export type AssistantBackgroundWorkDecisionDto = z.infer<
  typeof AssistantBackgroundWorkDecisionDtoSchema
>;
export type AssistantBackgroundWorkBlockReason = AssistantBackgroundWorkDecisionDto['reason'];

type BlockOf<Decision> = Decision extends { reason: string; details: object }
  ? Pick<Decision, 'reason' | 'details'>
  : never;
/** A reason with its typed payload, before the store adds the recording metadata. */
export type AssistantBackgroundWorkBlock = BlockOf<AssistantBackgroundWorkDecisionDto>;

export const AssistantBackgroundDecisionHistoryResponseSchema = z.object({
  items: z.array(AssistantBackgroundWorkDecisionDtoSchema).max(100),
}).strict();
export type AssistantBackgroundDecisionHistoryResponse = z.infer<
  typeof AssistantBackgroundDecisionHistoryResponseSchema
>;

/** Runs one queued job now, past the idle and resource gates; without `jobId`, the next one. */
export const AssistantRunJobRequestSchema = z.object({ jobId: z.string().min(1).optional() }).strict();

/** `detail` is the error of a failed job or the block reason of a preempted or blocked one. */
export const AssistantRunJobResponseSchema = z.object({
  jobId: z.string(),
  jobType: z.string(),
  outcome: z.enum(['completed', 'failed', 'preempted', 'blocked']),
  detail: z.string().nullable(),
}).strict();
export type AssistantRunJobResponse = z.infer<typeof AssistantRunJobResponseSchema>;

export const AssistantConfigPatchRequestSchema = z.object({
  assistant: AssistantConfigSchema,
}).strict();
export type AssistantConfigPatchRequest = z.infer<typeof AssistantConfigPatchRequestSchema>;

export const AssistantFactoryResetPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  tableCounts: z.record(z.string(), z.number().int().min(0)),
  blobCount: z.number().int().min(0),
  blobBytes: z.number().int().min(0),
}).strict();
export type AssistantFactoryResetPreview = z.infer<typeof AssistantFactoryResetPreviewSchema>;

export const AssistantConfirmTokenRequestSchema = z.object({
  previewToken: z.string().min(1),
}).strict();
export type AssistantConfirmTokenRequest = z.infer<typeof AssistantConfirmTokenRequestSchema>;

export const AssistantExportRequestSchema = z.object({
  includeDecryptedBlobs: z.boolean(),
}).strict();
export type AssistantExportRequest = z.infer<typeof AssistantExportRequestSchema>;

export const AssistantRestorePreviewResponseSchema = z.object({
  uploadId: z.string(),
  confirmToken: z.string(),
  schemaVersion: z.number().int().positive(),
  custody: z.enum(['file', 'desktop']),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
}).strict();
export type AssistantRestorePreviewResponse = z.infer<
  typeof AssistantRestorePreviewResponseSchema
>;

export const AssistantRestoreConfirmRequestSchema = z.object({
  uploadId: z.string().min(1),
  confirmToken: z.string().min(1),
}).strict();
export type AssistantRestoreConfirmRequest = z.infer<
  typeof AssistantRestoreConfirmRequestSchema
>;

export const AssistantRestoreResultSchema = z.object({
  ok: z.literal(true),
  /** False when DPAPI could not unseal the backup key on this machine — never silent. */
  blobsReadable: z.boolean(),
  warning: z.string().nullable(),
}).strict();
export type AssistantRestoreResult = z.infer<typeof AssistantRestoreResultSchema>;

/** Recovery fields a conflict can carry beside its code and message. */
export const AssistantErrorDetailsSchema = z.object({ currentRevision: z.number().int().min(1).optional() }).strict();
export type AssistantErrorDetails = z.infer<typeof AssistantErrorDetailsSchema>;

export const AssistantErrorResponseSchema = z.object({
  error: AssistantErrorDetailsSchema.extend({ code: z.string(), message: z.string() }).strict(),
}).strict();
export type AssistantErrorResponse = z.infer<typeof AssistantErrorResponseSchema>;
