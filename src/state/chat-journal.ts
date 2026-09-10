import { createHash } from 'node:crypto';

import { stableStringify } from '../lib/json.js';
import { JsonValueSchema } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import {
  ChatEngineBindingSchema,
  ChatJournalAppendSchema,
  ChatJournalEnvelopeSchema,
  ChatJournalEventSchema,
  ChatRunSchema,
  ChatRunStartSchema,
  CHAT_JOURNAL_EVENT_VERSION,
  type ChatEngineBinding,
  type ChatJournalAppend,
  type ChatJournalEnvelope,
  type ChatJournalEvent,
  type ChatRun,
  type ChatRunStart,
} from './chat-journal-schema.js';
import { ChatRunTerminalCauseSchema } from '@siftkit/contracts';
import type { RuntimeDatabase } from './database-handle.js';

const RunRowSchema = z.object({
  operation_id: z.string(),
  session_id: z.string(),
  record_kind: z.string(),
  operation_kind: z.string().nullable(),
  request_id: z.string().nullable(),
  repo_agent_session_id: z.string().nullable(),
  run_order: z.number().int(),
  owner_epoch: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
  terminal_cause: z.string().nullable(),
  latest_sequence: z.number().int(),
  projected_sequence: z.number().int(),
  context_revision: z.number().int(),
  effective_settings_json: z.string().nullable(),
  provenance_json: z.string().nullable(),
});

const EventRowSchema = z.object({
  operation_id: z.string(),
  sequence: z.number().int(),
  event_id: z.string(),
  version: z.number().int(),
  recorded_at_utc: z.string(),
  body_json: z.string(),
  payload_digest: z.string(),
});
const EventRowsSchema = z.array(EventRowSchema);

const MaxRunOrderRowSchema = z.object({ next_order: z.number().int() });

export const ChatRunFinishSchema = z.strictObject({
  operationId: z.string().uuid(),
  ownerEpoch: z.string().min(1),
  terminalCause: ChatRunTerminalCauseSchema,
  updatedAtUtc: z.string().datetime(),
});
export type ChatRunFinish = z.infer<typeof ChatRunFinishSchema>;

export const ChatProjectionCheckpointSchema = z.strictObject({
  operationId: z.string().uuid(),
  projectedSequence: z.number().int().nonnegative(),
});
export type ChatProjectionCheckpoint = z.infer<typeof ChatProjectionCheckpointSchema>;

export const ChatContextCheckpointSchema = z.strictObject({
  operationId: z.string().uuid(),
  contextRevision: z.number().int().nonnegative(),
});
export type ChatContextCheckpoint = z.infer<typeof ChatContextCheckpointSchema>;

/**
 * The digest is over the event body alone, so an identical retry of the same evidence is recognised
 * as the same write regardless of when it was attempted, and a different body under the same event
 * id can be reported as corruption instead of silently replacing what is already committed.
 */
