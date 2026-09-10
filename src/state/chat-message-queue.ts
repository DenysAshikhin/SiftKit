import {
  CHAT_QUEUE_MAX_PENDING,
  CHAT_QUEUE_MAX_DELIVERED_PREVIEWS,
  CHAT_QUEUE_PREVIEW_CHARS,
  ChatQueueEnqueueRequestSchema,
  ChatQueueEditRequestSchema,
  ChatMessageQueueStateSchema,
  ChatQueuedMessageIdSchema,
  ChatQueuedMessageStateSchema,
  ChatQueueSendOptionsSchema,
  ChatQueueForceRequestSchema,
  ChatMessageQueueForceStateSchema,
  type ChatMessageQueueForceState,
  ImageDataUrlSchema,
} from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

const QueueRowSchema = z.object({
  sequence: z.number().int().positive(),
  session_id: z.string().min(1),
  id: ChatQueuedMessageIdSchema,
  content: z.string(),
  images_json: z.string(),
  options_json: z.string(),
  revision: z.number().int().positive(),
  state: ChatQueuedMessageStateSchema,
  delivered_request_id: z.string().nullable(),
  delivered_turn: z.number().int().nonnegative().nullable(),
  delivered_at_utc: z.string().nullable(),
  created_at_utc: z.string(),
});
const QueueRowsSchema = z.array(QueueRowSchema);
const CountRowSchema = z.object({ count: z.number().int().nonnegative() });
const ImagesJsonSchema = z.array(ImageDataUrlSchema);
const QueueMetadataSchema = ChatMessageQueueStateSchema.pick({ revision: true, paused: true, force: true });
type QueueMetadata = z.infer<typeof QueueMetadataSchema>;

export type ChatQueuedMessage = ReturnType<typeof toMessage>;
export type ChatQueueEnqueueInput = z.infer<typeof ChatQueueEnqueueRequestSchema>;

export type ChatQueueEnqueueResult =
  | { kind: 'already_persisted' }
  | { kind: 'persisted_conflict' }
  | { kind: 'enqueued'; message: ChatQueuedMessage }
  /** The same id with the same body: a network retry, answered with the existing entry. */
  | { kind: 'duplicate'; message: ChatQueuedMessage }
  /** The same id with a different body; an id never silently changes meaning. */
  | { kind: 'conflict'; message: ChatQueuedMessage }
  | { kind: 'overflow'; pendingCount: number }
  | { kind: 'missing_session' };

export type ChatQueueMutationResult =
  | { kind: 'applied'; message: ChatQueuedMessage }
  /** The engine already claimed the row; the caller gets its current state instead of a change. */
  | { kind: 'not_pending'; message: ChatQueuedMessage }
  /** The editor's revision is behind the row's; the current row is returned unchanged. */
  | { kind: 'stale'; message: ChatQueuedMessage }
  | { kind: 'not_found' };

const ChatQueueClaimInputSchema = z.strictObject({
  requestId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  ids: z.array(ChatQueuedMessageIdSchema).nullable(),
});
export type ChatQueueClaimInput = z.infer<typeof ChatQueueClaimInputSchema>;

export type ChatQueueForceResult =
  | { kind: 'empty' }
  | { kind: 'started'; force: NonNullable<QueueMetadata['force']> }
  | { kind: 'duplicate'; force: NonNullable<QueueMetadata['force']> }
  | { kind: 'conflict'; force: NonNullable<QueueMetadata['force']> }
  | { kind: 'missing_session' };
function toMessage(row: z.infer<typeof QueueRowSchema>) {
  return {
    sequence: row.sequence,
    sessionId: row.session_id,
    id: row.id,
    content: row.content,
    images: ImagesJsonSchema.parse(JSON.parse(row.images_json)),
    options: ChatQueueSendOptionsSchema.parse(JSON.parse(row.options_json)),
    revision: row.revision,
    state: row.state,
    deliveredRequestId: row.delivered_request_id,
    deliveredTurn: row.delivered_turn,
    createdAtUtc: row.created_at_utc,
  };
}

function sameBody(message: ChatQueuedMessage, input: ChatQueueEnqueueInput): boolean {
  return message.content === input.content
    && JSON.stringify(message.images) === JSON.stringify(input.images)
    && JSON.stringify(message.options) === JSON.stringify(ChatQueueSendOptionsSchema.parse(input.options));
}

/**
 * The durable, session-scoped FIFO of user messages that arrived while a run was busy. Rows are
 * `pending` until an engine request claims them at one turn boundary, then `delivered` until the
 * turn that consumed them is written into chat history and the row is deleted. Every transition
 * is one SQLite transaction, so a claim and its bookkeeping cannot be observed half-done.
 */
