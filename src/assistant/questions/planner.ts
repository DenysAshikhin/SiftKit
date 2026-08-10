import { z } from '../../lib/zod.js';
import type { StructuredOutputRunner } from '../inference/structured-runner.js';
import type { QuestionCandidate } from './candidates.js';

export const QuestionProposalSchema = z.object({
  questionText: z.string().trim().min(1).max(500),
}).strict();
export type QuestionProposal = z.infer<typeof QuestionProposalSchema>;

export interface QuestionPlanningService {
  plan(candidate: QuestionCandidate, abortSignal: AbortSignal): Promise<QuestionProposal>;
}

const INSTRUCTIONS = [
  'Write one concise, respectful question for the supplied approved memory gap.',
  'Do not change its topic or purpose. Do not add claims. Return JSON only.',
].join('\n');

export class QuestionPlanner implements QuestionPlanningService {
  constructor(private readonly structuredOutput: StructuredOutputRunner) {}

  async plan(
    candidate: QuestionCandidate,
    abortSignal: AbortSignal,
  ): Promise<QuestionProposal> {
    if (abortSignal.aborted) throw new Error('Question planning aborted.');
    const outcome = await this.structuredOutput.run({
      role: 'question_planner',
      instructions: INSTRUCTIONS,
      userText: JSON.stringify({
        topicKey: candidate.topicKey,
        questionType: candidate.questionType,
        gapType: candidate.gapType,
        concreteBenefit: candidate.concreteBenefit,
        candidateIds: candidate.candidateIds,
      }),
      schemaName: 'assistant_question_proposal',
      schema: QuestionProposalSchema,
      abortSignal,
    });
    if (abortSignal.aborted) throw new Error('Question planning aborted.');
    if (!outcome.ok) {
      throw new Error(`Question planner output remained invalid: ${outcome.message}`);
    }
    return outcome.value;
  }
}
