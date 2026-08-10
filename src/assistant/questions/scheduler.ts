import type { AssistantConfig } from '../../config/types.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { QuestionRow } from '../storage/rows.js';
import type { QuestionCandidate, QuestionCandidateSource } from './candidates.js';
import type { QuestionPlanningService } from './planner.js';
import type { QuestionPolicyDecision, QuestionPolicyEngine } from './policy-engine.js';

export interface PlanQuestionsSummary {
  readonly planned: number;
  readonly eligible: number;
  readonly pendingOnly: number;
  readonly expired: number;
}

interface QuestionSchedulerOptions {
  readonly graph: AssistantGraph;
  readonly candidates: QuestionCandidateSource;
  readonly policy: QuestionPolicyEngine;
  readonly planner: QuestionPlanningService;
  readonly config: AssistantConfig;
}

interface ApprovedCandidate {
  readonly candidate: QuestionCandidate;
  readonly decision: Exclude<QuestionPolicyDecision, { readonly kind: 'ineligible' }>;
}

export class QuestionScheduler {
  private readonly graph: AssistantGraph;
  private readonly candidates: QuestionCandidateSource;
  private readonly policy: QuestionPolicyEngine;
  private readonly planner: QuestionPlanningService;
  private config: AssistantConfig;

  constructor(options: QuestionSchedulerOptions) {
    this.graph = options.graph;
    this.candidates = options.candidates;
    this.policy = options.policy;
    this.planner = options.planner;
    this.config = options.config;
  }

  refreshConfig(config: AssistantConfig): void {
    this.config = config;
  }

  async planPending(ownerId: string, abortSignal: AbortSignal): Promise<PlanQuestionsSummary> {
    const expired = this.graph.questions.expireDue(ownerId);
    const approved = this.candidates.list(ownerId)
      .filter((candidate) => this.graph.questions.findLiveByTopic(ownerId, candidate.topicKey) === null)
      .map((candidate) => ({ candidate, decision: this.policy.evaluate(candidate, this.config) }))
      .filter((entry): entry is ApprovedCandidate => entry.decision.kind !== 'ineligible')
      .sort((left, right) => (
        right.decision.score - left.decision.score
        || left.candidate.topicKey.localeCompare(right.candidate.topicKey)
      ))
      .slice(0, this.config.Questions.MaxPerDay);

    let planned = 0;
    let eligible = 0;
    let pendingOnly = 0;
    for (const entry of approved) {
      if (abortSignal.aborted) throw new Error('Question scheduling aborted.');
      const proposal = await this.planner.plan(entry.candidate, abortSignal);
      const transaction = this.graph.transactions.begin();
      try {
        const row = this.graph.questions.create({
          ownerId,
          topicKey: entry.candidate.topicKey,
          questionText: proposal.questionText,
          questionType: entry.candidate.questionType,
          candidateIds: entry.candidate.candidateIds,
          expectedValue: entry.decision.score,
          interruptionCost: entry.candidate.interruptionCost,
          eligibleAfterUtc: null,
          expiresAtUtc: new Date(
            Date.parse(this.graph.nowUtc())
              + this.config.Questions.UnansweredExpiryDays * 86_400_000,
          ).toISOString(),
        });
        if (entry.decision.kind === 'eligible') {
          this.graph.questions.markEligible(row.id, this.graph.nowUtc());
          eligible += 1;
        } else {
          pendingOnly += 1;
        }
        transaction.commit();
        planned += 1;
      } catch (error) {
        transaction.rollbackAfter(error);
      }
    }
    return { planned, eligible, pendingOnly, expired };
  }

  current(ownerId: string): QuestionRow | null {
    return this.graph.questions.listPending(ownerId)
      .find((row) => row.status === 'eligible' || row.status === 'shown') ?? null;
  }
}