export class ChatMessageQueueStore {
  private readonly databasePath: string;
  constructor(database: RuntimeDatabase) { this.databasePath = database.name; }
  private get database(): RuntimeDatabase { return getRuntimeDatabase(this.databasePath); }

  private metadata(sessionId: string) {
    const raw = this.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get(`chat_queue:${sessionId}`);
    return raw === undefined ? { revision: 0, paused: false, force: null } : QueueMetadataSchema.parse(JSON.parse(z.object({ value: z.string() }).parse(raw).value));
  }

  state(sessionId: string) {
    const rows = z.array(ChatMessageQueueStateSchema.shape.messages.element.omit({ position: true }).extend({ preview: z.string() })).parse(this.database.prepare(`
      SELECT id, substr(content, 1, ?) AS preview, length(content) AS contentChars,
        json_array_length(images_json) AS imageCount, revision, state, created_at_utc AS createdAtUtc
      FROM chat_pending_messages WHERE session_id = ? AND (
        state = 'pending' OR sequence IN (
          SELECT sequence FROM chat_pending_messages
          WHERE session_id = ? AND state = 'delivered' ORDER BY sequence DESC LIMIT ?
        )
      ) ORDER BY sequence
    `).all(CHAT_QUEUE_PREVIEW_CHARS, sessionId, sessionId, CHAT_QUEUE_MAX_DELIVERED_PREVIEWS));
    return ChatMessageQueueStateSchema.parse({
      sessionId, ...this.metadata(sessionId),
      messages: rows.map((message, position) => ({ ...message, position, preview: message.preview.slice(0, CHAT_QUEUE_PREVIEW_CHARS) })),
    });
  }

  private bump(sessionId: string, paused?: boolean): void {
    const state = this.metadata(sessionId);
    this.writeMetadata(sessionId, {
      revision: state.revision + 1,
      paused: paused ?? state.paused,
      force: state.force,
    });
  }

  private writeMetadata(sessionId: string, state: QueueMetadata): void {
    this.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc')
      .run(`chat_queue:${sessionId}`, JSON.stringify(state), new Date().toISOString());
  }
  setPaused(sessionId: string, paused: boolean): void {
    this.database.transaction(() => this.bump(sessionId, paused))();
  }

  readForceReceipt(sessionId: string, id: string): ChatMessageQueueForceState | null {
    const row = this.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get(`chat_queue_receipt:${sessionId}:${id}`);
    return row === undefined ? null : ChatMessageQueueForceStateSchema.parse(JSON.parse(z.object({ value: z.string() }).parse(row).value));
  }

  private saveReceipt(sessionId: string, force: ChatMessageQueueForceState): void {
    this.database.prepare('INSERT INTO runtime_metadata(key, value, updated_at_utc) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_utc=excluded.updated_at_utc')
      .run(`chat_queue_receipt:${sessionId}:${force.id}`, JSON.stringify(force), new Date().toISOString());
  }

  failForce(sessionId: string, force: ChatMessageQueueForceState, error: string): void {
    this.database.transaction(() => {
      const failed = ChatMessageQueueForceStateSchema.parse({ ...force, phase: 'failed', failureDetail: error });
      this.saveReceipt(sessionId, failed);
      const state = this.metadata(sessionId);
      if (!state.force || state.force.id === force.id) this.writeMetadata(sessionId, { revision: state.revision + 1, paused: true, force: failed });
    })();
  }

  beginForce(
    sessionId: string,
    input: z.input<typeof ChatQueueForceRequestSchema>,
    successorOperationId: string,
  ): ChatQueueForceResult {
    const request = ChatQueueForceRequestSchema.parse(input);
    const successorId = z.string().uuid().parse(successorOperationId);
    return this.database.transaction((): ChatQueueForceResult => {
      if (!this.sessionExists(sessionId)) return { kind: 'missing_session' };
      const receipt = this.readForceReceipt(sessionId, request.id);
      if (receipt) return { kind: receipt.operationId === request.operationId ? 'duplicate' : 'conflict', force: receipt };
      const state = this.metadata(sessionId);
      if (state.force !== null && state.force.phase !== 'failed') {
        return {
          kind: state.force.id === request.id && state.force.operationId === request.operationId ? 'duplicate' : 'conflict',
          force: state.force,
        };
      }
      const pending = this.listPending(sessionId);
      if (pending.length === 0) return { kind: 'empty' };
      const force = {
        id: request.id,
        operationId: request.operationId,
        phase: request.operationId === null ? 'sending' as const : 'stopping' as const,
        messageIds: pending.map((message) => message.id),
        successorOperationId: successorId,
        failureDetail: null,
      };
      this.writeMetadata(sessionId, { revision: state.revision + 1, paused: state.paused, force });
      return { kind: 'started', force };
    })();
  }

