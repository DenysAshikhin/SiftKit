import { PerceptualHashSchema } from '@siftkit/contracts';

import { z } from '../../lib/zod.js';

import {
  ActorTypeSchema, AliasTypeSchema, AssertionBasisSchema, AssertionStatusSchema,
  CandidateStatusSchema, CaptureQueueStateSchema,
  DeviceStatusSchema, EvidenceSourceTypeSchema, EvidenceStanceSchema,
  EvidenceStatusSchema, JobStatusSchema, MutationOperationSchema, NodeStatusSchema,
  ObjectKindSchema, ObservationTypeSchema, ObjectValueTypeSchema, PolicySourceSchema,
  PolicyTypeSchema, ProjectionStatusSchema, QuestionFeedbackTypeSchema, QuestionStatusSchema,
  QuestionTypeSchema, SensitivitySchema,
} from '../domain/enums.js';
import { NodeTypeSchema } from '../domain/node-types.js';
import { RelationTypeSchema } from '../domain/relation-types.js';
import { AssistantJobTypeSchema } from '../jobs/job-types.js';

const SqliteBooleanSchema = z.number().int().min(0).max(1).transform((value) => value === 1);

export const OwnerRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type OwnerRow = z.infer<typeof OwnerRowSchema>;

export const DeviceRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  platform: z.string(),
  display_name: z.string(),
  public_key: z.string().nullable(),
  status: DeviceStatusSchema,
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type DeviceRow = z.infer<typeof DeviceRowSchema>;

export const NodeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  type: NodeTypeSchema,
  canonical_key: z.string().nullable(),
  display_name: z.string(),
  description: z.string().nullable(),
  sensitivity: SensitivitySchema,
  status: NodeStatusSchema,
  properties_json: z.string(),
  merged_into_node_id: z.string().nullable(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
  fts_rowid: z.number().int().nullable(),
});
export type NodeRow = z.infer<typeof NodeRowSchema>;

export const AliasRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  node_id: z.string(),
  alias: z.string(),
  normalized_alias: z.string(),
  alias_type: AliasTypeSchema,
  source_evidence_id: z.string().nullable(),
  created_at_utc: z.string(),
});
export type AliasRow = z.infer<typeof AliasRowSchema>;

export const AssertionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  assertion_key: z.string(),
  subject_node_id: z.string(),
  predicate: RelationTypeSchema,
  object_kind: ObjectKindSchema,
  object_node_id: z.string().nullable(),
  object_value_type: ObjectValueTypeSchema.nullable(),
  object_value_json: z.string().nullable(),
  object_normalized_text: z.string().nullable(),
  scope_node_id: z.string().nullable(),
  status: AssertionStatusSchema,
  basis: AssertionBasisSchema,
  confidence: z.number(),
  sensitivity: SensitivitySchema,
  valid_from_utc: z.string().nullable(),
  valid_to_utc: z.string().nullable(),
  first_observed_at_utc: z.string(),
  last_observed_at_utc: z.string(),
  recorded_at_utc: z.string(),
  retired_at_utc: z.string().nullable(),
  supersedes_assertion_id: z.string().nullable(),
  pinned: SqliteBooleanSchema,
  user_demoted: SqliteBooleanSchema,
  attributes_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
  fts_rowid: z.number().int().nullable(),
});
export type AssertionRow = z.infer<typeof AssertionRowSchema>;

export const AssertionEvidenceRowSchema = z.object({
  assertion_id: z.string(),
  evidence_id: z.string(),
  stance: EvidenceStanceSchema,
  weight: z.number(),
  created_at_utc: z.string(),
});
export type AssertionEvidenceRow = z.infer<typeof AssertionEvidenceRowSchema>;

export const EvidenceRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  device_id: z.string().nullable(),
  source_event_id: z.string(),
  parent_evidence_id: z.string().nullable(),
  blob_id: z.string().nullable(),
  source_type: EvidenceSourceTypeSchema,
  source_ref: z.string().nullable(),
  captured_at_utc: z.string(),
  source_timezone: z.string().nullable(),
  ingested_at_utc: z.string(),
  content_hash: z.string(),
  mime_type: z.string().nullable(),
  sensitivity: SensitivitySchema,
  retention_until_utc: z.string().nullable(),
  status: EvidenceStatusSchema,
  metadata_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

export const BlobRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  content_hash: z.string(),
  byte_length: z.number().int(),
  mime_type: z.string(),
  storage_uri: z.string(),
  encrypted: SqliteBooleanSchema,
  key_id: z.string().nullable(),
  created_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
});
export type BlobRow = z.infer<typeof BlobRowSchema>;

export const MergeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  basis: z.string(),
  reversible: SqliteBooleanSchema,
  created_at_utc: z.string(),
  reversed_at_utc: z.string().nullable(),
});
export type MergeRow = z.infer<typeof MergeRowSchema>;

export const MutationLogRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  actor_type: ActorTypeSchema,
  actor_ref: z.string().nullable(),
  operation: MutationOperationSchema,
  target_type: z.string(),
  target_id: z.string(),
  before_json: z.string().nullable(),
  after_json: z.string().nullable(),
  reason: z.string(),
  created_at_utc: z.string(),
});
export type MutationLogRow = z.infer<typeof MutationLogRowSchema>;

