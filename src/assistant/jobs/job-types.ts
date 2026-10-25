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

export const CaptureNotePayloadSchema = z.object({ attachmentId: z.string() }).strict();
export type CaptureNotePayload = z.infer<typeof CaptureNotePayloadSchema>;

export const ChatNotePayloadSchema = VaultChatTurnSchema;
export type ChatNotePayload = z.infer<typeof ChatNotePayloadSchema>;

export const DailyRollupPayloadSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export type DailyRollupPayload = z.infer<typeof DailyRollupPayloadSchema>;

export const NoteTidyPayloadSchema = z.object({ noteId: z.string() }).strict();
export type NoteTidyPayload = z.infer<typeof NoteTidyPayloadSchema>;

export const CaptureRetentionPayloadSchema = z.object({ reason: z.enum(['schedule', 'capacity']) }).strict();
export type CaptureRetentionPayload = z.infer<typeof CaptureRetentionPayloadSchema>;
