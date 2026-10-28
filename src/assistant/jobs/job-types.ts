import type { AssistantConfig } from '../../config/types.ts';
import { z } from '../../lib/zod.ts';
import { VaultWriterJobSchema, type VaultWriterJob } from '../../vault/note-writer/agent/writer-job.ts';

export const ASSISTANT_JOB_TYPES = ['vault_write', 'vault_maintenance'] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

export const MODEL_BACKED_JOB_TYPES = ['vault_write'] as const satisfies readonly AssistantJobType[];

const MODEL_BACKED_JOB_TYPE_SET: ReadonlySet<AssistantJobType> = new Set<AssistantJobType>(MODEL_BACKED_JOB_TYPES);

/** §12.1: model-backed jobs wait for the residency and resource gates; maintenance never touches the model. */
export function isModelBackedJobType(jobType: AssistantJobType): boolean {
  return MODEL_BACKED_JOB_TYPE_SET.has(jobType);
}

/** A job as enqueued: its type and the payload that type carries. */
export const AssistantJobRequestSchema = z.discriminatedUnion('jobType', [
  z.object({ jobType: z.literal('vault_write'), payload: VaultWriterJobSchema }).strict(),
  z.object({ jobType: z.literal('vault_maintenance'), payload: z.object({}).strict() }).strict(),
]);
export type AssistantJobRequest = z.infer<typeof AssistantJobRequestSchema>;

export const VAULT_MAINTENANCE_REQUEST = { jobType: 'vault_maintenance', payload: {} } as const satisfies AssistantJobRequest;

/** The configured priority of a request; a write's priority follows its source. */
export function jobPriority(priorities: AssistantConfig['Background']['JobPriorities'], request: AssistantJobRequest): number {
  if (request.jobType === 'vault_maintenance') return priorities.Maintenance;
  switch (request.payload.source) {
    case 'capture': return priorities.CaptureWrite;
    case 'chat': return priorities.ChatWrite;
    case 'review': return priorities.Review;
  }
}

const vaultWriteKey = (job: VaultWriterJob): string => {
  switch (job.source) {
    case 'capture': return `vault_write:capture:${job.attachmentId}`;
    case 'chat': return `vault_write:chat:${job.turn.sessionId}:${job.turn.userMessageId}`;
    case 'review': return 'vault_write:review';
  }
};

/** One live job per key, so re-enqueueing the same work is a no-op. */
export function jobIdempotencyKey(request: AssistantJobRequest): string {
  return request.jobType === 'vault_maintenance' ? 'vault_maintenance' : vaultWriteKey(request.payload);
}
