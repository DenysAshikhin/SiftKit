import type { AssistantAgentTurnRequest, AssistantInferenceClient } from '../../src/assistant/inference/client.ts';
import type { JsonObject } from '../../src/lib/json-types.ts';
import { emptyInferenceThroughput } from '../../src/lib/inference-throughput.ts';
import { CLEAN_STREAM_STOP, type NormalizedInferenceChatResponse } from '../../src/llm-protocol/types.ts';

export type FakeAgentTurn =
  | { readonly kind: 'tools'; readonly calls: readonly { readonly name: string; readonly args: JsonObject }[] }
  | { readonly kind: 'text'; readonly text: string };

export const toolTurn = (name: string, args: JsonObject): FakeAgentTurn => ({ kind: 'tools', calls: [{ name, args }] });
export const submitTurn = (operations: readonly JsonObject[]): FakeAgentTurn => toolTurn('submit_edits', { operations: [...operations] });
export const textTurn = (text: string): FakeAgentTurn => ({ kind: 'text', text });

export interface ScriptedAgentInferenceOptions {
  readonly contextTokens?: number;
  /** Prompt tokens reported per request, growing with each turn. */
  readonly promptTokensPerTurn?: number;
}

/** Replays scripted agent turns in order; running out is a test bug and throws. */
export class ScriptedAgentInference implements AssistantInferenceClient {
  readonly requests: AssistantAgentTurnRequest[] = [];
  /** Aborts the controller when the given request number arrives, to simulate preemption mid-call. */
  abortOnTurn: { readonly turn: number; readonly controller: AbortController } | null = null;
  private readonly remaining: FakeAgentTurn[];
  private readonly window: number;
  private readonly promptTokensPerTurn: number;

  constructor(turns: readonly FakeAgentTurn[], options: ScriptedAgentInferenceOptions = {}) {
    this.remaining = [...turns];
    this.window = options.contextTokens ?? 100_000;
    this.promptTokensPerTurn = options.promptTokensPerTurn ?? 1_000;
  }

  contextTokens(): number {
    return this.window;
  }

  async chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse> {
    this.requests.push(request);
    if (this.abortOnTurn?.turn === this.requests.length) {
      this.abortOnTurn.controller.abort();
      throw new Error('aborted mid-request');
    }
    const next = this.remaining.shift();
    if (next === undefined) throw new Error(`ScriptedAgentInference ran out of turns on request ${this.requests.length}.`);
    const text = next.kind === 'text' ? next.text : '';
    return {
      text, rawText: text, narrationText: text, classification: 'narration', reasoningText: '',
      toolCalls: next.kind === 'tools'
        ? next.calls.map((call, index) => ({ id: `call_${this.requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
        : [],
      usage: {
        throughput: emptyInferenceThroughput(), promptTokens: this.promptTokensPerTurn * this.requests.length, completionTokens: 50,
        totalTokens: null, outputTokens: 50, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: null,
      },
      raw: {}, stop: CLEAN_STREAM_STOP,
    };
  }
}
