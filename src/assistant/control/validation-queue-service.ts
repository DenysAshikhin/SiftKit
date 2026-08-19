import type { AssistantValidationCandidateDto } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeLiteralValue } from '../domain/keys.js';

/** The validation queue a user reviews before a candidate becomes an assertion. */
export class ValidationQueueService {
  constructor(private readonly graph: AssistantGraph, private readonly ownerId: string) {}

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
      };
    });
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
