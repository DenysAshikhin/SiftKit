import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import {
  isIndexableInPlaintext, type AliasType, type NodeStatus, type Sensitivity,
} from '../domain/enums.js';
import { normalizeAliasText } from '../domain/keys.js';
import type { NodeType } from '../domain/node-types.js';
import type { IdGenerator } from '../ids.js';
import {
  AliasRowSchema, MergeRowSchema, NodeRowSchema,
  type AliasRow, type MergeRow, type NodeRow,
} from './rows.js';

export interface CreateNodeInput {
  readonly ownerId: string;
  readonly type: NodeType;
  readonly canonicalKey: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly sensitivity: Sensitivity;
  readonly properties: JsonObject;
}

export interface UpdateNodeInput {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly sensitivity?: Sensitivity;
  readonly properties?: JsonObject;
}

export interface AddAliasInput {
  readonly ownerId: string;
  readonly nodeId: string;
  readonly alias: string;
  readonly aliasType: AliasType;
  readonly sourceEvidenceId: string | null;
}

export interface RecordMergeInput {
  readonly ownerId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly basis: string;
  readonly reversible: boolean;
}

export class NodeStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createNode(input: CreateNodeInput): NodeRow {
    const id = this.ids.next('node');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO graph_nodes (
        id, owner_id, type, canonical_key, display_name, description, sensitivity, status,
        properties_json, merged_into_node_id, created_at_utc, updated_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
    `).run(
      id, input.ownerId, input.type, input.canonicalKey, input.displayName,
      input.description, input.sensitivity, JSON.stringify(input.properties), nowUtc, nowUtc,
    );
    this.refreshFts(id);
    const created = this.getNode(id);
    if (created === null) {
      throw new Error(`Node ${id} vanished immediately after insert.`);
    }
    return created;
  }

  getNode(nodeId: string): NodeRow | null {
    const row = this.database.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(nodeId);
    return row === undefined || row === null ? null : NodeRowSchema.parse(row);
  }

  /** Throws instead of returning null. Use where a missing node is a programming error. */
  requireNode(nodeId: string): NodeRow {
    const node = this.getNode(nodeId);
    if (node === null) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }

  findByCanonicalKey(ownerId: string, type: NodeType, canonicalKey: string): NodeRow | null {
    const row = this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND canonical_key = ? AND status <> 'deleted'
    `).get(ownerId, type, canonicalKey);
    return row === undefined || row === null ? null : NodeRowSchema.parse(row);
  }

  listNodesByType(ownerId: string, type: NodeType): NodeRow[] {
    return z.array(NodeRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND status = 'active'
      ORDER BY display_name ASC, id ASC
    `).all(ownerId, type));
  }

  list(ownerId: string, limit: number, offset: number): NodeRow[] {
    return z.array(NodeRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND status <> 'deleted'
      ORDER BY display_name ASC, id ASC LIMIT ? OFFSET ?
    `).all(ownerId, limit, offset));
  }

  updateNode(nodeId: string, input: UpdateNodeInput): NodeRow {
    const existing = this.requireNode(nodeId);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_nodes
      SET display_name = ?, description = ?, sensitivity = ?, properties_json = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(
      input.displayName ?? existing.display_name,
      input.description === undefined ? existing.description : input.description,
      input.sensitivity ?? existing.sensitivity,
      input.properties === undefined ? existing.properties_json : JSON.stringify(input.properties),
      nowUtc, nodeId,
    );
    this.refreshFts(nodeId);
    return this.requireNode(nodeId);
  }

  setNodeStatus(nodeId: string, status: NodeStatus, mergedIntoNodeId: string | null = null): NodeRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_nodes
      SET status = ?, merged_into_node_id = ?, updated_at_utc = ?,
          deleted_at_utc = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at_utc END
      WHERE id = ?
    `).run(status, mergedIntoNodeId, nowUtc, status, nowUtc, nodeId);
    this.refreshFts(nodeId);
    return this.requireNode(nodeId);
  }

  addAlias(input: AddAliasInput): AliasRow {
    const normalized = normalizeAliasText(input.alias);
    const existing = this.database.prepare(`
      SELECT * FROM graph_node_aliases WHERE node_id = ? AND normalized_alias = ?
    `).get(input.nodeId, normalized);
    if (existing !== undefined && existing !== null) {
      return AliasRowSchema.parse(existing);
    }
    const id = this.ids.next('alias');
    this.database.prepare(`
      INSERT INTO graph_node_aliases (
        id, owner_id, node_id, alias, normalized_alias, alias_type,
        source_evidence_id, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, input.nodeId, input.alias, normalized,
      input.aliasType, input.sourceEvidenceId, this.clock.nowUtc(),
    );
    this.refreshFts(input.nodeId);
    return AliasRowSchema.parse(
      this.database.prepare('SELECT * FROM graph_node_aliases WHERE id = ?').get(id),
    );
  }

  listAliases(nodeId: string): AliasRow[] {
    return z.array(AliasRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_node_aliases WHERE node_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(nodeId));
  }

  /** Alias lookup, optionally constrained to one node type (resolution order step 3, §9.1). */
  findByAlias(ownerId: string, alias: string, type?: NodeType): NodeRow[] {
    const normalized = normalizeAliasText(alias);
    const rows = type === undefined
      ? this.database.prepare(`
          SELECT n.* FROM graph_nodes n
          JOIN graph_node_aliases a ON a.node_id = n.id
          WHERE a.owner_id = ? AND a.normalized_alias = ? AND n.status = 'active'
          ORDER BY n.id ASC
        `).all(ownerId, normalized)
      : this.database.prepare(`
          SELECT n.* FROM graph_nodes n
          JOIN graph_node_aliases a ON a.node_id = n.id
          WHERE a.owner_id = ? AND a.normalized_alias = ? AND n.type = ? AND n.status = 'active'
          ORDER BY n.id ASC
        `).all(ownerId, normalized, type);
    return z.array(NodeRowSchema).parse(rows);
  }

  /** Re-points every alias of `sourceNodeId` at `targetNodeId`. Used by the merge service. */
  reassignAliases(sourceNodeId: string, targetNodeId: string): string[] {
    const moved = this.listAliases(sourceNodeId).map((alias) => alias.id);
    this.database
      .prepare('UPDATE graph_node_aliases SET node_id = ? WHERE node_id = ?')
      .run(targetNodeId, sourceNodeId);
    this.refreshFts(sourceNodeId);
    this.refreshFts(targetNodeId);
    return moved;
  }

  searchNodes(ownerId: string, query: string, limit: number): string[] {
    const rows = this.database.prepare(`
      SELECT node_id FROM graph_nodes_fts
      WHERE graph_nodes_fts MATCH ? AND owner_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, ownerId, limit);
    return z.array(z.object({ node_id: z.string() })).parse(rows).map((row) => row.node_id);
  }

  recordMerge(input: RecordMergeInput): MergeRow {
    const id = this.ids.next('merge');
    this.database.prepare(`
      INSERT INTO graph_entity_merges (
        id, owner_id, source_node_id, target_node_id, basis, reversible,
        created_at_utc, reversed_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, input.ownerId, input.sourceNodeId, input.targetNodeId, input.basis,
      input.reversible ? 1 : 0, this.clock.nowUtc(),
    );
    return this.requireMerge(id);
  }

  requireMerge(mergeId: string): MergeRow {
    const row = this.database.prepare('SELECT * FROM graph_entity_merges WHERE id = ?').get(mergeId);
    if (row === undefined || row === null) {
      throw new Error(`Unknown entity merge: ${mergeId}`);
    }
    return MergeRowSchema.parse(row);
  }

  markMergeReversed(mergeId: string): void {
    this.database
      .prepare('UPDATE graph_entity_merges SET reversed_at_utc = ? WHERE id = ?')
      .run(this.clock.nowUtc(), mergeId);
  }

  listMerges(ownerId: string): MergeRow[] {
    return z.array(MergeRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_entity_merges WHERE owner_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(ownerId));
  }

  /**
   * Rewrites the node's FTS row from its current canonical state. Called after every write that
   * changes indexed text, status, or sensitivity, inside the caller's transaction.
   */
  private refreshFts(nodeId: string): void {
    this.database.prepare('DELETE FROM graph_nodes_fts WHERE node_id = ?').run(nodeId);
    const node = this.getNode(nodeId);
    if (node === null || node.status !== 'active') return;
    if (!isIndexableInPlaintext(node.sensitivity)) return;
    const aliases = this.listAliases(nodeId).map((alias) => alias.alias).join(' ');
    this.database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, node.owner_id, node.display_name, aliases, node.description ?? '');
  }
}
