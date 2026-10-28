import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/database-handle.ts';
import { FactPointRowSchema, type FactPointRow } from './fact-points.ts';

const BATCH_FRACTION = 0.1;
export const VALIDATION_BATCH_MIN = 1;
export const VALIDATION_BATCH_MAX = 25;
const REVALIDATE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;
const IdRowsSchema = z.array(z.object({ id: z.string() }));
const CountSchema = z.object({ count: z.number() });
// SQLite sorts NULL first ascending: never accessed, then never validated, lead the queue.
const NOTE_ORDER = 'ORDER BY last_accessed_at_utc, validated_at_utc, updated_at_utc, id';
const ELIGIBLE = "kind = 'entity' AND (validated_at_utc IS NULL OR validated_at_utc < ?)";

const revalidateCutoff = (nowUtc: string) => new Date(Date.parse(nowUtc) - REVALIDATE_AFTER_DAYS * DAY_MS).toISOString();

export interface VaultValidationDepth {
  readonly queueDepth: number;
  readonly oldestValidatedAtUtc: string | null;
}

/** The validation queue: an ordered query over indexed timestamps, never a separate table. */
export class VaultValidationQueue {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  /** Every queued entity note id, head first; notes validated in the last 30 days are not queued. */
  order(nowUtc: string): string[] {
    return IdRowsSchema.parse(this.database.prepare(`SELECT id FROM vault_notes WHERE ${ELIGIBLE} ${NOTE_ORDER}`).all(revalidateCutoff(nowUtc)))
      .map((row) => row.id);
  }

  /** The head of the queue: 10% of entity notes, at least 1 and at most 25. */
  nextBatch(nowUtc: string): string[] {
    const total = CountSchema.parse(this.database.prepare("SELECT COUNT(*) AS count FROM vault_notes WHERE kind = 'entity'").get()).count;
    const size = Math.min(VALIDATION_BATCH_MAX, Math.max(VALIDATION_BATCH_MIN, Math.floor(total * BATCH_FRACTION)));
    return this.order(nowUtc).slice(0, size);
  }

  /** A note's fact values in the same order, so review cards lead with the stalest. */
  staleFacts(noteId: string): FactPointRow[] {
    return z.array(FactPointRowSchema).parse(this.database.prepare(
      'SELECT * FROM vault_fact_points WHERE note_id = ? ORDER BY last_accessed_at_utc, validated_at_utc, edited_at_utc, label_key, value_key',
    ).all(noteId));
  }

  depth(nowUtc: string): VaultValidationDepth {
    const queueDepth = CountSchema.parse(this.database.prepare(`SELECT COUNT(*) AS count FROM vault_notes WHERE ${ELIGIBLE}`).get(revalidateCutoff(nowUtc))).count;
    const oldest = z.object({ oldest: z.string().nullable() }).parse(this.database.prepare(
      "SELECT MIN(validated_at_utc) AS oldest FROM vault_notes WHERE kind = 'entity'",
    ).get()).oldest;
    return { queueDepth, oldestValidatedAtUtc: oldest };
  }
}
