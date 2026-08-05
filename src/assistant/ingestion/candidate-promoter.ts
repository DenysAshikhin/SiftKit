import type { AssistantGraph } from '../assistant-graph.js';
import type { AssertionObjectRef, CandidateObjectRef, UnresolvedNodeRef } from '../domain/keys.js';
import { normalizeLiteralValue } from '../domain/keys.js';
import type { RelationType } from '../domain/relation-types.js';
import type { AssertionWriteOutcome } from '../graph/assertion-service.js';
import { LIVE_ASSERTION_STATUSES } from '../storage/assertion-store.js';
import type { CandidateRow } from '../storage/rows.js';
import type { CandidateGate } from './candidate-gate.js';

export type PromotionOutcome =
  | { readonly kind: 'promoted'; readonly assertionId: string }
  | { readonly kind: 'needs_confirmation'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export interface PromoteRequest {
  readonly ownerId: string;
  readonly candidateId: string;
}

/**
 * Turns one validated candidate into a graph mutation (§7.1 tail). Every write goes through the
 * Gate A services, so provenance, precedence, and the audit trail are the same as a manual edit.
 */
export class CandidatePromoter {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly gate: CandidateGate,
  ) {}

  promote(request: PromoteRequest): PromotionOutcome {
    const candidate = this.graph.candidates.requireCandidate(request.candidateId);
    const refs = this.graph.candidates.readRefs(candidate);
    const observation = candidate.observation_id === null
      ? null
      : this.graph.observations.requireObservation(candidate.observation_id);
    const evidence = observation === null
      ? null
      : this.graph.evidence.requireEvidence(observation.evidence_id);
    if (evidence === null) {
      return { kind: 'rejected', code: 'no_evidence', message: 'Candidate has no evidence.' };
    }

    const gateOutcome = this.gate.evaluate({
      ownerId: request.ownerId,
      basis: candidate.basis,
      sourceType: evidence.source_type,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
      validFromUtc: candidate.valid_from_utc,
      validToUtc: candidate.valid_to_utc,
      subjectText: refs.subject.displayName,
      objectText: this.describeObject(refs.object),
    });

    if (gateOutcome.kind === 'reject') {
      this.graph.candidates.reject(candidate.id, gateOutcome.code);
      return { kind: 'rejected', code: gateOutcome.code, message: gateOutcome.message };
    }
    if (gateOutcome.kind === 'needs_confirmation') {
      this.graph.candidates.needsConfirmation(candidate.id, gateOutcome.topic);
      return { kind: 'needs_confirmation', reason: gateOutcome.topic };
    }

    const transaction = this.graph.transactions.begin();
    try {
      const subjectNodeId = this.resolveNode(request.ownerId, refs.subject);
      const scopeNodeId = refs.scope === null
        ? null
        : this.resolveNode(request.ownerId, refs.scope);
      const object = this.resolveObject(request.ownerId, refs.object);
      const searchText = {
        subject: refs.subject.displayName,
        predicate: candidate.predicate,
        object: this.describeObject(refs.object),
        scope: refs.scope === null ? '' : refs.scope.displayName,
      };

      const prior = this.findSupersedableAssertion(
        request.ownerId, subjectNodeId, candidate.predicate, scopeNodeId,
      );
      const isCorrection = observation?.observation_type === 'conversation_correction';

      if (isCorrection && prior !== null) {
        const corrected = this.graph.assertionService.correct({
          ownerId: request.ownerId,
          assertionId: prior,
          object,
          reason: candidate.rationale,
          observedAtUtc: evidence.captured_at_utc,
          evidenceId: evidence.id,
          searchText,
        });
        return this.finish(candidate, corrected, transaction);
      }

      const written = this.graph.assertionService.assert({
        ownerId: request.ownerId,
        actorType: 'assistant_proposal',
        actorRef: candidate.id,
        subjectNodeId,
        predicate: candidate.predicate,
        object,
        scopeNodeId,
        basis: candidate.basis,
        sensitivity: candidate.sensitivity,
        validFromUtc: candidate.valid_from_utc,
        validToUtc: candidate.valid_to_utc,
        observedAtUtc: evidence.captured_at_utc,
        topics: [],
        attributes: {},
        searchText,
        evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: gateOutcome.confidence }],
      });
      return this.finish(candidate, written, transaction);
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private finish(
    candidate: CandidateRow,
    outcome: AssertionWriteOutcome,
    transaction: { commit(): void },
  ): PromotionOutcome {
    if (outcome.kind === 'rejected') {
      this.graph.candidates.reject(candidate.id, outcome.code);
      transaction.commit();
      return { kind: 'rejected', code: outcome.code, message: outcome.message };
    }
    this.graph.candidates.accept(candidate.id);
    transaction.commit();
    return { kind: 'promoted', assertionId: outcome.assertionId };
  }

  private resolveNode(ownerId: string, ref: UnresolvedNodeRef): string {
    const outcome = this.graph.resolver.resolve({
      ownerId,
      nodeType: ref.nodeType,
      displayName: ref.displayName,
      canonicalKey: null,
      contextNodeIds: [],
      createIfMissing: true,
    });
    if (outcome.kind === 'needs_confirmation') {
      throw new Error(
        `Entity "${ref.displayName}" is ambiguous between ${outcome.candidateNodeIds.join(', ')}.`,
      );
    }
    return outcome.nodeId;
  }

  private resolveObject(ownerId: string, ref: CandidateObjectRef): AssertionObjectRef {
    return ref.kind === 'literal'
      ? { kind: 'literal', valueType: ref.valueType, value: ref.value }
      : {
          kind: 'node',
          nodeId: this.resolveNode(ownerId, {
            nodeType: ref.nodeType, displayName: ref.displayName,
          }),
        };
  }

  private findSupersedableAssertion(
    ownerId: string,
    subjectNodeId: string,
    predicate: RelationType,
    scopeNodeId: string | null,
  ): string | null {
    const matches = this.graph.assertions
      .listBySubject(ownerId, subjectNodeId, LIVE_ASSERTION_STATUSES)
      .filter((row) => row.predicate === predicate && row.scope_node_id === scopeNodeId);
    return matches[matches.length - 1]?.id ?? null;
  }

  private describeObject(ref: CandidateObjectRef): string {
    return ref.kind === 'literal'
      ? normalizeLiteralValue(ref.valueType, ref.value)
      : ref.displayName;
  }
}
