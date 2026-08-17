import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { isIndexableInPlaintext, type ProjectionStatus, type Sensitivity } from '../domain/enums.js';
import type { IdGenerator } from '../ids.js';
import { ProjectionRowSchema, type ProjectionRow } from './rows.js';
import { dropFtsRow, fetchRowsByIds, recordFtsRowid } from './sql-helpers.js';

export interface UpsertProjectionInput {
  readonly ownerId: string;
  readonly tier: 1 | 2 | 3;
  readonly topicKey: string;
  readonly title: string;
  readonly content: string;
  /**
   * Hash of the volatile-free part of `content` (the body, not the frontmatter), supplied by the
   * caller so an unchanged projection is detectable even though `generated_at` always moves.
   */
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly tokenizerId: string;
  readonly graphVersion: number;
  readonly includedAssertionIds: readonly string[];
  readonly sensitivity: Sensitivity;
}

const AssertionIdListSchema = z.array(z.string());

/** Owns `memory_projections` and its FTS index. Callers supply their own transaction. */
export class ProjectionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  upsert(input: UpsertProjectionInput): ProjectionRow {
    const existing = this.findByTopic(input.ownerId, input.tier, input.topicKey);
    const id = existing === null ? this.ids.next('memproj') : existing.id;
    const nowUtc = this.clock.nowUtc();
    const includedJson = JSON.stringify([...input.includedAssertionIds]);
    const relativePath = `tier${input.tier}/${input.topicKey}.md`;

    if (existing === null) {
      this.database.prepare(`
        INSERT INTO memory_projections (
          id, owner_id, tier, topic_key, relative_path, title, content, content_hash,
          token_count, tokenizer_id, graph_version, included_assertion_ids_json, sensitivity,
          generated_at_utc, last_retrieved_at_utc, retrieval_count, utility_score, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0.0, 'active')
      `).run(
        id, input.ownerId, input.tier, input.topicKey, relativePath, input.title,
        input.content, input.contentHash, input.tokenCount, input.tokenizerId,
        input.graphVersion, includedJson, input.sensitivity, nowUtc,
      );
    } else {
      this.database.prepare(`
        UPDATE memory_projections SET
          relative_path = ?, title = ?, content = ?, content_hash = ?, token_count = ?,
          tokenizer_id = ?, graph_version = ?, included_assertion_ids_json = ?,
          sensitivity = ?, generated_at_utc = ?, status = 'active'
        WHERE id = ?
      `).run(
        relativePath, input.title, input.content, input.contentHash,
        input.tokenCount, input.tokenizerId, input.graphVersion, includedJson,
        input.sensitivity, nowUtc, id,
      );
    }
    this.refreshFts(id);
    return this.requireProjection(id);
  }

  getProjection(projectionId: string): ProjectionRow | null {
    const row = this.database
      .prepare('SELECT * FROM memory_projections WHERE id = ?')
      .get(projectionId);
    return row === undefined || row === null ? null : ProjectionRowSchema.parse(row);
  }

  requireProjection(projectionId: string): ProjectionRow {
    const row = this.getProjection(projectionId);
    if (row === null) {
      throw new Error(`Unknown memory projection: ${projectionId}`);
    }
    return row;
  }

  /** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
  getProjections(projectionIds: readonly string[]): Map<string, ProjectionRow> {
    return fetchRowsByIds(this.database, 'memory_projections', ProjectionRowSchema, projectionIds);
  }

  findByTopic(ownerId: string, tier: number, topicKey: string): ProjectionRow | null {
    const row = this.database.prepare(`
      SELECT * FROM memory_projections WHERE owner_id = ? AND tier = ? AND topic_key = ?
    `).get(ownerId, tier, topicKey);
    return row === undefined || row === null ? null : ProjectionRowSchema.parse(row);
  }

  listByTier(ownerId: string, tier: number): ProjectionRow[] {
    return z.array(ProjectionRowSchema).parse(this.database.prepare(`
      SELECT * FROM memory_projections
      WHERE owner_id = ? AND tier = ? AND status = 'active'
      ORDER BY utility_score DESC, topic_key ASC
    `).all(ownerId, tier));
  }

  listAll(ownerId: string): ProjectionRow[] {
    return z.array(ProjectionRowSchema).parse(this.database.prepare(`
      SELECT * FROM memory_projections
      WHERE owner_id = ? AND status = 'active' ORDER BY tier ASC, topic_key ASC
    `).all(ownerId));
  }

  /** Every row for the owner regardless of status — the reconciler's sweep input (§10.3). */
  listAllRows(ownerId: string): ProjectionRow[] {
    return z.array(ProjectionRowSchema).parse(this.database.prepare(`
      SELECT * FROM memory_projections
      WHERE owner_id = ? ORDER BY tier ASC, topic_key ASC
    `).all(ownerId));
  }

  /** Projections compiled before `graphVersion` may no longer match the graph (§10.5). */
  listStale(ownerId: string, graphVersion: number): ProjectionRow[] {
    return z.array(ProjectionRowSchema).parse(this.database.prepare(`
      SELECT * FROM memory_projections
      WHERE owner_id = ? AND status = 'active' AND graph_version < ?
      ORDER BY tier ASC, topic_key ASC
    `).all(ownerId, graphVersion));
  }

  readIncludedAssertionIds(row: ProjectionRow): string[] {
    return parseJsonText(row.included_assertion_ids_json, AssertionIdListSchema);
  }

  setUtility(projectionId: string, utilityScore: number): ProjectionRow {
    this.database
      .prepare('UPDATE memory_projections SET utility_score = ? WHERE id = ?')
      .run(utilityScore, projectionId);
    return this.requireProjection(projectionId);
  }

  setStatus(projectionId: string, status: ProjectionStatus): ProjectionRow {
    this.database
      .prepare('UPDATE memory_projections SET status = ? WHERE id = ?')
      .run(status, projectionId);
    this.refreshFts(projectionId);
    return this.requireProjection(projectionId);
  }

  recordRetrieval(projectionId: string): ProjectionRow {
    this.database.prepare(`
      UPDATE memory_projections
      SET retrieval_count = retrieval_count + 1, last_retrieved_at_utc = ?
      WHERE id = ?
    `).run(this.clock.nowUtc(), projectionId);
    return this.requireProjection(projectionId);
  }

  deleteProjection(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row !== null) {
      dropFtsRow(this.database, 'memory_projections', projectionId, row.fts_rowid);
    }
    this.database.prepare('DELETE FROM memory_projections WHERE id = ?').run(projectionId);
  }

  search(ownerId: string, query: string, limit: number): string[] {
    const rows = this.database.prepare(`
      SELECT projection_id FROM memory_projections_fts
      WHERE memory_projections_fts MATCH ? AND owner_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, ownerId, limit);
    return z.array(z.object({ projection_id: z.string() })).parse(rows)
      .map((row) => row.projection_id);
  }

  /** Rewrites the FTS row from canonical state. Sensitive projections are never indexed (§5.3). */
  private refreshFts(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row === null) return;
    dropFtsRow(this.database, 'memory_projections', projectionId, row.fts_rowid);
    if (row.status !== 'active') return;
    if (!isIndexableInPlaintext(row.sensitivity)) return;
    const inserted = this.database.prepare(`
      INSERT INTO memory_projections_fts (projection_id, owner_id, tier, topic_key, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.owner_id, row.tier, row.topic_key, row.content);
    recordFtsRowid(this.database, 'memory_projections', projectionId, inserted.lastInsertRowid);
  }
}
