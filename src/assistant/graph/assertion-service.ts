import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { AssistantTransactionManager } from '../transactions/assistant-transaction-manager.js';
import { resolveConfidence } from '../domain/confidence.js';
import {
  isExplicitBasis,
  type ActorType, type AssertionBasis, type EvidenceStance, type Sensitivity,
} from '../domain/enums.js';
import { buildAssertionKey, type AssertionObjectRef } from '../domain/keys.js';
import { RELATION_DEFINITIONS, type RelationType } from '../domain/relation-types.js';
import type { AssertionSearchText, AssertionStore } from '../storage/assertion-store.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';
import type { AssertionRow } from '../storage/rows.js';
import type { AssertionValidator, ValidationCode } from './validation.js';

export interface EvidenceLinkInput {
  readonly evidenceId: string;
  readonly stance: EvidenceStance;
  readonly weight: number;
}

export interface AssertRequest {
  readonly ownerId: string;
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly subjectNodeId: string;
  readonly predicate: string;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly basis: AssertionBasis;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly observedAtUtc: string;
  readonly topics: readonly string[];
  readonly attributes: JsonObject;
  readonly searchText: AssertionSearchText;
  readonly evidence: readonly EvidenceLinkInput[];
}

/**
 * An `AssertRequest` whose predicate the validator has already narrowed to a registry member.
 * Every write path takes this, so no branch downstream has to guess at an unknown predicate.
 */
export type ValidatedAssertRequest =
  Omit<AssertRequest, 'predicate'> & { readonly predicate: RelationType };

export interface CorrectRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly object: AssertionObjectRef;
  readonly reason: string;
  readonly observedAtUtc: string;
  readonly evidenceId: string;
  readonly searchText: AssertionSearchText;
}

export interface ConfirmRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
  readonly evidenceId: string;
}

export interface PinRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly pinned: boolean;
  readonly reason: string;
}

export interface StatusChangeRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
}

export interface RecalculateRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
}

export type AssertionRejectionCode = ValidationCode | 'assertion_locked';

export type AssertionWriteOutcome =
  | { readonly kind: 'created'; readonly assertionId: string }
  | { readonly kind: 'reinforced'; readonly assertionId: string }
  | {
    readonly kind: 'superseded';
    readonly assertionId: string;
    readonly supersededAssertionId: string;
  }
  | {
    readonly kind: 'temporally_closed';
    readonly assertionId: string;
    readonly closedAssertionId: string;
  }
  | {
    readonly kind: 'disputed';
    readonly assertionId: string;
    readonly disputedWithAssertionId: string;
  }
  | { readonly kind: 'contradiction_recorded'; readonly assertionId: string }
  | {
    readonly kind: 'rejected';
    readonly code: AssertionRejectionCode;
    readonly message: string;
  };

/** Cardinalities where a second live value for the same subject/predicate/scope is a conflict. */
const EXCLUSIVE_CARDINALITIES = ['single_current', 'single_per_scope'] as const;

/**
 * The before/after picture written into `graph_mutation_log`. Built from an already-parsed row,
 * so it is an outbound shape rather than a parse boundary, not a parse boundary needing a schema.
 */
type AssertionSnapshot = {
  readonly status: string;
  readonly basis: string;
  readonly confidence: number;
  readonly objectNodeId: string | null;
  readonly objectValueJson: string | null;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly pinned: boolean;
  readonly userDemoted: boolean;
};

function snapshot(assertion: AssertionRow): AssertionSnapshot {
  return {
    status: assertion.status,
    basis: assertion.basis,
    confidence: assertion.confidence,
    objectNodeId: assertion.object_node_id,
    objectValueJson: assertion.object_value_json,
    validFromUtc: assertion.valid_from_utc,
    validToUtc: assertion.valid_to_utc,
    pinned: assertion.pinned,
    userDemoted: assertion.user_demoted,
  };
}

/**
 * Decides what happens when a proposal meets the existing graph. Models never call the stores
 * directly; every write in Gate A goes through one of these methods, inside one transaction,
 * with exactly one graph-version increment.
 */