export const PolicyRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  policy_type: PolicyTypeSchema,
  key: z.string(),
  value_json: z.string(),
  enabled: SqliteBooleanSchema,
  source: PolicySourceSchema,
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type PolicyRow = z.infer<typeof PolicyRowSchema>;

export const AuditEventRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  event_type: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  summary: z.string(),
  details_json: z.string(),
  created_at_utc: z.string(),
});
export type AuditEventRow = z.infer<typeof AuditEventRowSchema>;

export const MetadataValueRowSchema = z.object({ value: z.string() });
export const CountRowSchema = z.object({ count: z.number() });

export const ObservationRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  evidence_id: z.string(),
  observation_type: ObservationTypeSchema,
  payload_json: z.string(),
  confidence: z.number(),
  sensitivity: SensitivitySchema,
  extractor_name: z.string(),
  extractor_version: z.string(),
  created_at_utc: z.string(),
});
export type ObservationRow = z.infer<typeof ObservationRowSchema>;

export const CandidateRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  observation_id: z.string().nullable(),
  candidate_fingerprint: z.string(),
  subject_ref_json: z.string(),
  predicate: RelationTypeSchema,
  object_ref_json: z.string(),
  scope_ref_json: z.string().nullable(),
  basis: AssertionBasisSchema,
  confidence: z.number(),
  sensitivity: SensitivitySchema,
  valid_from_utc: z.string().nullable(),
  valid_to_utc: z.string().nullable(),
  rationale: z.string(),
  status: CandidateStatusSchema,
  rejection_reason: z.string().nullable(),
  user_notes: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type CandidateRow = z.infer<typeof CandidateRowSchema>;

export const ProjectionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  tier: z.number().int().min(1).max(3),
  topic_key: z.string(),
  relative_path: z.string(),
  title: z.string(),
  content: z.string(),
  content_hash: z.string(),
  token_count: z.number().int(),
  tokenizer_id: z.string(),
  graph_version: z.number().int(),
  included_assertion_ids_json: z.string(),
  sensitivity: SensitivitySchema,
  generated_at_utc: z.string(),
  last_retrieved_at_utc: z.string().nullable(),
  retrieval_count: z.number().int(),
  utility_score: z.number(),
  status: ProjectionStatusSchema,
  fts_rowid: z.number().int().nullable(),
});
export type ProjectionRow = z.infer<typeof ProjectionRowSchema>;

export const JobRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  job_type: AssistantJobTypeSchema,
  priority: z.number().int(),
  payload_json: z.string(),
  idempotency_key: z.string(),
  status: JobStatusSchema,
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  available_at_utc: z.string(),
  lease_owner: z.string().nullable(),
  lease_expires_at_utc: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type JobRow = z.infer<typeof JobRowSchema>;

export const QuestionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  topic_key: z.string(),
  question_text: z.string(),
  question_type: QuestionTypeSchema,
  candidate_ids_json: z.string(),
  expected_value: z.number(),
  interruption_cost: z.number(),
  status: QuestionStatusSchema,
  eligible_after_utc: z.string().nullable(),
  expires_at_utc: z.string().nullable(),
  shown_at_utc: z.string().nullable(),
  answered_at_utc: z.string().nullable(),
  answer_evidence_id: z.string().nullable(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type QuestionRow = z.infer<typeof QuestionRowSchema>;

export const QuestionFeedbackRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  question_id: z.string().nullable(),
  feedback_type: QuestionFeedbackTypeSchema,
  value_json: z.string(),
  created_at_utc: z.string(),
});
export type QuestionFeedbackRow = z.infer<typeof QuestionFeedbackRowSchema>;

export const RetrievalUsageRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  conversation_id: z.string().nullable(),
  query_hash: z.string(),
  assertion_ids_json: z.string(),
  projection_ids_json: z.string(),
  rendered_token_count: z.number().int().min(0),
  usefulness_feedback: z.number().min(-1).max(1).nullable(),
  created_at_utc: z.string(),
});
export type RetrievalUsageRow = z.infer<typeof RetrievalUsageRowSchema>;

export const ActivityEventRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  captured_at_utc: z.string(),
  application_id: z.string().nullable(),
  process_name: z.string().nullable(),
  normalized_title: z.string().nullable(),
  fullscreen: SqliteBooleanSchema,
  idle_seconds: z.number().int().min(0),
  session_locked: SqliteBooleanSchema,
  session_id: z.string().nullable(),
});
export type ActivityEventRow = z.infer<typeof ActivityEventRowSchema>;

export const ActivitySessionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  application_id: z.string().nullable(),
  process_name: z.string().nullable(),
  started_at_utc: z.string(),
  ended_at_utc: z.string().nullable(),
  event_count: z.number().int().min(0),
});
export type ActivitySessionRow = z.infer<typeof ActivitySessionRowSchema>;

export const CaptureQueueRowSchema = z.object({
  evidence_id: z.string(),
  owner_id: z.string(),
  state: CaptureQueueStateSchema,
  foreground_context_key: z.string(),
  pixel_sha256: z.string(),
  perceptual_hash: PerceptualHashSchema,
  byte_length: z.number().int().positive(),
  enqueued_at_utc: z.string(),
  processed_at_utc: z.string().nullable(),
  updated_at_utc: z.string(),
});
export type CaptureQueueRow = z.infer<typeof CaptureQueueRowSchema>;

export const IdRowSchema = z.object({ id: z.string() });
