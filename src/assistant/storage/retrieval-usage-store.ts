import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { IdGenerator } from '../ids.js';
import { RetrievalUsageRowSchema, type RetrievalUsageRow } from './rows.js';

const IdListSchema = z.array(z.string());

export interface RecordRetrievalUsageInput {
  readonly ownerId: string;
  readonly conversationId: string | null;
  readonly queryHash: string;
  readonly assertionIds: readonly string[];
  readonly projectionIds: readonly string[];
  readonly renderedTokenCount: number;
}

export class RetrievalUsageStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  record(input: RecordRetrievalUsageInput): RetrievalUsageRow {
    if (!Number.isInteger(input.renderedTokenCount) || input.renderedTokenCount < 0) {
      throw new Error('Rendered token count must be a non-negative integer.');
    }
    const id = this.ids.next('retrieval_usage');
    this.database.prepare(`
      INSERT INTO retrieval_usage (
        id, owner_id, conversation_id, query_hash, assertion_ids_json,
        projection_ids_json, rendered_token_count, usefulness_feedback, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      id, input.ownerId, input.conversationId, input.queryHash,
      JSON.stringify([...input.assertionIds]), JSON.stringify([...input.projectionIds]),
      input.renderedTokenCount, this.clock.nowUtc(),
    );
    return this.requireUsage(id);
  }

  getUsage(usageId: string): RetrievalUsageRow | null {
    const row = this.database.prepare('SELECT * FROM retrieval_usage WHERE id = ?').get(usageId);
    return row === undefined || row === null ? null : RetrievalUsageRowSchema.parse(row);
  }

  requireUsage(usageId: string): RetrievalUsageRow {
    const row = this.getUsage(usageId);
    if (row === null) throw new Error(`Unknown retrieval usage: ${usageId}`);
    return row;
  }

  listRecent(ownerId: string, limit: number): RetrievalUsageRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Retrieval usage limit must be an integer between 1 and 1000.');
    }
    return z.array(RetrievalUsageRowSchema).parse(this.database.prepare(`
      SELECT * FROM retrieval_usage WHERE owner_id = ?
      ORDER BY created_at_utc DESC, id DESC LIMIT ?
    `).all(ownerId, limit));
  }

  readAssertionIds(row: RetrievalUsageRow): string[] {
    return parseJsonText(row.assertion_ids_json, IdListSchema);
  }

  readProjectionIds(row: RetrievalUsageRow): string[] {
    return parseJsonText(row.projection_ids_json, IdListSchema);
  }

  setUsefulness(usageId: string, usefulness: number): RetrievalUsageRow {
    if (!Number.isFinite(usefulness) || usefulness < -1 || usefulness > 1) {
      throw new Error('Retrieval usefulness must be between -1 and 1.');
    }
    this.requireUsage(usageId);
    this.database.prepare('UPDATE retrieval_usage SET usefulness_feedback = ? WHERE id = ?')
      .run(usefulness, usageId);
    return this.requireUsage(usageId);
  }
}