  updateForce(
    sessionId: string,
    forceId: string,
    patch: { phase: 'stopping' | 'sending' | 'failed'; failureDetail: string | null },
  ): boolean {
    const parsedForceId = z.string().uuid().parse(forceId);
    return this.database.transaction(() => {
      const state = this.metadata(sessionId);
      if (state.force === null || state.force.id !== parsedForceId) return false;
      this.writeMetadata(sessionId, {
        revision: state.revision + 1,
        paused: state.paused,
        force: { ...state.force, phase: patch.phase, failureDetail: patch.failureDetail },
      });
      return true;
    })();
  }

  clearForce(sessionId: string, forceId: string): boolean {
    const parsedForceId = z.string().uuid().parse(forceId);
    return this.database.transaction(() => {
      const state = this.metadata(sessionId);
      if (state.force === null || state.force.id !== parsedForceId) return false;
      this.saveReceipt(sessionId, state.force);
      this.writeMetadata(sessionId, { revision: state.revision + 1, paused: state.paused, force: null });
      return true;
    })();
  }

  private sessionExists(sessionId: string): boolean {
    return this.database.prepare('SELECT 1 AS present FROM chat_sessions WHERE id = ?').get(sessionId) !== undefined;
  }

  private readRow(sessionId: string, id: string): ChatQueuedMessage | null {
    const raw = this.database.prepare(
      'SELECT * FROM chat_pending_messages WHERE session_id = ? AND id = ?',
    ).get(sessionId, id);
    return raw === undefined ? null : toMessage(QueueRowSchema.parse(raw));
  }

  private requireRow(sessionId: string, id: string): ChatQueuedMessage {
    const row = this.readRow(sessionId, id);
    if (row === null) {
      throw new Error(`Queued chat message ${id} disappeared from session ${sessionId}.`);
    }
    return row;
  }

  get(sessionId: string, id: string): ChatQueuedMessage | null {
    return this.readRow(sessionId, ChatQueuedMessageIdSchema.parse(id));
  }

  private countPending(sessionId: string): number {
    return CountRowSchema.parse(this.database.prepare(
      "SELECT count(*) AS count FROM chat_pending_messages WHERE session_id = ? AND state = 'pending'",
    ).get(sessionId)).count;
  }

  enqueue(sessionId: string, input: ChatQueueEnqueueInput, nowUtc = new Date().toISOString()): ChatQueueEnqueueResult {
    input = ChatQueueEnqueueRequestSchema.parse(input);
    return this.database.transaction((): ChatQueueEnqueueResult => {
      if (!this.sessionExists(sessionId)) {
        return { kind: 'missing_session' };
      }
      const canonicalRaw = this.database.prepare('SELECT role, content, images FROM chat_messages WHERE session_id = ? AND id = ?').get(sessionId, input.id);
      if (canonicalRaw !== undefined) {
        const canonical = z.object({ role: z.string(), content: z.string(), images: z.string().nullable() }).parse(canonicalRaw);
        const images = canonical.images === null ? [] : ImagesJsonSchema.parse(JSON.parse(canonical.images));
        return { kind: canonical.role === 'user' && canonical.content === input.content && JSON.stringify(images) === JSON.stringify(input.images) ? 'already_persisted' : 'persisted_conflict' };
      }
      const existing = this.readRow(sessionId, input.id);
      if (existing !== null) {
        return sameBody(existing, input)
          ? { kind: 'duplicate', message: existing }
          : { kind: 'conflict', message: existing };
      }
      const pendingCount = this.countPending(sessionId);
      if (pendingCount >= CHAT_QUEUE_MAX_PENDING) {
        return { kind: 'overflow', pendingCount };
      }
      this.database.prepare(`
        INSERT INTO chat_pending_messages (
          session_id, id, content, images_json, options_json, revision, state, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)
      `).run(
        sessionId,
        input.id,
        input.content,
        JSON.stringify(ImagesJsonSchema.parse(input.images)),
        JSON.stringify(ChatQueueSendOptionsSchema.parse(input.options)),
        nowUtc,
      );
      this.bump(sessionId);
      return { kind: 'enqueued', message: this.requireRow(sessionId, input.id) };
    })();
  }

  /** Every row of the session, pending and delivered, in submission order. */
  list(sessionId: string): ChatQueuedMessage[] {
    return QueueRowsSchema.parse(this.database.prepare(
      'SELECT * FROM chat_pending_messages WHERE session_id = ? ORDER BY sequence',
    ).all(sessionId)).map(toMessage);
  }