export class AssertionService {
  constructor(
    private readonly transactions: AssistantTransactionManager,
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
    private readonly audit: AuditStore,
    private readonly policies: PolicyStore,
    private readonly validator: AssertionValidator,
  ) {}

  assert(request: AssertRequest): AssertionWriteOutcome {
    const transaction = this.transactions.begin();
    try {
      const validation = this.validator.validate({
        ownerId: request.ownerId,
        subjectNodeId: request.subjectNodeId,
        predicate: request.predicate,
        object: request.object,
        scopeNodeId: request.scopeNodeId,
        basis: request.basis,
        // Validation checks the ceiling; the service computes the final value from evidence.
        confidence: 0,
        sensitivity: request.sensitivity,
        validFromUtc: request.validFromUtc,
        validToUtc: request.validToUtc,
        topics: request.topics,
      });
      if (!validation.ok) {
        transaction.commit();
        return { kind: 'rejected', code: validation.code, message: validation.message };
      }
      const validated: ValidatedAssertRequest = { ...request, predicate: validation.predicate };
      const definition = RELATION_DEFINITIONS[validated.predicate];
      const assertionKey = buildAssertionKey({
        ownerId: validated.ownerId,
        subjectNodeId: validated.subjectNodeId,
        predicate: validated.predicate,
        object: validated.object,
        scopeNodeId: validated.scopeNodeId,
      });

      const sameKey = this.assertions.findLiveByKey(validated.ownerId, assertionKey);
      if (sameKey !== null) {
        const result = this.reinforce(sameKey, validated);
        transaction.commit();
        return result;
      }

      const rival = this.findExclusiveRival(validated, definition.cardinality);
      if (rival === null) {
        const result = this.createNew(validated, null);
        transaction.commit();
        return result;
      }
      if (this.policies.isAssertionLocked(validated.ownerId, rival.id)) {
        transaction.commit();
        return {
          kind: 'rejected', code: 'assertion_locked',
          message: `Assertion ${rival.id} is locked against automatic change.`,
        };
      }

      if (isExplicitBasis(rival.basis) && !isExplicitBasis(validated.basis)) {
        const result = this.recordContradiction(rival, validated);
        transaction.commit();
        return result;
      }
      if (definition.temporal !== 'none' && validated.validFromUtc !== null) {
        const result = this.closeTemporally(rival, validated);
        transaction.commit();
        return result;
      }
      if (
        definition.conflictStrategy === 'mark_disputed'
        && isExplicitBasis(rival.basis) && isExplicitBasis(validated.basis)
      ) {
        const result = this.dispute(rival, validated);
        transaction.commit();
        return result;
      }
      const result = this.supersede(rival, validated);
      transaction.commit();
      return result;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  correct(request: CorrectRequest): AssertionWriteOutcome {
    const transaction = this.transactions.begin();
    try {
      const existing = this.assertions.requireAssertion(request.assertionId);
      const replacement = this.writeAssertion({
        ownerId: existing.owner_id,
        actorType: 'user',
        actorRef: existing.owner_id,
        subjectNodeId: existing.subject_node_id,
        predicate: existing.predicate,
        object: request.object,
        scopeNodeId: existing.scope_node_id,
        basis: 'explicit_user_statement',
        sensitivity: existing.sensitivity,
        validFromUtc: existing.valid_from_utc,
        validToUtc: existing.valid_to_utc,
        observedAtUtc: request.observedAtUtc,
        topics: [],
        attributes: JSON.parse(existing.attributes_json),
        searchText: request.searchText,
        evidence: [{ evidenceId: request.evidenceId, stance: 'supports', weight: 1 }],
      }, existing.id, true);

      this.assertions.retireAssertion(existing.id, 'superseded');
      this.audit.recordMutation({
        ownerId: existing.owner_id, actorType: 'user', actorRef: existing.owner_id,
        operation: 'supersede_assertion', targetType: 'graph_assertions', targetId: existing.id,
        before: snapshot(existing), after: { supersededBy: replacement.id },
        reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      transaction.commit();
      return {
        kind: 'superseded', assertionId: replacement.id, supersededAssertionId: existing.id,
      };
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  confirm(request: ConfirmRequest): AssertionRow {
    const transaction = this.transactions.begin();
    try {
      const before = this.assertions.requireAssertion(request.assertionId);
      this.database
        .prepare('UPDATE graph_assertions SET basis = ?, updated_at_utc = ? WHERE id = ?')
        .run('explicit_question_answer', this.clock.nowUtc(), request.assertionId);
      this.assertions.linkEvidence(request.assertionId, request.evidenceId, 'supports', 0.98);
      const after = this.applyConfidence(request.assertionId);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'confirm_assertion', targetType: 'graph_assertions',
        targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      transaction.commit();
      return after;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  setPinned(request: PinRequest): AssertionRow {
    const transaction = this.transactions.begin();
    try {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.assertions.setPinned(request.assertionId, request.pinned);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'update_assertion', targetType: 'graph_assertions',
        targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      transaction.commit();
      return after;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  expire(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'expired', 'expire_assertion');
  }

  forget(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'deleted', 'delete_assertion');
  }

  reject(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'rejected', 'reject_assertion');
  }

  /** Re-derives confidence from the currently live supporting and contradicting evidence. */
  recalculateConfidence(request: RecalculateRequest): number {
    const transaction = this.transactions.begin();
    try {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.applyConfidence(request.assertionId);
      if (after.confidence !== before.confidence) {
        this.audit.recordMutation({
          ownerId: request.ownerId, actorType: 'system', actorRef: null,
          operation: 'update_assertion', targetType: 'graph_assertions',
          targetId: request.assertionId,
          before: snapshot(before), after: snapshot(after), reason: request.reason,
        });
        this.audit.incrementGraphVersion();
      }
      transaction.commit();
      return after.confidence;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private changeStatus(
    request: StatusChangeRequest,
    status: 'expired' | 'deleted' | 'rejected',
    operation: 'expire_assertion' | 'delete_assertion' | 'reject_assertion',
  ): AssertionRow {
    const transaction = this.transactions.begin();
    try {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.assertions.retireAssertion(request.assertionId, status);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation, targetType: 'graph_assertions', targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      transaction.commit();
      return after;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  /**
   * A live assertion with the same subject, predicate, and scope but a different key, where the
   * predicate's cardinality forbids two simultaneous values.
   */
  private findExclusiveRival(
    request: ValidatedAssertRequest,
    cardinality: 'many' | 'single_current' | 'single_per_scope' | 'append_only',
  ): AssertionRow | null {
    if (!EXCLUSIVE_CARDINALITIES.some((entry) => entry === cardinality)) return null;
    const candidates = this.assertions
      .listBySubject(request.ownerId, request.subjectNodeId, ['active', 'disputed'])
      .filter((row) => row.predicate === request.predicate)
      .filter((row) => row.scope_node_id === request.scopeNodeId);
    return candidates[0] ?? null;
  }

  private reinforce(existing: AssertionRow, request: ValidatedAssertRequest): AssertionWriteOutcome {
    this.assertions.recordObservation(existing.id, request.observedAtUtc);
    this.linkAll(existing.id, request.evidence);
    const after = this.applyConfidence(existing.id);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: existing.id,
      before: snapshot(existing), after: snapshot(after),
      reason: 'reinforced by new supporting evidence',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'reinforced', assertionId: existing.id };
  }

  private recordContradiction(
    survivor: AssertionRow, request: ValidatedAssertRequest,
  ): AssertionWriteOutcome {
    for (const link of request.evidence) {
      this.assertions.linkEvidence(survivor.id, link.evidenceId, 'contradicts', link.weight);
    }
    const after = this.applyConfidence(survivor.id);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: survivor.id,
      before: snapshot(survivor), after: snapshot(after),
      reason: 'passive evidence contradicted an explicit statement; explicit memory retained',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'contradiction_recorded', assertionId: survivor.id };
  }

  private closeTemporally(rival: AssertionRow, request: ValidatedAssertRequest): AssertionWriteOutcome {
    const validFrom = request.validFromUtc;
    if (validFrom === null) {
      return this.supersede(rival, request);
    }
    const closed = this.assertions.closeValidity(rival.id, validFrom);
    const created = this.createNew(request, null);
    if (created.kind === 'rejected') return created;
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: snapshot(closed),
      reason: 'real-world validity closed by a newer current value',
    });
    return {
      kind: 'temporally_closed',
      assertionId: created.assertionId,
      closedAssertionId: rival.id,
    };
  }

  private dispute(rival: AssertionRow, request: ValidatedAssertRequest): AssertionWriteOutcome {
    const disputedRival = this.assertions.setStatus(rival.id, 'disputed');
    const created = this.writeAssertion(request, null, false);
    this.assertions.setStatus(created.id, 'disputed');
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'dispute_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: snapshot(disputedRival),
      reason: 'two incompatible explicit statements',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'disputed', assertionId: created.id, disputedWithAssertionId: rival.id };
  }

  private supersede(rival: AssertionRow, request: ValidatedAssertRequest): AssertionWriteOutcome {
    const created = this.writeAssertion(request, rival.id, false);
    this.assertions.retireAssertion(rival.id, 'superseded');
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'supersede_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: { supersededBy: created.id },
      reason: 'a newer value of equal or higher basis replaced this one',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'superseded', assertionId: created.id, supersededAssertionId: rival.id };
  }

  private createNew(
    request: ValidatedAssertRequest,
    supersedesAssertionId: string | null,
  ): AssertionWriteOutcome {
    const created = this.writeAssertion(request, supersedesAssertionId, false);
    this.audit.incrementGraphVersion();
    return { kind: 'created', assertionId: created.id };
  }

  private writeAssertion(
    request: ValidatedAssertRequest,
    supersedesAssertionId: string | null,
    userCorrected: boolean,
  ): AssertionRow {
    const created = this.assertions.createAssertion({
      ownerId: request.ownerId,
      subjectNodeId: request.subjectNodeId,
      predicate: request.predicate,
      object: request.object,
      scopeNodeId: request.scopeNodeId,
      status: 'active',
      basis: request.basis,
      confidence: 0,
      sensitivity: request.sensitivity,
      validFromUtc: request.validFromUtc,
      validToUtc: request.validToUtc,
      observedAtUtc: request.observedAtUtc,
      supersedesAssertionId,
      pinned: false,
      attributes: request.attributes,
      searchText: request.searchText,
    });
    this.linkAll(created.id, request.evidence);
    const withConfidence = this.applyConfidence(created.id, userCorrected);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'create_assertion', targetType: 'graph_assertions', targetId: created.id,
      before: null, after: snapshot(withConfidence),
      reason: userCorrected ? 'explicit user correction' : 'new assertion accepted',
    });
    return withConfidence;
  }

  private linkAll(assertionId: string, links: readonly EvidenceLinkInput[]): void {
    for (const link of links) {
      this.assertions.linkEvidence(assertionId, link.evidenceId, link.stance, link.weight);
    }
  }

  private applyConfidence(assertionId: string, userCorrected = false): AssertionRow {
    const assertion = this.assertions.requireAssertion(assertionId);
    const definition = RELATION_DEFINITIONS[assertion.predicate];
    const observationAgeDays = Math.max(
      0,
      (Date.parse(this.clock.nowUtc()) - Date.parse(assertion.last_observed_at_utc)) / 86_400_000,
    );
    const support = this.assertions.listSupportingEvidence(assertionId);
    const confidence = resolveConfidence({
      basis: assertion.basis,
      supportWeights: support.map((row) => row.weight),
      contradictionCount: this.assertions.contradictionCount(assertionId),
      // One frame of a screen is the weakest evidence the assistant records (§8.3).
      singleScreenshotTextObservation:
        support.length === 1 && support[0]?.source_type === 'screenshot',
      userCorrected,
      stalenessClass: definition.stalenessClass,
      observationAgeDays,
    });
    return this.assertions.setConfidence(assertionId, confidence);
  }
}
