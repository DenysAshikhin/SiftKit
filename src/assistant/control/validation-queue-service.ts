import type { AssistantValidationCandidateDto } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeLiteralValue } from '../domain/keys.js';
import type { CandidatePromoter, PromotionOutcome } from '../ingestion/candidate-promoter.js';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';

interface ValidationQueueServiceOptions {
  readonly graph: AssistantGraph;
  readonly ownerId: string;
  readonly promoter: CandidatePromoter;
  readonly projectionPriority: number;
}

/** The validation queue a user reviews before a candidate becomes an assertion. */
export class ValidationQueueService {
  private readonly graph: AssistantGraph;
  private readonly ownerId: string;
  private readonly promoter: CandidatePromoter;
  private projectionPriority: number;

  constructor(options: ValidationQueueServiceOptions) {
    this.graph = options.graph;
    this.ownerId = options.ownerId;
    this.promoter = options.promoter;
    this.projectionPriority = options.projectionPriority;
  }

  refreshProjectionPriority(priority: number): void {
    if (!Number.isInteger(priority)) throw new Error('Projection priority must be an integer.');
    this.projectionPriority = priority;
  }

  list(): AssistantValidationCandidateDto[] {
    return this.graph.candidates.listValidationQueue(this.ownerId).map((row) => {
      const refs = this.graph.candidates.readRefs(row);
      const objectText = refs.object.kind === 'literal'
        ? normalizeLiteralValue(refs.object.valueType, refs.object.value)
        : refs.object.displayName;
      const evidenceId = row.observation_id === null
        ? null
        : this.graph.observations.requireObservation(row.observation_id).evidence_id;
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
        hold: this.graph.candidates.readHold(row),
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
    const hold = this.graph.candidates.readHold(candidate);
    if (hold === null || hold.kind !== 'possible_owner_alias') {
      throw new AssistantConflictError(
        `Candidate ${candidateId} is not held on an identity question.`,
      );
    }
    const identityName = hold.name;

    // Either answer has to leave an alias behind before the re-promotion runs. That alias is what
    // settles the name: the promoter only asks about a name nothing in the graph resolves, so
    // writing one here both routes this candidate and retires the question for good.
    const transaction = this.graph.transactions.begin();
    try {
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
        this.recordSeparatePerson(identityName);
      }

      this.graph.candidates.returnToPending(candidateId);
      const outcome = this.promoter.promote({ ownerId: this.ownerId, candidateId });
      // The runner recompiles after every extraction it promotes; a user's answer promotes too.
      if (outcome.kind === 'promoted') {
        this.graph.enqueueProjectionMaintenance(this.ownerId, this.projectionPriority);
      }
      transaction.commit();
      return outcome;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  /**
   * The owner said this name is someone else. The node carries a `user_supplied` alias so the
   * answer survives even if no fact ever lands on it: the orphan cleanup keeps user-named nodes.
   */
  private recordSeparatePerson(name: string): void {
    const node = this.graph.nodes.createNode({
      ownerId: this.ownerId, type: 'person', canonicalKey: null, displayName: name,
      description: null, sensitivity: 'personal', properties: {},
    });
    this.graph.nodes.addAlias({
      ownerId: this.ownerId, nodeId: node.id, alias: name,
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    this.graph.audit.recordMutation({
      ownerId: this.ownerId, actorType: 'user', actorRef: this.ownerId,
      operation: 'create_node', targetType: 'graph_nodes', targetId: node.id,
      before: null, after: { type: 'person', displayName: name },
      reason: 'the owner said this name is not them',
    });
    this.graph.audit.incrementGraphVersion();
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
