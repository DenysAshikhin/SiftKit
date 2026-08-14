import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import type { JsonValue } from '../../lib/json-types.js';
import type { Clock } from '../clock.js';
import type { ActorType, MutationOperation } from '../domain/enums.js';
import type { IdGenerator } from '../ids.js';
import {
  AuditEventRowSchema, MetadataValueRowSchema, MutationLogRowSchema,
  type AuditEventRow, type MutationLogRow,
} from './rows.js';
import { GRAPH_VERSION_METADATA_KEY } from './schema.js';

export interface MutationLogEntry {
  readonly ownerId: string;
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly operation: MutationOperation;
  readonly targetType: string;
  readonly targetId: string;
  /** Row state before the mutation, or `null` when the row did not exist. */
  readonly before: JsonValue;
  /** Row state after the mutation, or `null` when the row no longer exists. */
  readonly after: JsonValue;
  readonly reason: string;
}

export interface AuditEventEntry {
  readonly ownerId: string;
  readonly eventType: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: string;
  readonly details: JsonValue;
}

/**
 * Owns the mutation log, non-content audit events, and the monotonic graph version.
 * Callers run these inside their own transaction; this store never opens one.
 */
export class AuditStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  recordMutation(entry: MutationLogEntry): string {
    const id = this.ids.next('mut');
    this.database.prepare(`
      INSERT INTO graph_mutation_log (
        id, owner_id, actor_type, actor_ref, operation, target_type, target_id,
        before_json, after_json, reason, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entry.ownerId, entry.actorType, entry.actorRef, entry.operation,
      entry.targetType, entry.targetId,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
      entry.reason, this.clock.nowUtc(),
    );
    return id;
  }

  recordAuditEvent(entry: AuditEventEntry): string {
    const id = this.ids.next('audit');
    this.database.prepare(`
      INSERT INTO assistant_audit_events (
        id, owner_id, event_type, target_type, target_id, summary, details_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entry.ownerId, entry.eventType, entry.targetType, entry.targetId,
      entry.summary, JSON.stringify(entry.details), this.clock.nowUtc(),
    );
    return id;
  }

  listMutations(ownerId: string, targetType: string, targetId: string): MutationLogRow[] {
    return z.array(MutationLogRowSchema).parse(
      this.database.prepare(`
        SELECT * FROM graph_mutation_log
        WHERE owner_id = ? AND target_type = ? AND target_id = ?
        ORDER BY created_at_utc ASC, id ASC
      `).all(ownerId, targetType, targetId),
    );
  }

  /** Newest-first page of the mutation log; served by `graph_mutation_owner_time_idx`. */
  listMutationsRecent(ownerId: string, limit: number, offset: number): MutationLogRow[] {
    return z.array(MutationLogRowSchema).parse(this.database.prepare(`
        SELECT * FROM graph_mutation_log
        WHERE owner_id = ? ORDER BY created_at_utc DESC, id DESC LIMIT ? OFFSET ?
      `).all(ownerId, limit, offset));
  }

  listAuditEvents(ownerId: string, limit: number): AuditEventRow[] {
    return z.array(AuditEventRowSchema).parse(
      this.database.prepare(`
        SELECT * FROM assistant_audit_events
        WHERE owner_id = ? ORDER BY created_at_utc DESC, id DESC LIMIT ?
      `).all(ownerId, limit),
    );
  }

  getGraphVersion(): number {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(GRAPH_VERSION_METADATA_KEY);
    if (row === undefined || row === null) {
      throw new Error('Graph version metadata is missing; the v39 migration did not run.');
    }
    return Number.parseInt(MetadataValueRowSchema.parse(row).value, 10);
  }

  /** Called exactly once per committed graph-mutation transaction. */
  incrementGraphVersion(): number {
    const next = this.getGraphVersion() + 1;
    this.database.prepare(`
      UPDATE runtime_metadata SET value = ?, updated_at_utc = ? WHERE key = ?
    `).run(String(next), this.clock.nowUtc(), GRAPH_VERSION_METADATA_KEY);
    return next;
  }
}
