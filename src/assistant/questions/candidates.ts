import type { AssistantGraph } from '../assistant-graph.js';
import type { QuestionType } from '../domain/enums.js';
import type { CandidateRow, NodeRow } from '../storage/rows.js';

export const SUPPORTED_QUESTION_GAP_TYPES = [
  'candidate_confirmation',
  'scope_clarification',
  'assertion_conflict',
  'active_goal_plan',
] as const;

export interface QuestionCandidate {
  readonly id: string;
  readonly ownerId: string;
  readonly topicKey: string;
  readonly questionType: QuestionType;
  readonly gapType: string;
  readonly candidateIds: readonly string[];
  readonly concreteBenefit: string | null;
  readonly uncertaintyReduction: number;
  readonly futureUsefulness: number;
  readonly currentRelevance: number;
  readonly answerability: number;
  readonly interruptionCost: number;
  readonly sensitivityCost: number;
  readonly repeatPenalty: number;
  readonly expiresAtUtc: string;
}

export interface QuestionCandidateSource {
  list(ownerId: string): QuestionCandidate[];
}

function expiry(nowUtc: string): string {
  return new Date(Date.parse(nowUtc) + 7 * 86_400_000).toISOString();
}

function sensitivityCost(sensitivity: CandidateRow['sensitivity'] | NodeRow['sensitivity']): number {
  if (sensitivity === 'secret_prohibited') return 1;
  if (sensitivity === 'highly_sensitive') return 0.85;
  if (sensitivity === 'sensitive') return 0.6;
  if (sensitivity === 'personal') return 0.15;
  return 0;
}

export class GraphQuestionCandidateSource implements QuestionCandidateSource {
  constructor(private readonly graph: AssistantGraph) {}

  list(ownerId: string): QuestionCandidate[] {
    const candidates = [
      ...this.fromCandidateAssertions(ownerId),
      ...this.fromDisputes(ownerId),
      ...this.fromActiveGoals(ownerId),
    ];
    return candidates.sort((left, right) => left.topicKey.localeCompare(right.topicKey));
  }

  private fromCandidateAssertions(ownerId: string): QuestionCandidate[] {
    return this.graph.candidates.listValidationQueue(ownerId)
      .filter((row) => row.status === 'needs_confirmation')
      .map((row) => {
        const clarifyScope = row.rejection_reason?.toLowerCase().includes('scope') ?? false;
        return {
          id: `question-candidate:${row.id}`,
          ownerId,
          topicKey: `candidate:${row.candidate_fingerprint}`,
          questionType: clarifyScope ? 'clarify_scope' : 'confirm_inference',
          gapType: clarifyScope ? 'scope_clarification' : 'candidate_confirmation',
          candidateIds: [row.id],
          concreteBenefit: 'Resolve an uncertain memory before it affects future answers.',
          uncertaintyReduction: Math.max(0, Math.min(1, 1 - row.confidence)),
          futureUsefulness: 0.8,
          currentRelevance: 0.8,
          answerability: 0.9,
          interruptionCost: 0.1,
          sensitivityCost: sensitivityCost(row.sensitivity),
          repeatPenalty: 0,
          expiresAtUtc: expiry(this.graph.nowUtc()),
        } satisfies QuestionCandidate;
      });
  }

  private fromDisputes(ownerId: string): QuestionCandidate[] {
    return this.graph.assertions.list(ownerId, 10_000, 0)
      .filter((row) => row.status === 'disputed')
      .map((row) => ({
        id: `question-conflict:${row.id}`,
        ownerId,
        topicKey: `assertion:${row.id}`,
        questionType: 'resolve_conflict',
        gapType: 'assertion_conflict',
        candidateIds: [row.id],
        concreteBenefit: 'Resolve contradictory memory before either value is reused.',
        uncertaintyReduction: 1,
        futureUsefulness: 0.85,
        currentRelevance: 0.75,
        answerability: 0.9,
        interruptionCost: 0.15,
        sensitivityCost: sensitivityCost(row.sensitivity),
        repeatPenalty: 0,
        expiresAtUtc: expiry(this.graph.nowUtc()),
      }));
  }

  private fromActiveGoals(ownerId: string): QuestionCandidate[] {
    return this.graph.nodes.listNodesByType(ownerId, 'goal')
      .filter((goal) => !this.graph.assertions.listBySubject(ownerId, goal.id, ['active', 'disputed'])
        .some((assertion) => assertion.predicate === 'HAS_PLAN'))
      .map((goal) => ({
        id: `question-goal:${goal.id}`,
        ownerId,
        topicKey: `goal:${goal.canonical_key ?? goal.id}`,
        questionType: 'follow_active_goal',
        gapType: 'active_goal_plan',
        candidateIds: [],
        concreteBenefit: `Make the active goal “${goal.display_name}” more actionable.`,
        uncertaintyReduction: 0.5,
        futureUsefulness: 0.9,
        currentRelevance: 1,
        answerability: 0.8,
        interruptionCost: 0.15,
        sensitivityCost: sensitivityCost(goal.sensitivity),
        repeatPenalty: 0,
        expiresAtUtc: expiry(this.graph.nowUtc()),
      }));
  }
}
