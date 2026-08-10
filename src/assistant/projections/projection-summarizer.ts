import { z } from '../../lib/zod.js';
import { SensitivitySchema } from '../domain/enums.js';
import type { TokenCounter } from '../domain/tokens.js';
import type { StructuredOutputRunner } from '../inference/structured-runner.js';

const ProjectionSummaryOutputSchema = z.object({
  sentences: z.array(z.object({
    text: z.string().trim().min(1),
    assertionIds: z.array(z.string()).min(1),
  }).strict()).min(1),
}).strict();

export const SummarizeProjectionInputSchema = z.object({
  body: z.string(),
  assertions: z.array(z.object({
    assertionId: z.string(),
    sensitivity: SensitivitySchema,
  }).strict()),
  targetTokens: z.number().int().positive(),
}).strict();
export type SummarizeProjectionInput = z.infer<typeof SummarizeProjectionInputSchema>;

export const SummarizeProjectionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('summarized'),
    body: z.string(),
    assertionIds: z.array(z.string()),
  }).strict(),
  z.object({ kind: z.literal('unchanged'), reason: z.string() }).strict(),
]);
export type SummarizeProjectionResult = z.infer<typeof SummarizeProjectionResultSchema>;

export interface ProjectionSummaryService {
  summarize(
    input: SummarizeProjectionInput,
    abortSignal: AbortSignal,
  ): Promise<SummarizeProjectionResult>;
}

const INSTRUCTIONS = [
  'Compress the supplied deterministic projection without adding facts.',
  'Each output sentence must cite every assertion that supports it.',
  'Use only assertion IDs in supportedAssertionIds. Return JSON only.',
].join('\n');

const CITATION_PATTERN = /\[M:([^\]]+)\]/gu;

export class ProjectionSummarizer implements ProjectionSummaryService {
  constructor(
    private readonly structuredOutput: StructuredOutputRunner,
    private readonly tokens: TokenCounter,
  ) {}

  async summarize(
    rawInput: SummarizeProjectionInput,
    abortSignal: AbortSignal,
  ): Promise<SummarizeProjectionResult> {
    const input = SummarizeProjectionInputSchema.parse(rawInput);
    if (abortSignal.aborted) {
      return { kind: 'unchanged', reason: 'aborted' };
    }

    const allowedIds = new Set(
      input.assertions
        .filter((assertion) => assertion.sensitivity === 'low' || assertion.sensitivity === 'personal')
        .map((assertion) => assertion.assertionId),
    );
    const safeBody = input.body
      .split('\n')
      .filter((line) => {
        const citedIds = [...line.matchAll(CITATION_PATTERN)].map((match) => match[1] ?? '');
        return citedIds.every((id) => allowedIds.has(id));
      })
      .join('\n');

    try {
      const outcome = await this.structuredOutput.run({
        role: 'projection_summarizer',
        instructions: INSTRUCTIONS,
        userText: JSON.stringify({ body: safeBody, supportedAssertionIds: [...allowedIds].sort() }),
        schemaName: 'assistant_projection_summary',
        schema: ProjectionSummaryOutputSchema,
        abortSignal,
      });
      if (!outcome.ok) {
        return { kind: 'unchanged', reason: outcome.code };
      }

      const assertionIds: string[] = [];
      const lines: string[] = [];
      for (const sentence of outcome.value.sentences) {
        if (!this.isSingleSentence(sentence.text)) {
          return { kind: 'unchanged', reason: 'uncited_sentence' };
        }
        if (sentence.assertionIds.some((id) => !allowedIds.has(id))) {
          return { kind: 'unchanged', reason: 'unknown_assertion_citation' };
        }
        const uniqueIds = [...new Set(sentence.assertionIds)];
        for (const id of uniqueIds) {
          if (!assertionIds.includes(id)) assertionIds.push(id);
        }
        lines.push(`- ${sentence.text} ${uniqueIds.map((id) => `[M:${id}]`).join(' ')}`);
      }

      const body = lines.join('\n');
      if ((await this.tokens.count(body)).tokenCount > input.targetTokens) {
        return { kind: 'unchanged', reason: 'token_overflow' };
      }
      return { kind: 'summarized', body, assertionIds };
    } catch (error) {
      return {
        kind: 'unchanged',
        reason: abortSignal.aborted
          ? 'aborted'
          : `inference_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private isSingleSentence(text: string): boolean {
    if (text.includes('\n')) return false;
    return [...text.matchAll(/[.!?](?=\s|$)/gu)].length <= 1;
  }
}
