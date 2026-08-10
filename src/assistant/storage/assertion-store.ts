import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import {
  EvidenceSourceTypeSchema, isIndexableInPlaintext,
  type AssertionBasis, type AssertionStatus, type EvidenceStance, type Sensitivity,
} from '../domain/enums.js';
import {
  buildAssertionKey, normalizeLiteralValue, type AssertionObjectRef,
} from '../domain/keys.js';
import type { RelationType } from '../domain/relation-types.js';
import type { IdGenerator } from '../ids.js';
import {
  AssertionEvidenceRowSchema, AssertionRowSchema, CountRowSchema,
  type AssertionEvidenceRow, type AssertionRow,
} from './rows.js';

const SupportingEvidenceSchema = z.object({
  weight: z.number(),
  source_type: EvidenceSourceTypeSchema,
});
export type SupportingEvidence = z.infer<typeof SupportingEvidenceSchema>;

/** Plaintext strings indexed for lexical retrieval. Rendered by the caller, never derived here. */
export interface AssertionSearchText {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly scope: string;
}

export interface CreateAssertionInput {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: RelationType;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly status: AssertionStatus;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly observedAtUtc: string;
  readonly supersedesAssertionId: string | null;
  readonly pinned: boolean;
  readonly attributes: JsonObject;
  readonly searchText: AssertionSearchText;
}

/** Statuses that hold the unique assertion key. */
export const LIVE_ASSERTION_STATUSES: readonly AssertionStatus[] = ['active', 'disputed'];