function digestEvent(event: ChatJournalEvent): string {
  const canonical = JsonValueSchema.parse(JSON.parse(JSON.stringify(event)));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function parseJsonColumn<Schema extends z.ZodType>(schema: Schema, raw: string | null): z.infer<Schema> | null {
  if (raw === null) return null;
  return schema.parse(JSON.parse(raw));
}

function toChatRun(row: z.infer<typeof RunRowSchema>): ChatRun {
  return ChatRunSchema.parse({
    operationId: row.operation_id,
    sessionId: row.session_id,
    recordKind: row.record_kind,
    operationKind: row.operation_kind,
    requestId: row.request_id,
    repoAgentSessionId: row.repo_agent_session_id,
    runOrder: row.run_order,
    ownerEpoch: row.owner_epoch,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    terminalCause: row.terminal_cause,
    latestSequence: row.latest_sequence,
    projectedSequence: row.projected_sequence,
    contextRevision: row.context_revision,
    settings: parseJsonColumn(ChatRunSchema.shape.settings, row.effective_settings_json),
    provenance: parseJsonColumn(ChatRunSchema.shape.provenance, row.provenance_json),
  });
}

function toEnvelope(row: z.infer<typeof EventRowSchema>): ChatJournalEnvelope {
  if (row.version !== CHAT_JOURNAL_EVENT_VERSION) {
    throw new Error(
      `Chat journal event ${row.event_id} in run ${row.operation_id} has unsupported version `
      + `${String(row.version)}; this build reads version ${String(CHAT_JOURNAL_EVENT_VERSION)}.`,
    );
  }
  return ChatJournalEnvelopeSchema.parse({
    operationId: row.operation_id,
    sequence: row.sequence,
    eventId: row.event_id,
    version: row.version,
    recordedAtUtc: row.recorded_at_utc,
    event: ChatJournalEventSchema.parse(JSON.parse(row.body_json)),
    payloadDigest: row.payload_digest,
  });
}

/**
 * Durable storage for one chat's conversation and execution evidence. It commits source events and
 * nothing else: projections are applied by their own writers afterwards, so a projection that throws
 * cannot take the evidence down with it, and the store never takes a callback to invoke.
 */
export class ChatJournalStore {
  constructor(private readonly database: RuntimeDatabase) {}

  begin(input: ChatRunStart): ChatRun {
    const start = ChatRunStartSchema.parse(input);
    return this.database.transaction(() => {
      const { next_order: runOrder } = MaxRunOrderRowSchema.parse(this.database.prepare(`
        SELECT COALESCE(MAX(run_order), 0) + 1 AS next_order FROM chat_runs WHERE session_id = ?
      `).get(start.sessionId));
      this.database.prepare(`
        INSERT INTO chat_runs (
          operation_id, session_id, record_kind, operation_kind, run_order, owner_epoch,
          created_at_utc, updated_at_utc, effective_settings_json, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        start.operationId,
        start.sessionId,
        start.recordKind,
        start.operationKind,
        runOrder,
        start.ownerEpoch,
        start.createdAtUtc,
        start.createdAtUtc,
        start.settings === null ? null : JSON.stringify(start.settings),
        start.provenance === null ? null : JSON.stringify(start.provenance),
      );
      return this.requireRun(start.operationId);
    })();
  }

  /**
   * Binds the engine identities this run will be found by. A binding is written once: a run that
   * already names a request cannot be repointed at another, which is what stops recovery from
   * attaching a chat to evidence that belongs to a different execution.
   */
  bindEngine(input: ChatEngineBinding): ChatRun {
    const binding = ChatEngineBindingSchema.parse(input);
    return this.database.transaction(() => {
      const run = this.requireRun(binding.operationId);
      this.requireOwner(run, binding.ownerEpoch);
      if (run.requestId !== null || run.repoAgentSessionId !== null) {
        if (run.requestId === binding.requestId && run.repoAgentSessionId === binding.repoAgentSessionId) {
          return run;
        }
        throw new Error(
          `Chat run ${binding.operationId} is already bound to request ${String(run.requestId)};`
          + ` it cannot be rebound to ${binding.requestId}.`,
        );
      }
      this.database.prepare(`
        UPDATE chat_runs SET request_id = ?, repo_agent_session_id = ?, updated_at_utc = ?
        WHERE operation_id = ?
      `).run(binding.requestId, binding.repoAgentSessionId, run.updatedAtUtc, binding.operationId);
      return this.requireRun(binding.operationId);
    })();
  }

  append(input: ChatJournalAppend): ChatJournalEnvelope {
    const write = ChatJournalAppendSchema.parse(input);
    const payloadDigest = digestEvent(write.event);
    return this.database.transaction(() => {
      const run = this.requireRun(write.operationId);

      const existing = this.readEventById(write.operationId, write.eventId);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) {
          throw new Error(
            `Chat journal event ${write.eventId} in run ${write.operationId} was already committed with`
            + ' different content; refusing this conflicting event.',
          );
        }
        return existing;
      }

      this.requireOwner(run, write.ownerEpoch);
      if (write.expectedSequence !== run.latestSequence) {
        throw new Error(
          `Chat journal write to run ${write.operationId} expected sequence ${String(write.expectedSequence)}`
          + ` but the run is at ${String(run.latestSequence)}.`,
        );
      }

      const sequence = run.latestSequence + 1;
      this.database.prepare(`
        INSERT INTO chat_run_events (
          operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        write.operationId,
        sequence,
        write.eventId,
        CHAT_JOURNAL_EVENT_VERSION,
        write.occurredAtUtc,
        write.event.kind,
        JSON.stringify(write.event),
        payloadDigest,
      );
      this.database.prepare(`
        UPDATE chat_runs SET latest_sequence = ?, updated_at_utc = ? WHERE operation_id = ?
      `).run(sequence, write.occurredAtUtc, write.operationId);

      return ChatJournalEnvelopeSchema.parse({
        operationId: write.operationId,
        sequence,
        eventId: write.eventId,
        version: CHAT_JOURNAL_EVENT_VERSION,
        recordedAtUtc: write.occurredAtUtc,
        event: write.event,
        payloadDigest,
      });
    })();
  }

  finish(input: ChatRunFinish): ChatRun {
    const finish = ChatRunFinishSchema.parse(input);
    return this.database.transaction(() => {
      const run = this.requireRun(finish.operationId);
      this.requireOwner(run, finish.ownerEpoch);
      if (run.terminalCause !== null) {
        if (run.terminalCause === finish.terminalCause) return run;
        throw new Error(
          `Chat run ${finish.operationId} already ended as ${run.terminalCause};`
          + ` it cannot also end as ${finish.terminalCause}.`,
        );
      }
      this.database.prepare(`
        UPDATE chat_runs SET terminal_cause = ?, updated_at_utc = ? WHERE operation_id = ?
      `).run(finish.terminalCause, finish.updatedAtUtc, finish.operationId);
      return this.requireRun(finish.operationId);
    })();
  }

  /** Moves the projection checkpoint. Callers advance it in the same transaction as their own writes. */
  advanceProjection(input: ChatProjectionCheckpoint): void {
    const checkpoint = ChatProjectionCheckpointSchema.parse(input);
    const run = this.requireRun(checkpoint.operationId);
    if (checkpoint.projectedSequence > run.latestSequence) {
      throw new Error(
        `Chat run ${checkpoint.operationId} cannot project sequence ${String(checkpoint.projectedSequence)}`
        + ` beyond its committed ${String(run.latestSequence)}.`,
      );
    }
    this.database.prepare('UPDATE chat_runs SET projected_sequence = ? WHERE operation_id = ?')
      .run(checkpoint.projectedSequence, checkpoint.operationId);
  }

  advanceContextRevision(input: ChatContextCheckpoint): void {
    const checkpoint = ChatContextCheckpointSchema.parse(input);
    this.requireRun(checkpoint.operationId);
    this.database.prepare('UPDATE chat_runs SET context_revision = ? WHERE operation_id = ?')
      .run(checkpoint.contextRevision, checkpoint.operationId);
  }

  readAfter(operationId: string, afterSequence: number, limit: number): ChatJournalEnvelope[] {
    const cursor = z.number().int().nonnegative().parse(afterSequence);
    const pageSize = z.number().int().positive().parse(limit);
    const rows = EventRowsSchema.parse(this.database.prepare(`
      SELECT operation_id, sequence, event_id, version, recorded_at_utc, body_json, payload_digest
      FROM chat_run_events
      WHERE operation_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(z.string().uuid().parse(operationId), cursor, pageSize));
    return rows.map((row) => toEnvelope(row));
  }

  readRun(operationId: string): ChatRun | null {
    const raw = this.database.prepare('SELECT * FROM chat_runs WHERE operation_id = ?')
      .get(z.string().uuid().parse(operationId));
    return raw == null ? null : toChatRun(RunRowSchema.parse(raw));
  }

  listSessionRuns(sessionId: string): ChatRun[] {
    const rows = z.array(RunRowSchema).parse(this.database.prepare(
      'SELECT * FROM chat_runs WHERE session_id = ? ORDER BY run_order',
    ).all(z.string().min(1).parse(sessionId)));
    return rows.map((row) => toChatRun(row));
  }

  private readEventById(operationId: string, eventId: string): ChatJournalEnvelope | null {
    const raw = this.database.prepare(`
      SELECT operation_id, sequence, event_id, version, recorded_at_utc, body_json, payload_digest
      FROM chat_run_events WHERE operation_id = ? AND event_id = ?
    `).get(operationId, eventId);
    return raw == null ? null : toEnvelope(EventRowSchema.parse(raw));
  }

  private requireRun(operationId: string): ChatRun {
    const run = this.readRun(operationId);
    if (!run) throw new Error(`Chat run ${operationId} is unknown to the chat journal.`);
    return run;
  }

  private requireOwner(run: ChatRun, ownerEpoch: string): void {
    if (run.ownerEpoch !== ownerEpoch) {
      throw new Error(
        `Chat run ${run.operationId} is owned by epoch ${run.ownerEpoch};`
        + ` a write from ${ownerEpoch} is fenced out.`,
      );
    }
  }
}
