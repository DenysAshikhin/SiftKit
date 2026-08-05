import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import { JsonValueSchema } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import {
  ObjectValueTypeSchema,
  type AssertionBasis, type CandidateStatus, type Sensitivity,
} from '../domain/enums.js';
import {
  buildCandidateFingerprint, type CandidateObjectRef, type UnresolvedNodeRef,
} from '../domain/keys.js';
import { NodeTypeSchema } from '../domain/node-types.js';
import type { RelationType } from '../domain/relation-types.js';
import type { IdGenerator } from '../ids.js';
import { CandidateRowSchema, type CandidateRow } from './rows.js';

/** Mirrors `UnresolvedNodeRef` in domain/keys.ts — which has no `kind` discriminator. */
const UnresolvedNodeRefSchema = z.object({
  nodeType: NodeTypeSchema,
  displayName: z.string(),
});

/** Mirrors `CandidateObjectRef` in domain/keys.ts — which does discriminate. */
const CandidateObjectRefSchema = z.union([
  z.object({
    kind: z.literal('unresolved'),
    nodeType: NodeTypeSchema,
    displayName: z.string(),
  }),
  z.object({
    kind: z.literal('literal'),
    valueType: ObjectValueTypeSchema,
    value: JsonValueSchema,
  }),
]);

export interface ProposeCandidateInput {
  readonly ownerId: string;
  readonly observationId: string;
  readonly subject: UnresolvedNodeRef;
  readonly predicate: RelationType;
  readonly object: CandidateObjectRef;
  readonly scope: UnresolvedNodeRef | null;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly rationale: string;
}

export interface CandidateRefs {
  readonly subject: UnresolvedNodeRef;
  readonly object: CandidateObjectRef;
  readonly scope: UnresolvedNodeRef | null;
}

/**
 * Owns `candidate_assertions` — proposals, never beliefs. Only `CandidatePromoter` turns one into
 * a graph assertion; nothing in this file writes to the graph.
 */
export class CandidateStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Returns `null` when the same proposal already exists for this observation (§8.3). */
  propose(input: ProposeCandidateInput): CandidateRow | null {
    const fingerprint = buildCandidateFingerprint({
      ownerId: input.ownerId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      scope: input.scope,
    });
    const existing = this.database.prepare(`
      SELECT id FROM candidate_assertions
      WHERE owner_id = ? AND candidate_fingerprint = ? AND observation_id IS ?
    `).get(input.ownerId, fingerprint, input.observationId);
    if (existing !== undefined && existing !== null) {
      return null;
    }
    const id = this.ids.next('cand');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO candidate_assertions (
        id, owner_id, observation_id, candidate_fingerprint, subject_ref_json, predicate,
        object_ref_json, scope_ref_json, basis, confidence, sensitivity, valid_from_utc,
        valid_to_utc, rationale, status, rejection_reason, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
    `).run(
      id, input.ownerId, input.observationId, fingerprint, JSON.stringify(input.subject),
      input.predicate, JSON.stringify(input.object),
      input.scope === null ? null : JSON.stringify(input.scope),
      input.basis, input.confidence, input.sensitivity, input.validFromUtc, input.validToUtc,
      input.rationale, nowUtc, nowUtc,
    );
    return this.requireCandidate(id);
  }

  getCandidate(candidateId: string): CandidateRow | null {
    const row = this.database
      .prepare('SELECT * FROM candidate_assertions WHERE id = ?')
      .get(candidateId);
    return row === undefined || row === null ? null : CandidateRowSchema.parse(row);
  }

  requireCandidate(candidateId: string): CandidateRow {
    const row = this.getCandidate(candidateId);
    if (row === null) {
      throw new Error(`Unknown candidate assertion: ${candidateId}`);
    }
    return row;
  }

  listPending(ownerId: string): CandidateRow[] {
    return z.array(CandidateRowSchema).parse(this.database.prepare(`
      SELECT * FROM candidate_assertions
      WHERE owner_id = ? AND status = 'pending' ORDER BY created_at_utc ASC, id ASC
    `).all(ownerId));
  }

  listByObservation(observationId: string): CandidateRow[] {
    return z.array(CandidateRowSchema).parse(this.database.prepare(`
      SELECT * FROM candidate_assertions
      WHERE observation_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(observationId));
  }

  accept(candidateId: string): CandidateRow {
    return this.setStatus(candidateId, 'accepted', null);
  }

  reject(candidateId: string, rejectionReason: string): CandidateRow {
    return this.setStatus(candidateId, 'rejected', rejectionReason);
  }

  needsConfirmation(candidateId: string, reason: string): CandidateRow {
    return this.setStatus(candidateId, 'needs_confirmation', reason);
  }

  setConfidence(candidateId: string, confidence: number): CandidateRow {
    this.database.prepare(`
      UPDATE candidate_assertions SET confidence = ?, updated_at_utc = ? WHERE id = ?
    `).run(confidence, this.clock.nowUtc(), candidateId);
    return this.requireCandidate(candidateId);
  }

  readRefs(row: CandidateRow): CandidateRefs {
    return {
      subject: parseJsonText(row.subject_ref_json, UnresolvedNodeRefSchema),
      object: parseJsonText(row.object_ref_json, CandidateObjectRefSchema),
      scope: row.scope_ref_json === null
        ? null
        : parseJsonText(row.scope_ref_json, UnresolvedNodeRefSchema),
    };
  }

  private setStatus(
    candidateId: string,
    status: CandidateStatus,
    rejectionReason: string | null,
  ): CandidateRow {
    this.database.prepare(`
      UPDATE candidate_assertions SET status = ?, rejection_reason = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(status, rejectionReason, this.clock.nowUtc(), candidateId);
    return this.requireCandidate(candidateId);
  }
}