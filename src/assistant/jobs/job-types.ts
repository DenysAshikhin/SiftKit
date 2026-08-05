import { z } from '../../lib/zod.js';

export const ASSISTANT_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'projection_maintenance',
] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

/** §12.1. Gate B enqueues three of these; the rest arrive with their gate. */
export const JOB_PRIORITY = {
  conversation_ingestion: 800,
  candidate_consolidation: 400,
  projection_maintenance: 300,
} as const satisfies Record<AssistantJobType, number>;

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