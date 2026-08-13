import { z } from '../../lib/zod.js';

export const SENSITIVITIES = [
  'low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited',
] as const;
export const SensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const SENSITIVITY_RANK = {
  low: 0,
  personal: 1,
  sensitive: 2,
  highly_sensitive: 3,
  secret_prohibited: 4,
} as const satisfies Record<Sensitivity, number>;

export function isSensitivityAtLeast(value: Sensitivity, floor: Sensitivity): boolean {
  return SENSITIVITY_RANK[value] >= SENSITIVITY_RANK[floor];
}

/** Combines independent classifications. Sensitivity only ever ratchets up. */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return isSensitivityAtLeast(a, b) ? a : b;
}

/** Content at or above this sensitivity never reaches a plaintext index (§5.3). */
const FTS_EXCLUSION_FLOOR: Sensitivity = 'sensitive';

/**
 * Whether content at this sensitivity may be written to a plaintext FTS table. The single
 * definition of the exclusion floor: every index that stores plaintext gates on this.
 */
export function isIndexableInPlaintext(sensitivity: Sensitivity): boolean {
  return !isSensitivityAtLeast(sensitivity, FTS_EXCLUSION_FLOOR);
}

export const ASSERTION_STATUSES = [
  'active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted',
] as const;
export const AssertionStatusSchema = z.enum(ASSERTION_STATUSES);
export type AssertionStatus = z.infer<typeof AssertionStatusSchema>;

export const ASSERTION_BASES = [
  'explicit_user_statement', 'explicit_question_answer', 'manual_import',
  'passive_observation', 'derived_aggregation', 'assistant_inference',
] as const;
export const AssertionBasisSchema = z.enum(ASSERTION_BASES);
export type AssertionBasis = z.infer<typeof AssertionBasisSchema>;

/** Bases sourced from a deliberate human statement. These outrank passive evidence, always. */
export const EXPLICIT_BASES = [
  'explicit_user_statement', 'explicit_question_answer', 'manual_import',
] as const;
/** Bases produced without a deliberate human statement. */
export const PASSIVE_BASES = [
  'passive_observation', 'derived_aggregation', 'assistant_inference',
] as const;

export function isExplicitBasis(basis: AssertionBasis): boolean {
  return EXPLICIT_BASES.some((explicit) => explicit === basis);
}

export const NODE_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const ALIAS_TYPES = [
  'name', 'handle', 'model', 'path', 'identifier', 'user_supplied',
] as const;
export const AliasTypeSchema = z.enum(ALIAS_TYPES);
export type AliasType = z.infer<typeof AliasTypeSchema>;

export const EVIDENCE_SOURCE_TYPES = [
  'conversation_message', 'question_answer', 'manual_correction', 'manual_import',
  'desktop_activity', 'screenshot', 'accessibility_snapshot', 'ocr_result', 'mobile_event',
] as const;
export const EvidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EVIDENCE_STATUSES = ['active', 'expired', 'quarantined', 'deleted'] as const;
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EVIDENCE_STANCES = ['supports', 'contradicts', 'context'] as const;
export const EvidenceStanceSchema = z.enum(EVIDENCE_STANCES);
export type EvidenceStance = z.infer<typeof EvidenceStanceSchema>;

export const OBJECT_KINDS = ['node', 'literal'] as const;
export const ObjectKindSchema = z.enum(OBJECT_KINDS);
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

export const OBJECT_VALUE_TYPES = [
  'string', 'integer', 'number', 'boolean', 'date', 'datetime',
  'duration', 'quantity', 'json',
] as const;
export const ObjectValueTypeSchema = z.enum(OBJECT_VALUE_TYPES);
export type ObjectValueType = z.infer<typeof ObjectValueTypeSchema>;

export const ACTOR_TYPES = ['user', 'system', 'assistant_proposal', 'migration'] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const MUTATION_OPERATIONS = [
  'create_node', 'update_node', 'merge_node', 'unmerge_node', 'create_assertion',
  'confirm_assertion', 'update_assertion', 'supersede_assertion', 'dispute_assertion',
  'reject_assertion', 'expire_assertion', 'delete_assertion', 'delete_evidence',
  'update_policy',
] as const;
export const MutationOperationSchema = z.enum(MUTATION_OPERATIONS);
export type MutationOperation = z.infer<typeof MutationOperationSchema>;

export const POLICY_TYPES = [
  'blocked_question_topic', 'never_infer_topic', 'capture_exclusion',
  'do_not_merge_node', 'assertion_lock',
] as const;
export const PolicyTypeSchema = z.enum(POLICY_TYPES);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

export const POLICY_SOURCES = ['default', 'user', 'migration'] as const;
export const PolicySourceSchema = z.enum(POLICY_SOURCES);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

export const CAPTURE_QUEUE_STATES = [
  'queued', 'awaiting_image_capability', 'processing', 'processed',
  'expired', 'evicted', 'discarded',
] as const;
export const CaptureQueueStateSchema = z.enum(CAPTURE_QUEUE_STATES);
export type CaptureQueueState = z.infer<typeof CaptureQueueStateSchema>;

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export const DeviceStatusSchema = z.enum(DEVICE_STATUSES);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const CANDIDATE_STATUSES = [
  'pending', 'accepted', 'rejected', 'needs_confirmation', 'superseded',
] as const;
export const CandidateStatusSchema = z.enum(CANDIDATE_STATUSES);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const JOB_STATUSES = [
  'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'dead_letter',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Live statuses hold the unique idempotency slot, so a replayed enqueue is a no-op (§12.2). */
export const LIVE_JOB_STATUSES = ['queued', 'running', 'paused'] as const;

export const PROJECTION_STATUSES = ['active', 'demoted', 'archived', 'deleted'] as const;
export const ProjectionStatusSchema = z.enum(PROJECTION_STATUSES);
export type ProjectionStatus = z.infer<typeof ProjectionStatusSchema>;

export const OBSERVATION_TYPES = [
  'conversation_statement', 'conversation_correction', 'conversation_request',
  'conversation_third_party', 'conversation_hypothetical', 'conversation_quotation',
  'desktop_activity_session', 'screenshot_extraction',
] as const;
export const ObservationTypeSchema = z.enum(OBSERVATION_TYPES);
export type ObservationType = z.infer<typeof ObservationTypeSchema>;

export const QUESTION_TYPES = [
  'confirm_inference', 'resolve_conflict', 'clarify_scope',
  'follow_active_goal', 'fill_relevant_gap',
] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const QUESTION_STATUSES = [
  'planned', 'eligible', 'shown', 'answered', 'dismissed', 'snoozed', 'expired', 'blocked',
] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QUESTION_FEEDBACK_TYPES = [
  'answer', 'skip', 'snooze', 'do_not_repeat', 'block_topic',
  'change_schedule', 'change_rate_limit',
] as const;
export const QuestionFeedbackTypeSchema = z.enum(QUESTION_FEEDBACK_TYPES);
export type QuestionFeedbackType = z.infer<typeof QuestionFeedbackTypeSchema>;
