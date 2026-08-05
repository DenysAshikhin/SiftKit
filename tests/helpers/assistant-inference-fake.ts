import type {
  AssistantInferenceClient, AssistantInferenceRequest, AssistantInferenceResult,
} from '../../src/assistant/inference/client.js';

/**
 * Fixture-driven inference (§19.3). Responses are consumed in order; running out is a test bug,
 * so it throws loudly rather than inventing an empty answer.
 */
export class FakeAssistantInference implements AssistantInferenceClient {
  readonly requests: AssistantInferenceRequest[] = [];
  private readonly remaining: string[];

  constructor(responses: readonly string[]) {
    this.remaining = [...responses];
  }

  async complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult> {
    this.requests.push(request);
    const next = this.remaining.shift();
    if (next === undefined) {
      throw new Error(
        `FakeAssistantInference ran out of responses on request ${this.requests.length}.`,
      );
    }
    return { text: next, backendId: 'fake', modelId: 'fake-model' };
  }
}