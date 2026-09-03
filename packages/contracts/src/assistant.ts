import { z } from 'zod';
import { AssistantConfigSchema } from './config.js';
import { JsonObjectSchema } from './primitives.js';

const SensitivitySchema = z.enum([
  'low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited',
]);

export const AssistantStatusResponseSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  ownerId: z.string(),
  pendingQuestionCount: z.number().int().min(0),
  pendingValidationCount: z.number().int().min(0),
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

export const AssistantConfigPatchRequestSchema = z.object({
  assistant: AssistantConfigSchema,
}).strict();
export type AssistantConfigPatchRequest = z.infer<typeof AssistantConfigPatchRequestSchema>;

export const AssistantNodeSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  displayName: z.string(),
  sensitivity: SensitivitySchema,
}).strict();
export type AssistantNodeSummary = z.infer<typeof AssistantNodeSummarySchema>;

export const AssistantNodeDetailSchema = AssistantNodeSummarySchema.extend({
  canonicalKey: z.string().nullable(),
  description: z.string().nullable(),
  properties: JsonObjectSchema,
  aliases: z.array(z.string()),
  /** Whether this node is the assistant owner, so the control surface need not know the key. */
  isOwner: z.boolean(),
  status: z.string(),
}).strict();
export type AssistantNodeDetail = z.infer<typeof AssistantNodeDetailSchema>;

/** The owner confirming a duplicate `person` node names them. Merges it into the owner node. */
export const AssistantClaimOwnerResponseSchema = z.object({
  ok: z.literal(true),
  graphVersion: z.number().int().min(0),
  mergeId: z.string(),
  ownerNodeId: z.string(),
  movedAssertionCount: z.number().int().min(0),
  movedAliases: z.array(z.string()),
}).strict();
export type AssistantClaimOwnerResponse = z.infer<typeof AssistantClaimOwnerResponseSchema>;

export const AssistantAssertionDtoSchema = z.object({
  id: z.string(),
  subjectNodeId: z.string(),
  predicate: z.string(),
  objectText: z.string(),
  scopeText: z.string(),
  status: z.string(),
  basis: z.string(),
  confidence: z.number().min(0).max(1),
  sensitivity: SensitivitySchema,
  pinned: z.boolean(),
  userDemoted: z.boolean(),
  validFromUtc: z.string().nullable(),
  validToUtc: z.string().nullable(),
  lastObservedAtUtc: z.string(),
}).strict();
export type AssistantAssertionDto = z.infer<typeof AssistantAssertionDtoSchema>;

export const AssistantAssertionExplanationSchema = z.object({
  assertion: AssistantAssertionDtoSchema,
  evidenceIds: z.array(z.string()),
  mutationIds: z.array(z.string()),
}).strict();
export type AssistantAssertionExplanation = z.infer<typeof AssistantAssertionExplanationSchema>;

export const AssistantEvidenceDtoSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceRef: z.string().nullable(),
  capturedAtUtc: z.string(),
  sensitivity: SensitivitySchema,
  status: z.string(),
  metadata: JsonObjectSchema,
  contentAvailable: z.boolean(),
  contentRevealed: z.boolean(),
}).strict();
export type AssistantEvidenceDto = z.infer<typeof AssistantEvidenceDtoSchema>;

export const AssistantProjectionDtoSchema = z.object({
  id: z.string(),
  tier: z.number().int().min(1).max(3),
  topicKey: z.string(),
  title: z.string(),
  tokenCount: z.number().int().min(0),
  sensitivity: SensitivitySchema,
  graphVersion: z.number().int().min(0),
  content: z.string(),
}).strict();
export type AssistantProjectionDto = z.infer<typeof AssistantProjectionDtoSchema>;

export const AssistantQuestionDtoSchema = z.object({
  id: z.string(),
  topicKey: z.string(),
  questionText: z.string(),
  questionType: z.enum([
    'confirm_inference', 'resolve_conflict', 'clarify_scope',
    'follow_active_goal', 'fill_relevant_gap',
  ]),
  status: z.enum(['planned', 'eligible', 'shown', 'answered', 'dismissed', 'snoozed', 'expired', 'blocked']),
  eligibleAfterUtc: z.string().nullable(),
  expiresAtUtc: z.string().nullable(),
  createdAtUtc: z.string(),
}).strict();
export type AssistantQuestionDto = z.infer<typeof AssistantQuestionDtoSchema>;

