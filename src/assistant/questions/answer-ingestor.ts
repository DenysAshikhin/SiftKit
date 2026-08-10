import type { CandidatePromoter, PromotionOutcome } from '../ingestion/candidate-promoter.js';
import type { ConversationExtractor } from '../ingestion/conversation-extractor.js';

export interface QuestionAnswerIngestResult {
  readonly observationIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly promotions: readonly PromotionOutcome[];
}

export class QuestionAnswerIngestor {
  constructor(
    private readonly extractor: ConversationExtractor,
    private readonly promoter: CandidatePromoter,
  ) {}

  async ingest(
    ownerId: string,
    evidenceId: string,
    abortSignal: AbortSignal,
  ): Promise<QuestionAnswerIngestResult> {
    const extracted = await this.extractor.extractQuestionAnswer({
      ownerId, evidenceId, abortSignal,
    });
    if (abortSignal.aborted) throw new Error('Question answer ingestion aborted.');
    return {
      ...extracted,
      promotions: extracted.candidateIds.map((candidateId) =>
        this.promoter.promote({ ownerId, candidateId })),
    };
  }
}
