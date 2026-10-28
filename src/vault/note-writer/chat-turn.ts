import { z } from '../../lib/zod.ts';

/** One finished chat turn, as the chat seam hands it to the note-writer. */
export const VaultChatTurnSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  userMessageId: z.string(),
  capturedAtUtc: z.string().datetime(),
  userText: z.string(),
  /** The final answer only; hidden reasoning is never passed in. */
  assistantText: z.string(),
}).strict();
export type VaultChatTurn = z.infer<typeof VaultChatTurnSchema>;