export class AssertionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createAssertion(input: CreateAssertionInput): AssertionRow {
    const id = this.ids.next('ast');
    const nowUtc = this.clock.nowUtc();
    const assertionKey = buildAssertionKey({
      ownerId: input.ownerId,
      subjectNodeId: input.subjectNodeId,
      predicate: input.predicate,
      object: input.object,
      scopeNodeId: input.scopeNodeId,
    });
    const isNodeObject = input.object.kind === 'node';
    this.database.prepare(`
      INSERT INTO graph_assertions (
        id, owner_id, assertion_key, subject_node_id, predicate, object_kind, object_node_id,
        object_value_type, object_value_json, object_normalized_text, scope_node_id, status,
        basis, confidence, sensitivity, valid_from_utc, valid_to_utc, first_observed_at_utc,
        last_observed_at_utc, recorded_at_utc, retired_at_utc, supersedes_assertion_id, pinned,
        attributes_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, assertionKey, input.subjectNodeId, input.predicate,
      input.object.kind,
      isNodeObject ? input.object.nodeId : null,
      isNodeObject ? null : input.object.valueType,
      isNodeObject ? null : JSON.stringify(input.object.value),
      isNodeObject ? null : normalizeLiteralValue(input.object.valueType, input.object.value),
      input.scopeNodeId, input.status, input.basis, input.confidence, input.sensitivity,
      input.validFromUtc, input.validToUtc, input.observedAtUtc, input.observedAtUtc, nowUtc,
      input.supersedesAssertionId, input.pinned ? 1 : 0,
      JSON.stringify(input.attributes), nowUtc, nowUtc,
    );
    this.refreshFts(id, input.searchText);
    return this.requireAssertion(id);
  }

  getAssertion(assertionId: string): AssertionRow | null {
    const row = this.database.prepare('SELECT * FROM graph_assertions WHERE id = ?').get(assertionId);
    return row === undefined || row === null ? null : AssertionRowSchema.parse(row);
  }

  requireAssertion(assertionId: string): AssertionRow {
    const assertion = this.getAssertion(assertionId);
    if (assertion === null) {
      throw new Error(`Unknown graph assertion: ${assertionId}`);
    }
    return assertion;
  }

  /** The live assertion holding this key, if any. Backs conflict detection in Task 14. */
  findLiveByKey(ownerId: string, assertionKey: string): AssertionRow | null {
    const row = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND assertion_key = ? AND status IN ('active', 'disputed')
    `).get(ownerId, assertionKey);
    return row === undefined || row === null ? null : AssertionRowSchema.parse(row);
  }

  listBySubject(
    ownerId: string, subjectNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('subject_node_id', ownerId, subjectNodeId, statuses);
  }

  listByObjectNode(
    ownerId: string, objectNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('object_node_id', ownerId, objectNodeId, statuses);
  }

  listByScope(
    ownerId: string, scopeNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('scope_node_id', ownerId, scopeNodeId, statuses);
  }

  /**
   * Live assertions for a subject whose real-world validity window contains `atUtc`.
   * An open `valid_from` or `valid_to` is treated as unbounded on that side.
   */
  listCurrent(ownerId: string, subjectNodeId: string, atUtc: string): AssertionRow[] {
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND subject_node_id = ? AND status IN ('active', 'disputed')
        AND (valid_from_utc IS NULL OR valid_from_utc <= ?)
        AND (valid_to_utc IS NULL OR valid_to_utc > ?)
      ORDER BY last_observed_at_utc DESC, id ASC
    `).all(ownerId, subjectNodeId, atUtc, atUtc));
  }

  list(ownerId: string, limit: number, offset: number): AssertionRow[] {
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND status <> 'deleted'
      ORDER BY updated_at_utc DESC, id ASC LIMIT ? OFFSET ?
    `).all(ownerId, limit, offset));
  }

  /** Moves an assertion out of the live set, freeing its assertion key. */
  retireAssertion(assertionId: string, status: AssertionStatus): AssertionRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET status = ?, retired_at_utc = ?, updated_at_utc = ? WHERE id = ?
    `).run(status, nowUtc, nowUtc, assertionId);
    this.database.prepare('DELETE FROM graph_assertions_fts WHERE assertion_id = ?').run(assertionId);
    return this.requireAssertion(assertionId);
  }

  setStatus(assertionId: string, status: AssertionStatus): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET status = ?, updated_at_utc = ? WHERE id = ?')
      .run(status, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  setConfidence(assertionId: string, confidence: number): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET confidence = ?, updated_at_utc = ? WHERE id = ?')
      .run(confidence, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  setPinned(assertionId: string, pinned: boolean): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET pinned = ?, updated_at_utc = ? WHERE id = ?')
      .run(pinned ? 1 : 0, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  setUserPriority(assertionId: string, pinned: boolean, userDemoted: boolean): AssertionRow {
    this.database.prepare(`
      UPDATE graph_assertions
      SET pinned = ?, user_demoted = ?, updated_at_utc = ? WHERE id = ?
    `).run(pinned ? 1 : 0, userDemoted ? 1 : 0, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  listDependents(assertionId: string): AssertionRow[] {
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE supersedes_assertion_id = ? AND status <> 'deleted'
      ORDER BY created_at_utc ASC, id ASC
    `).all(assertionId));
  }

  /** Closes the real-world validity window without retiring the row (§9.3 temporal change). */
  closeValidity(assertionId: string, validToUtc: string): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET valid_to_utc = ?, updated_at_utc = ? WHERE id = ?')
      .run(validToUtc, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  /** Extends the support window when new evidence arrives for an existing assertion. */
  recordObservation(assertionId: string, observedAtUtc: string): AssertionRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET first_observed_at_utc = MIN(first_observed_at_utc, ?),
          last_observed_at_utc = MAX(last_observed_at_utc, ?),
          updated_at_utc = ?
      WHERE id = ?
    `).run(observedAtUtc, observedAtUtc, nowUtc, assertionId);
    return this.requireAssertion(assertionId);
  }

  /** Re-points a node reference during a merge and recomputes the assertion key. */
  repointNodeReference(
    assertionId: string,
    column: 'subject_node_id' | 'object_node_id' | 'scope_node_id',
    targetNodeId: string,
  ): AssertionRow {
    const existing = this.requireAssertion(assertionId);
    this.database
      .prepare(`UPDATE graph_assertions SET ${column} = ?, updated_at_utc = ? WHERE id = ?`)
      .run(targetNodeId, this.clock.nowUtc(), assertionId);
    const moved = this.requireAssertion(assertionId);
    const objectRef: AssertionObjectRef = moved.object_kind === 'node'
      ? { kind: 'node', nodeId: moved.object_node_id ?? '' }
      : {
        kind: 'literal',
        valueType: moved.object_value_type ?? 'string',
        value: JSON.parse(moved.object_value_json ?? 'null'),
      };
    const rekeyed = buildAssertionKey({
      ownerId: moved.owner_id,
      subjectNodeId: moved.subject_node_id,
      predicate: moved.predicate,
      object: objectRef,
      scopeNodeId: moved.scope_node_id,
    });
    if (rekeyed !== existing.assertion_key) {
      this.database
        .prepare('UPDATE graph_assertions SET assertion_key = ? WHERE id = ?')
        .run(rekeyed, assertionId);
    }
    return this.requireAssertion(assertionId);
  }

  linkEvidence(
    assertionId: string, evidenceId: string, stance: EvidenceStance, weight: number,
  ): AssertionEvidenceRow {
    this.database.prepare(`
      INSERT INTO assertion_evidence (assertion_id, evidence_id, stance, weight, created_at_utc)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(assertion_id, evidence_id, stance) DO UPDATE SET weight = excluded.weight
    `).run(assertionId, evidenceId, stance, weight, this.clock.nowUtc());
    return AssertionEvidenceRowSchema.parse(this.database.prepare(`
      SELECT * FROM assertion_evidence
      WHERE assertion_id = ? AND evidence_id = ? AND stance = ?
    `).get(assertionId, evidenceId, stance));
  }

  unlinkEvidence(assertionId: string, evidenceId: string): void {
    this.database
      .prepare('DELETE FROM assertion_evidence WHERE assertion_id = ? AND evidence_id = ?')
      .run(assertionId, evidenceId);
  }

  listEvidence(assertionId: string): AssertionEvidenceRow[] {
    return z.array(AssertionEvidenceRowSchema).parse(this.database.prepare(`
      SELECT * FROM assertion_evidence WHERE assertion_id = ?
      ORDER BY created_at_utc ASC, evidence_id ASC, stance ASC
    `).all(assertionId));
  }

  /** Supporting weights from non-deleted evidence only, for confidence aggregation. */
  /**
   * The assertion's live support, oldest first. Every evidence-derived confidence signal — the
   * support weights and the single-screenshot clamp of §8.3 — is read off this one result.
   */
  listSupportingEvidence(assertionId: string): SupportingEvidence[] {
    return z.array(SupportingEvidenceSchema).parse(this.database.prepare(`
      SELECT ae.weight, e.source_type FROM assertion_evidence ae
      JOIN evidence_records e ON e.id = ae.evidence_id
      WHERE ae.assertion_id = ? AND ae.stance = 'supports' AND e.status <> 'deleted'
      ORDER BY ae.created_at_utc ASC, ae.evidence_id ASC
    `).all(assertionId));
  }

  contradictionCount(assertionId: string): number {
    return CountRowSchema.parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assertion_evidence ae
      JOIN evidence_records e ON e.id = ae.evidence_id
      WHERE ae.assertion_id = ? AND ae.stance = 'contradicts' AND e.status <> 'deleted'
    `).get(assertionId)).count;
  }

  /** Assertions that reference this evidence, used by the deletion cascade. */
  listAssertionIdsForEvidence(evidenceId: string): string[] {
    return z.array(z.object({ assertion_id: z.string() })).parse(this.database.prepare(`
      SELECT DISTINCT assertion_id FROM assertion_evidence WHERE evidence_id = ?
      ORDER BY assertion_id ASC
    `).all(evidenceId)).map((row) => row.assertion_id);
  }

  searchAssertions(ownerId: string, query: string, limit: number): string[] {
    return z.array(z.object({ assertion_id: z.string() })).parse(this.database.prepare(`
      SELECT assertion_id FROM graph_assertions_fts
      WHERE graph_assertions_fts MATCH ? AND owner_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, ownerId, limit)).map((row) => row.assertion_id);
  }

  private listByColumn(
    column: 'subject_node_id' | 'object_node_id' | 'scope_node_id',
    ownerId: string,
    nodeId: string,
    statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND ${column} = ? AND status IN (${placeholders})
      ORDER BY last_observed_at_utc DESC, id ASC
    `).all(ownerId, nodeId, ...statuses));
  }

  private refreshFts(assertionId: string, searchText: AssertionSearchText): void {
    this.database.prepare('DELETE FROM graph_assertions_fts WHERE assertion_id = ?').run(assertionId);
    const assertion = this.requireAssertion(assertionId);
    if (!LIVE_ASSERTION_STATUSES.includes(assertion.status)) return;
    if (!isIndexableInPlaintext(assertion.sensitivity)) return;
    this.database.prepare(`
      INSERT INTO graph_assertions_fts (
        assertion_id, owner_id, subject_text, predicate_text, object_text, scope_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      assertionId, assertion.owner_id, searchText.subject, searchText.predicate,
      searchText.object, searchText.scope,
    );
  }
}
