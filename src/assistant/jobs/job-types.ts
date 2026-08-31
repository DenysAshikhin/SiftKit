import { z } from '../../lib/zod.js';

export const ASSISTANT_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'projection_maintenance',
  'question_answer_ingestion',
  'question_planning', 'projection_summarization', 'image_extraction', 'capture_retention',
] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

export const MODEL_BACKED_JOB_TYPES = [
  'conversation_ingestion',
  'candidate_consolidation',
  'question_answer_ingestion',
  'question_planning',
  'projection_summarization',
  'image_extraction',
] as const satisfies readonly AssistantJobType[];

const MODEL_BACKED_JOB_TYPE_SET: ReadonlySet<AssistantJobType> =
  new Set<AssistantJobType>(MODEL_BACKED_JOB_TYPES);

/** §12.1. Gate B enqueues three of these; the rest arrive with their gate. */
export function isModelBackedJobType(jobType: AssistantJobType): boolean {
  return MODEL_BACKED_JOB_TYPE_SET.has(jobType);
}

export const ConversationIngestionPayloadSchema = z.object({
  evidenceId: z.string(),
  sessionId: z.string(),
});
export type ConversationIngestionPayload = z.infer<typeof ConversationIngestionPayloadSchema>;

export const CandidateConsolidationPayloadSchema = z.object({
  candidateIds: z.array(z.string()).min(1),
});
export type CandidateConsolidationPayload = z.infer<typeof CandidateConsolidationPayloadSchema>;

export const ProjectionMaintenancePayloadSchema = z.object({
  reason: z.enum(['graph_changed', 'startup']),
});
export type ProjectionMaintenancePayload = z.infer<typeof ProjectionMaintenancePayloadSchema>;

export const QuestionAnswerIngestionPayloadSchema = z.object({
  questionId: z.string(),
  evidenceId: z.string(),
}).strict();
export type QuestionAnswerIngestionPayload = z.infer<typeof QuestionAnswerIngestionPayloadSchema>;

export const QuestionPlanningPayloadSchema = z.object({
  reason: z.enum(['startup', 'graph_changed', 'schedule']),
}).strict();
export type QuestionPlanningPayload = z.infer<typeof QuestionPlanningPayloadSchema>;

export const ImageExtractionPayloadSchema = z.object({
  evidenceId: z.string(),
}).strict();
export type ImageExtractionPayload = z.infer<typeof ImageExtractionPayloadSchema>;

export const CaptureRetentionPayloadSchema = z.object({
  reason: z.enum(['schedule', 'capacity']),
}).strict();
export type CaptureRetentionPayload = z.infer<typeof CaptureRetentionPayloadSchema>;

export const ProjectionSummarizationPayloadSchema = z.object({
  projectionId: z.string(),
}).strict();
export type ProjectionSummarizationPayload = z.infer<typeof ProjectionSummarizationPayloadSchema>;
