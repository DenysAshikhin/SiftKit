import { z } from '../../../lib/zod.ts';
import { VALIDATION_BATCH_MAX, VALIDATION_BATCH_MIN } from '../../validation-queue.ts';
import { VaultChatTurnSchema } from '../chat-turn.ts';

/** What one `vault_write` job asks the note-writer agent to do. */
export const VaultWriterJobSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('capture'), attachmentId: z.string() }).strict(),
  z.object({ source: z.literal('chat'), turn: VaultChatTurnSchema }).strict(),
  z.object({ source: z.literal('review'), noteIds: z.array(z.string()).min(VALIDATION_BATCH_MIN).max(VALIDATION_BATCH_MAX) }).strict(),
]);
export type VaultWriterJob = z.infer<typeof VaultWriterJobSchema>;
