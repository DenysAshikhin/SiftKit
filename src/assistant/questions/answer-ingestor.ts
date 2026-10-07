import type { CandidatePromoter, PromotionOutcome } from '../ingestion/candidate-promoter.ts';
import type { ConversationExtractor } from '../ingestion/conversation-extractor.ts';

export interface QuestionAnswerIngestResult {
  readonly observationIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly promotions: readonly PromotionOutcome[];
}

export class QuestionAnswerIngestor {
  private readonly extractor: ConversationExtractor;
  private readonly promoter: CandidatePromoter;

  constructor(
    extractor: ConversationExtractor,
    promoter: CandidatePromoter,
  ) {
    this.extractor = extractor;
    this.promoter = promoter;
  }

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