  listPending(sessionId: string): ChatQueuedMessage[] {
    return QueueRowsSchema.parse(this.database.prepare(
      "SELECT * FROM chat_pending_messages WHERE session_id = ? AND state = 'pending' ORDER BY sequence",
    ).all(sessionId)).map(toMessage);
  }

  interruptedSessionIds(): string[] {
    return z.array(z.object({ session_id: z.string() })).parse(this.database.prepare(`
      SELECT DISTINCT session_id FROM chat_pending_messages
      UNION SELECT substr(key, 12) AS session_id FROM runtime_metadata
        WHERE key LIKE 'chat_queue:%' AND json_extract(value, '$.force') IS NOT NULL
    `).all()).map((row) => row.session_id);
  }

  private isForceSnapshot(sessionId: string, id: string): boolean {
    const force = this.metadata(sessionId).force;
    return force !== null && force.phase !== 'failed' && force.messageIds.includes(id);
  }

  edit(sessionId: string, id: string, content: string, revision: number): ChatQueueMutationResult {
    ({ content, revision } = ChatQueueEditRequestSchema.parse({ content, revision }));
    return this.database.transaction((): ChatQueueMutationResult => {
      const existing = this.readRow(sessionId, id);
      if (existing === null) return { kind: 'not_found' };
      if (existing.state !== 'pending' || this.isForceSnapshot(sessionId, id)) return { kind: 'not_pending', message: existing };
      if (existing.revision !== revision) return { kind: 'stale', message: existing };
      this.database.prepare(
        'UPDATE chat_pending_messages SET content = ?, revision = revision + 1 WHERE session_id = ? AND id = ?',
      ).run(content, sessionId, id);
      this.bump(sessionId);
      return { kind: 'applied', message: this.requireRow(sessionId, id) };
    })();
  }

  remove(sessionId: string, id: string): ChatQueueMutationResult {
    return this.database.transaction((): ChatQueueMutationResult => {
      const existing = this.readRow(sessionId, id);
      if (existing === null) return { kind: 'not_found' };
      if (existing.state !== 'pending' || this.isForceSnapshot(sessionId, id)) return { kind: 'not_pending', message: existing };
      this.database.prepare('DELETE FROM chat_pending_messages WHERE session_id = ? AND id = ?').run(sessionId, id);
      this.bump(sessionId);
      return { kind: 'applied', message: existing };
    })();
  }

  /**
   * Marks the FIFO snapshot of pending rows as delivered to one engine request at one boundary and
   * returns exactly those rows, in order. Rows that arrive after the claim stay pending.
   */
  claim(sessionId: string, input: ChatQueueClaimInput, nowUtc = new Date().toISOString()): ChatQueuedMessage[] {
    input = ChatQueueClaimInputSchema.parse(input);
    return this.database.transaction((): ChatQueuedMessage[] => {
      const limit = input.ids === null ? null : new Set(input.ids);
      if (limit && limit.size !== input.ids?.length) throw new Error('Duplicate queued snapshot IDs.');
      const claimed = this.listPending(sessionId).filter((message) => limit === null || limit.has(message.id));
      if (limit && claimed.length !== limit.size) throw new Error('Queued snapshot is no longer pending in full.');
      const update = this.database.prepare(`
        UPDATE chat_pending_messages
        SET state = 'delivered', delivered_request_id = ?, delivered_turn = ?, delivered_at_utc = ?
        WHERE session_id = ? AND id = ? AND state = 'pending'
      `);
      for (const message of claimed) {
        update.run(input.requestId, input.turn, nowUtc, sessionId, message.id);
      }
      if (claimed.length > 0) this.bump(sessionId);
      return claimed.map((message) => this.requireRow(sessionId, message.id));
    })();
  }

  listDelivered(sessionId: string, requestId: string): ChatQueuedMessage[] {
    return QueueRowsSchema.parse(this.database.prepare(
      "SELECT * FROM chat_pending_messages WHERE session_id = ? AND state = 'delivered' AND delivered_request_id = ? ORDER BY sequence",
    ).all(sessionId, requestId)).map(toMessage);
  }

  /** The turn that consumed these rows is now in chat history; the ledger entries are done. */
  deleteIncorporated(sessionId: string, requestId: string): number {
    return this.database.transaction(() => {
      const count = Number(this.database.prepare(`
        DELETE FROM chat_pending_messages
        WHERE session_id = ? AND state = 'delivered' AND delivered_request_id = ?
          AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_pending_messages.session_id
            AND m.id = chat_pending_messages.id AND m.role = 'user')
      `).run(sessionId, requestId).changes);
      if (count > 0) this.bump(sessionId);
      if (this.listDelivered(sessionId, requestId).length > 0) throw new Error(`Unincorporated queued delivery for request ${requestId}.`);
      return count;
    })();
  }

}
