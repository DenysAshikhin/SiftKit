import type { AssistantConfig } from '../../config/types.ts';
import { z } from '../../lib/zod.ts';
import { VaultChatTurnSchema } from '../../vault/note-writer/chat-writer.ts';

export const ASSISTANT_JOB_TYPES = ['capture_note', 'chat_note', 'daily_rollup', 'note_tidy', 'capture_retention'] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

export const MODEL_BACKED_JOB_TYPES = ['capture_note', 'chat_note', 'note_tidy'] as const satisfies readonly AssistantJobType[];

const MODEL_BACKED_JOB_TYPE_SET: ReadonlySet<AssistantJobType> = new Set<AssistantJobType>(MODEL_BACKED_JOB_TYPES);

/** §12.1: model-backed jobs wait for the residency and resource gates; the rest never touch the model. */
export function isModelBackedJobType(jobType: AssistantJobType): boolean {
  return MODEL_BACKED_JOB_TYPE_SET.has(jobType);
}

/** The configured priority of a job type (§12.2). */
export function jobPriority(priorities: AssistantConfig['Background']['JobPriorities'], jobType: AssistantJobType): number {
  switch (jobType) {
    case 'capture_note':
      return priorities.CaptureNote;
    case 'chat_note':
      return priorities.ChatNote;
    case 'daily_rollup':
      return priorities.DailyRollup;
    case 'note_tidy':
      return priorities.NoteTidy;
    case 'capture_retention':
      return priorities.CaptureRetention;
  }
}

/** A job as enqueued: its type and the payload that type carries. */
export const AssistantJobRequestSchema = z.discriminatedUnion('jobType', [
  z.object({ jobType: z.literal('capture_note'), payload: z.object({ attachmentId: z.string() }).strict() }).strict(),
  z.object({ jobType: z.literal('chat_note'), payload: VaultChatTurnSchema }).strict(),
  z.object({ jobType: z.literal('daily_rollup'), payload: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict() }).strict(),
  z.object({ jobType: z.literal('note_tidy'), payload: z.object({ noteId: z.string() }).strict() }).strict(),
  z.object({ jobType: z.literal('capture_retention'), payload: z.object({}).strict() }).strict(),
]);
export type AssistantJobRequest = z.infer<typeof AssistantJobRequestSchema>;

/** One live job per key, so re-enqueueing the same work is a no-op. */
export function jobIdempotencyKey(request: AssistantJobRequest): string {
  switch (request.jobType) {
    case 'capture_note':
      return `capture_note:${request.payload.attachmentId}`;
    case 'chat_note':
      return `chat_note:${request.payload.sessionId}:${request.payload.userMessageId}`;
    case 'daily_rollup':
      return `daily_rollup:${request.payload.day}`;
    case 'note_tidy':
      return `note_tidy:${request.payload.noteId}`;
    case 'capture_retention':
      return 'capture_retention';
  }
}
