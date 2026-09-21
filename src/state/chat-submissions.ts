import { ChatOperationIdSchema, ChatSessionOperationKindSchema, ChatSubmissionIdSchema } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { digestStableJson } from '../lib/json-digest.js';
import type { JsonObject } from '../lib/json-types.js';
import type { RuntimeDatabase } from './database-handle.js';

export const ChatSubmissionReceiptSchema = z.strictObject({
  sessionId: z.string().min(1),
  submissionId: ChatSubmissionIdSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  runOperationId: ChatOperationIdSchema,
});
export type ChatSubmissionReceipt = z.infer<typeof ChatSubmissionReceiptSchema>;

const ChatSubmissionReceiptRowSchema = z.strictObject({
  session_id: z.string().min(1),
  submission_id: ChatSubmissionIdSchema,
  request_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  run_operation_id: ChatOperationIdSchema,
});
const RunOwnerRowSchema = z.object({ session_id: z.string().min(1) });

export class ChatSubmissionStore {
  constructor(private readonly database: RuntimeDatabase) {}

  read(sessionId: string, submissionId: string): ChatSubmissionReceipt | null {
    const row = this.database.prepare(`
      SELECT session_id, submission_id, request_digest, run_operation_id
      FROM chat_submissions WHERE session_id = ? AND submission_id = ?
    `).get(sessionId, submissionId);
    if (!row) return null;
    const parsed = ChatSubmissionReceiptRowSchema.parse(row);
    return ChatSubmissionReceiptSchema.parse({
      sessionId: parsed.session_id,
      submissionId: parsed.submission_id,
      requestDigest: parsed.request_digest,
      runOperationId: parsed.run_operation_id,
    });
  }

  insert(receipt: ChatSubmissionReceipt): void {
    const parsed = ChatSubmissionReceiptSchema.parse(receipt);
    const owner = RunOwnerRowSchema.parse(this.database.prepare(
      'SELECT session_id FROM chat_runs WHERE operation_id = ?',
    ).get(parsed.runOperationId));
    if (owner.session_id !== parsed.sessionId) {
      throw new Error('Chat submission run does not belong to its session.');
    }
    this.database.prepare(`
      INSERT INTO chat_submissions (session_id, submission_id, request_digest, run_operation_id)
      VALUES (?, ?, ?, ?)
    `).run(parsed.sessionId, parsed.submissionId, parsed.requestDigest, parsed.runOperationId);
  }
}

export function digestChatSubmission(operationKind: string, body: JsonObject): string {
  const kind = ChatSessionOperationKindSchema.parse(operationKind);
  return digestStableJson({ operationKind: kind, body });
}
