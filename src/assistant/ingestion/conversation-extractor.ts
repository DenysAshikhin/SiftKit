import { z } from '../../lib/zod.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { AssertionBasis, ObservationType } from '../domain/enums.js';
import { buildProposedStatementSchema } from '../domain/proposal-schema.js';
import type { StructuredOutputRunner } from '../inference/structured-runner.js';

const StatementKindSchema = z.enum([
  'direct_fact', 'correction', 'hypothetical', 'quotation', 'request', 'third_party_fact',
]);
type StatementKind = z.infer<typeof StatementKindSchema>;

const ExtractedStatementSchema = buildProposedStatementSchema({
  statementKind: StatementKindSchema,
  validFromUtc: z.string().nullable(),
  validToUtc: z.string().nullable(),
});

export const ConversationExtractionSchema = z.object({
  statements: z.array(ExtractedStatementSchema).max(20),
}).strict();

const EXTRACTOR_INSTRUCTIONS = [
  'Read the user or assistant message below and describe the durable facts it states about',
  'the user. For each statement, classify it:',
  '- direct_fact: the user stated something about themselves in the present.',
  '- correction: the user corrected an earlier statement ("no, I meant ...").',
  '- hypothetical: a question, a supposition, or a possibility, not a fact.',
  '- quotation: text the user quoted from somewhere else.',
  '- request: an instruction to you, not a fact.',
  '- third_party_fact: a fact about somebody other than the user.',
  'Each predicate accepts only the subject and object types shown in its schema variant.',
  'Omit anything ambiguous. Leave scope null unless the fact holds only in a named context.',
  'Never propose credentials, protected traits, or a medical diagnosis.',
  'Output JSON only.',
].join('\n');

const OBSERVATION_TYPE_BY_KIND = {
  direct_fact: 'conversation_statement',
  correction: 'conversation_correction',
  hypothetical: 'conversation_hypothetical',
  quotation: 'conversation_quotation',
  request: 'conversation_request',
  third_party_fact: 'conversation_third_party',
} as const satisfies Record<StatementKind, ObservationType>;

/** Only these two kinds may ever become a candidate (§7.2). */
const CANDIDATE_KINDS: readonly StatementKind[] = ['direct_fact', 'correction'];

export interface ExtractRequest {
  readonly ownerId: string;
  readonly evidenceId: string;
  readonly abortSignal: AbortSignal | null;
}

export interface ExtractResult {
  readonly observationIds: readonly string[];
  readonly candidateIds: readonly string[];
}

/**
 * Runs `conversation_memory_extractor` over one evidence row and records what it saw. The model
 * classifies; deterministic code decides what may become a candidate.
 */
export class ConversationExtractor {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly runner: StructuredOutputRunner,
  ) {}

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    return this.extractWithBasis(request, 'explicit_user_statement');
  }

  async extractQuestionAnswer(request: ExtractRequest): Promise<ExtractResult> {
    return this.extractWithBasis(request, 'explicit_question_answer');
  }

  private async extractWithBasis(
    request: ExtractRequest,
    basis: AssertionBasis,
  ): Promise<ExtractResult> {
    const evidence = this.graph.evidence.requireEvidence(request.evidenceId);
    const visibleText = this.stripUntrustedSpans(this.graph.evidence.readTextContent(evidence));
    if (visibleText.trim().length === 0) {
      return { observationIds: [], candidateIds: [] };
    }

    const outcome = await this.runner.run({
      role: 'conversation_memory_extractor',
      instructions: EXTRACTOR_INSTRUCTIONS,
      userText: visibleText,
      schemaName: 'assistant_conversation_statements',
      schema: ConversationExtractionSchema,
      abortSignal: request.abortSignal,
    });

    if (!outcome.ok) {
      this.graph.audit.recordAuditEvent({
        ownerId: request.ownerId,
        eventType: 'extraction_rejected',
        targetType: 'evidence',
        targetId: request.evidenceId,
        summary: 'Conversation extraction produced no usable structured output.',
        details: { code: outcome.code, attempts: outcome.attempts, rawSample: outcome.rawSample },
      });
      return { observationIds: [], candidateIds: [] };
    }

    const observationIds: string[] = [];
    const candidateIds: string[] = [];

    const transaction = this.graph.transactions.begin();
    try {
      for (const statement of outcome.value.statements) {
        const observation = this.graph.observations.record({
          ownerId: request.ownerId,
          evidenceId: request.evidenceId,
          observationType: OBSERVATION_TYPE_BY_KIND[statement.statementKind],
          payload: { rationale: statement.rationale, predicate: statement.predicate },
          confidence: statement.suggestedConfidence,
          sensitivity: evidence.sensitivity,
          extractorName: 'conversation_memory_extractor',
          extractorVersion: outcome.promptVersion,
        });
        observationIds.push(observation.id);

        if (!CANDIDATE_KINDS.includes(statement.statementKind)) {
          continue;
        }
        const candidate = this.graph.candidates.propose({
          ownerId: request.ownerId,
          observationId: observation.id,
          subject: statement.subject,
          predicate: statement.predicate,
          object: statement.object,
          scope: statement.scope,
          basis,
          confidence: statement.suggestedConfidence,
          sensitivity: evidence.sensitivity,
          validFromUtc: statement.validFromUtc,
          validToUtc: statement.validToUtc,
          rationale: statement.rationale,
        });
        if (candidate !== null) {
          candidateIds.push(candidate.id);
        }
      }
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }

    return { observationIds, candidateIds };
  }

  /**
   * Fenced code blocks and blockquote lines are somebody else's words (§7.2) and are never shown
   * to the extractor, so a pasted log cannot become a fact about the user — nor can it carry a
   * prompt-injection payload into the extraction call.
   */
  private stripUntrustedSpans(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*>.*$/gm, ' ')
      .trim();
  }
}
