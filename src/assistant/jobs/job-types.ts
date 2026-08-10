import { z } from '../../lib/zod.js';

export const ASSISTANT_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'projection_maintenance',
  'question_answer_ingestion',
  'question_planning', 'projection_summarization',
] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

/** §12.1. Gate B enqueues three of these; the rest arrive with their gate. */
export function isModelBackedJobType(jobType: AssistantJobType): boolean {
  return jobType === 'conversation_ingestion'
    || jobType === 'candidate_consolidation'
    || jobType === 'question_answer_ingestion'
    || jobType === 'question_planning'
    || jobType === 'projection_summarization';
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

export const ProjectionSummarizationPayloadSchema = z.object({
  projectionId: z.string(),
}).strict();
export type ProjectionSummarizationPayload = z.infer<typeof ProjectionSummarizationPayloadSchema>;