export const AssistantPolicyDtoSchema = z.object({
  id: z.string(),
  policyType: z.string(),
  topicKey: z.string().nullable(),
  active: z.boolean(),
}).strict();
export type AssistantPolicyDto = z.infer<typeof AssistantPolicyDtoSchema>;

export const AssistantValidationCandidateDtoSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'needs_confirmation']),
  proposedStatement: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  sensitivity: SensitivitySchema,
  evidenceId: z.string().nullable(),
  userNotes: z.string(),
  createdAtUtc: z.string(),
  /** Why the candidate is held, e.g. a sensitive topic or `possible_owner_alias`. */
  confirmationReason: z.string().nullable(),
  /** The name an identity question is about; null unless the reason is `possible_owner_alias`. */
  identityName: z.string().nullable(),
}).strict();
export type AssistantValidationCandidateDto = z.infer<typeof AssistantValidationCandidateDtoSchema>;

export const AssistantResolveIdentityRequestSchema = z.object({
  isOwner: z.boolean(),
}).strict();
export type AssistantResolveIdentityRequest =
  z.infer<typeof AssistantResolveIdentityRequestSchema>;

export const AssistantValidationNotesRequestSchema = z.object({
  notes: z.string().max(10_000),
}).strict();
export type AssistantValidationNotesRequest = z.infer<typeof AssistantValidationNotesRequestSchema>;

export const AssistantMemoryHistoryEntryDtoSchema = z.object({
  id: z.string(),
  operation: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  summary: z.string(),
  reason: z.string(),
  proofs: z.array(z.object({
    evidenceId: z.string(),
    sourceType: z.string(),
    sourceRef: z.string().nullable(),
  }).strict()),
  createdAtUtc: z.string(),
}).strict();
export type AssistantMemoryHistoryEntryDto = z.infer<
  typeof AssistantMemoryHistoryEntryDtoSchema
>;

export const AssistantDestructiveRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preview') }).strict(),
  z.object({ mode: z.literal('confirm'), previewToken: z.string().min(1) }).strict(),
]);
export type AssistantDestructiveRequest = z.infer<typeof AssistantDestructiveRequestSchema>;

export const AssistantMutationRequestSchema = z.object({ reason: z.string().trim().min(1) }).strict();
export type AssistantMutationRequest = z.infer<typeof AssistantMutationRequestSchema>;

export const AssistantMutationResponseSchema = z.object({
  ok: z.literal(true),
  graphVersion: z.number().int().min(0),
}).strict();
export type AssistantMutationResponse = z.infer<typeof AssistantMutationResponseSchema>;

export const AssistantDeletionPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  targetAssertionId: z.string(),
  affectedProjectionIds: z.array(z.string()),
  dependentAssertionIds: z.array(z.string()),
}).strict();
export type AssistantDeletionPreview = z.infer<typeof AssistantDeletionPreviewSchema>;

export const AssistantEvidenceDeletionPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  targetEvidenceId: z.string(),
  dependentAssertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();
export type AssistantEvidenceDeletionPreview = z.infer<
  typeof AssistantEvidenceDeletionPreviewSchema
>;

export const AssistantTopicForgetPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  topicKey: z.string(),
  assertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();
export type AssistantTopicForgetPreview = z.infer<typeof AssistantTopicForgetPreviewSchema>;

export const AssistantTopicForgetRequestSchema = z.object({
  topicKey: z.string().trim().min(1),
  /** Also writes a `never_infer_topic` policy so the topic cannot come back by inference. */
  addPolicy: z.boolean(),
  previewToken: z.string().min(1),
}).strict();
export type AssistantTopicForgetRequest = z.infer<typeof AssistantTopicForgetRequestSchema>;

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

export const MobileEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1),
  monotonicTimestamp: z.number().int().positive(),
  nonce: z.string().min(8),
  consent: z.object({ memory: z.boolean(), sensitive: z.boolean() }).strict(),
  sensitivity: z.enum(['low', 'personal', 'sensitive', 'highly_sensitive']),
  payload: z.object({ kind: z.literal('text'), text: z.string().min(1) }).strict(),
  /** base64 Ed25519 signature over the canonical signing payload (see EnvelopeVerifier). */
  signature: z.string().min(1),
}).strict();
export type MobileEnvelope = z.infer<typeof MobileEnvelopeSchema>;

export const AssistantErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).strict(),
}).strict();
export type AssistantErrorResponse = z.infer<typeof AssistantErrorResponseSchema>;
