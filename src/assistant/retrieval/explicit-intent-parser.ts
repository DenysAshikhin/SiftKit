import type { StructuredOutputRunner } from '../inference/structured-runner.js';
import { MemoryQueryIntentSchema, type MemoryQueryIntent } from './query-intent.js';

const INSTRUCTIONS = [
  'Parse the search request into normalized content terms, temporal intent, and task type.',
  'Do not answer the request. Return only the requested JSON object.',
].join('\n');

export class ExplicitIntentParser {
  constructor(private readonly structuredOutput: StructuredOutputRunner) {}

  async parse(query: string, abortSignal: AbortSignal): Promise<MemoryQueryIntent> {
    const outcome = await this.structuredOutput.run({
      role: 'query_intent_parser',
      instructions: INSTRUCTIONS,
      userText: query,
      schemaName: 'assistant_query_intent',
      schema: MemoryQueryIntentSchema,
      abortSignal,
    });
    if (!outcome.ok) {
      throw new Error(`Query intent was rejected after ${outcome.attempts} attempts: ${outcome.message}`);
    }
    return outcome.value;
  }
}
