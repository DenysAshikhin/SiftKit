import { z } from '../../lib/zod.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { MODEL_MATCH_SCORE_THRESHOLD } from '../graph/entity-resolver.js';
import type { StructuredOutputRunner } from '../inference/structured-runner.js';

const ConsolidationSchema = z.object({
  duplicateGroups: z.array(z.object({
    keepCandidateId: z.string(),
    dropCandidateIds: z.array(z.string()),
  }).strict()).max(50),
  entityMatches: z.array(z.object({
    candidateId: z.string(),
    nodeId: z.string(),
    score: z.number().min(0).max(1),
  }).strict()).max(50),
}).strict();

const CONSOLIDATOR_INSTRUCTIONS = [
  'You are given pending memory candidates. Suggest which of them describe the same fact, and',
  'which refer to an entity that already exists in the graph. Suggest only — you cannot merge,',
  'delete, write, or confirm anything. Use the exact ids supplied. Output JSON only.',
].join('\n');

export interface ConsolidateRequest {
  readonly ownerId: string;
  readonly candidateIds: readonly string[];
  readonly abortSignal: AbortSignal | null;
}

export interface EntityMatch {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly score: number;
}

export interface ConsolidateResult {
  readonly droppedCandidateIds: readonly string[];
  readonly entityMatches: readonly EntityMatch[];
}

/**
 * Role `candidate_consolidator` (§8.4). Proposal-only: it rejects duplicate *candidates* and
 * returns entity matches for the promoter to use as `modelSuggestion`. It never merges a node,
 * never writes an assertion, and never touches policy.
 */
export class CandidateConsolidator {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly runner: StructuredOutputRunner,
  ) {}

  async consolidate(request: ConsolidateRequest): Promise<ConsolidateResult> {
    if (request.candidateIds.length === 0) {
      return { droppedCandidateIds: [], entityMatches: [] };
    }
    const known = new Set(request.candidateIds);
    const outcome = await this.runner.run({
      role: 'candidate_consolidator',
      instructions: CONSOLIDATOR_INSTRUCTIONS,
      userText: this.renderCandidates(request.candidateIds),
      schemaName: 'assistant_candidate_consolidation',
      schema: ConsolidationSchema,
      abortSignal: request.abortSignal,
    });
    if (!outcome.ok) {
      this.graph.audit.recordAuditEvent({
        ownerId: request.ownerId,
        eventType: 'consolidation_rejected',
        targetType: null,
        targetId: null,
        summary: 'Candidate consolidation produced no usable structured output.',
        details: { code: outcome.code, attempts: outcome.attempts },
      });
      return { droppedCandidateIds: [], entityMatches: [] };
    }

    const droppedCandidateIds: string[] = [];
    this.graph.transaction(() => {
      for (const group of outcome.value.duplicateGroups) {
        if (!known.has(group.keepCandidateId)) continue;
        for (const dropId of group.dropCandidateIds) {
          if (!known.has(dropId) || dropId === group.keepCandidateId) continue;
          if (this.graph.candidates.getCandidate(dropId)?.status !== 'pending') continue;
          this.graph.candidates.reject(dropId, 'duplicate_of_pending_candidate');
          droppedCandidateIds.push(dropId);
        }
      }
    });

    const entityMatches = outcome.value.entityMatches.filter((match) =>
      known.has(match.candidateId)
      && match.score >= MODEL_MATCH_SCORE_THRESHOLD
      && this.graph.nodes.getNode(match.nodeId) !== null);

    return { droppedCandidateIds, entityMatches };
  }

  private renderCandidates(candidateIds: readonly string[]): string {
    const lines: string[] = [];
    for (const candidateId of candidateIds) {
      const candidate = this.graph.candidates.getCandidate(candidateId);
      if (candidate === null) continue;
      const refs = this.graph.candidates.readRefs(candidate);
      const objectText = refs.object.kind === 'literal'
        ? String(refs.object.value)
        : refs.object.displayName;
      lines.push(
        `${candidate.id}: ${refs.subject.displayName} ${candidate.predicate} ${objectText}`,
      );
    }
    return lines.join('\n');
  }
}
