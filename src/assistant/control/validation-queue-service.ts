import type { AssistantValidationCandidateDto } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeLiteralValue } from '../domain/keys.js';
import {
  OWNER_ALIAS_CONFIRMATION_REASON, type CandidatePromoter, type PromotionOutcome,
} from '../ingestion/candidate-promoter.js';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.js';
import type { CandidateRow } from '../storage/rows.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';

/** The name an open identity question is about, or `null` when it is not that kind of hold. */
function identityNameOf(row: CandidateRow): string | null {
  const reason = row.rejection_reason;
  if (reason === null || !reason.startsWith(`${OWNER_ALIAS_CONFIRMATION_REASON}:`)) return null;
  return reason.slice(OWNER_ALIAS_CONFIRMATION_REASON.length + 1);
}

/** The validation queue a user reviews before a candidate becomes an assertion. */
export class ValidationQueueService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly ownerId: string,
    private readonly promoter: CandidatePromoter,
  ) {}

  list(): AssistantValidationCandidateDto[] {
    return this.graph.candidates.listValidationQueue(this.ownerId).map((row) => {
      const refs = this.graph.candidates.readRefs(row);
      const objectText = refs.object.kind === 'literal'
        ? normalizeLiteralValue(refs.object.valueType, refs.object.value)
        : refs.object.displayName;
      const evidenceId = row.observation_id === null
        ? null
        : this.graph.observations.requireObservation(row.observation_id).evidence_id;
      const identityName = identityNameOf(row);
      return {
        id: row.id,
        status: row.status === 'needs_confirmation' ? 'needs_confirmation' : 'pending',
        proposedStatement: `${refs.subject.displayName} ${row.predicate} ${objectText}`,
        rationale: row.rationale,
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        evidenceId,
        userNotes: row.user_notes,
        createdAtUtc: row.created_at_utc,
        confirmationReason: identityName === null
          ? row.rejection_reason
          : OWNER_ALIAS_CONFIRMATION_REASON,
        identityName,
      };
    });
  }

  /**
   * Answers an open "is this name you?" question. Yes writes the name as an owner alias so the
   * resolver settles it silently from now on; no lets the candidate promote normally, which
   * creates the separate person node and leaves that node's own alias behind. Either answer
   * removes the question permanently — the graph now resolves the name.
   */
  resolveIdentity(candidateId: string, isOwner: boolean): PromotionOutcome {
    const candidate = this.graph.candidates.getCandidate(candidateId);
    if (candidate === null || candidate.owner_id !== this.ownerId) {
      throw new AssistantNotFoundError(`Unknown candidate: ${candidateId}`);
    }
    const identityName = identityNameOf(candidate);
    if (identityName === null) {
      throw new AssistantConflictError(
        `Candidate ${candidateId} is not held on an identity question.`,
      );
    }

    // Either answer has to leave an alias behind before the re-promotion runs. That alias is what
    // settles the name: the promoter only asks about a name nothing in the graph resolves, so
    // writing one here both routes this candidate and retires the question for good.
    if (isOwner) {
      const owner = this.graph.nodes.findByCanonicalKey(
        this.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
      );
      if (owner === null) {
        throw new AssistantNotFoundError('The assistant has no owner person node.');
      }
      this.graph.nodes.addAlias({
        ownerId: this.ownerId, nodeId: owner.id, alias: identityName,
        aliasType: 'user_supplied', sourceEvidenceId: null,
      });
    } else {
      this.graph.resolver.resolve({
        ownerId: this.ownerId, nodeType: 'person', displayName: identityName,
        canonicalKey: null, contextNodeIds: [], createIfMissing: true,
      });
    }

    this.graph.candidates.returnToPending(candidateId);
    return this.promoter.promote({ ownerId: this.ownerId, candidateId });
  }

  setNotes(candidateId: string, notes: string): boolean {
    const candidate = this.graph.candidates.getCandidate(candidateId);
    if (candidate === null || candidate.owner_id !== this.ownerId) return false;
    this.graph.candidates.setUserNotes(candidateId, notes);
    return true;
  }

  remove(candidateId: string): boolean {
    const candidate = this.graph.candidates.getCandidate(candidateId);
    if (candidate === null || candidate.owner_id !== this.ownerId) return false;
    this.graph.candidates.removeFromValidationQueue(candidateId);
    return true;
  }
}
