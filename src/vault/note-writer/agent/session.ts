import type { ImageDataUrl } from '@siftkit/contracts';

import { AgentLoop, type AgentLoopModelClient } from '../../../agent-loop/agent-loop.ts';
import type {
  AgentLoopAction, AgentLoopActionAdapter, AgentLoopFinishAction, AgentLoopFinishEvaluation, AgentLoopInvalidResponseResult, AgentLoopKind,
  AgentLoopModelResponse, AgentLoopPreparedTurn, AgentLoopPromptAdapter, AgentLoopResponseContext, AgentLoopToolAction, AgentLoopToolAdapter,
  AgentLoopToolExecution, AgentLoopTurnOutcome,
} from '../../../agent-loop/types.ts';
import type { AssistantInferenceClient } from '../../../assistant/inference/client.ts';
import type { InferenceChatMessage, InferenceToolDefinition } from '../../../llm-protocol/types.ts';
import type { PlannerToolDefinition } from '../../../planner-protocol/json-schema.ts';
import { NativePlannerToolCallError, parseNativePlannerActions } from '../../../planner-protocol/native-actions.ts';
import { VaultEditResponseSchema, type VaultEditOp } from '../edit-ops.ts';
import { SUBMIT_EDITS_TOOL, VAULT_WRITER_TOOLS, toInferenceTool } from './definitions.ts';
import type { VaultWriterTools } from './tools.ts';

export const VAULT_WRITER_MAX_TURNS = 80;
const FORCE_AT_CONTEXT_FRACTION = 0.75;
const CHARS_PER_TOKEN = 4;
const MAX_OUTPUT_TOKENS = 4_096;
const RAW_SAMPLE_LIMIT = 500;
export const BUDGET_SPENT_NOTICE = 'Turn budget spent: submit your edits now.';
const NO_TOOL_REMINDER = 'Reply with a tool call: explore with the read-only tools, or finish with submit_edits.';

export interface VaultWriterSessionInput {
  readonly systemPrompt: string;
  readonly seedText: string;
  readonly images: readonly ImageDataUrl[];
  readonly tools: VaultWriterTools;
  readonly inference: AssistantInferenceClient;
  readonly abortSignal: AbortSignal;
}

export interface VaultWriterTrace {
  readonly turns: number;
  readonly toolCalls: readonly string[];
}

export type VaultWriterSessionOutcome =
  | { readonly kind: 'submitted'; readonly operations: readonly VaultEditOp[]; readonly trace: VaultWriterTrace }
  | { readonly kind: 'invalid_output'; readonly rawSample: string; readonly trace: VaultWriterTrace }
  | { readonly kind: 'aborted' };

/** One agent run. The four AgentLoop adapters share its message history, so one object is all four. */
export class VaultWriterSession implements AgentLoopPromptAdapter, AgentLoopActionAdapter, AgentLoopToolAdapter, AgentLoopModelClient {
  readonly kind: AgentLoopKind = 'vault-writer';
  private readonly input: VaultWriterSessionInput;
  private readonly messages: InferenceChatMessage[];
  private readonly toolCalls: string[] = [];
  private promptEstimate = 0;
  private forced = false;
  private reminded = false;
  private submitted: readonly VaultEditOp[] | null = null;
  private rawSample = '';

  constructor(input: VaultWriterSessionInput) {
    this.input = input;
    this.messages = [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.seedText }];
  }

  async run(): Promise<VaultWriterSessionOutcome> {
    const result = await new AgentLoop({
      maxTurns: VAULT_WRITER_MAX_TURNS, promptAdapter: this, actionAdapter: this, toolAdapter: this, modelClient: this,
    }).run();
    const trace = { turns: result.turns.length, toolCalls: [...this.toolCalls] };
    // A finished submission is kept even when the abort landed after it; the work is already done.
    if (this.submitted !== null) return { kind: 'submitted', operations: this.submitted, trace };
    return this.input.abortSignal.aborted ? { kind: 'aborted' } : { kind: 'invalid_output', rawSample: this.rawSample, trace };
  }

  private definitions(): readonly PlannerToolDefinition[] {
    return this.forced ? [SUBMIT_EDITS_TOOL] : VAULT_WRITER_TOOLS;
  }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    const forced = turnNumber >= VAULT_WRITER_MAX_TURNS || this.promptEstimate >= FORCE_AT_CONTEXT_FRACTION * this.input.inference.contextTokens();
    if (forced && !this.forced) {
      this.forced = true;
      this.messages.push({ role: 'user', content: BUDGET_SPENT_NOTICE });
    }
    return {
      outcome: this.input.abortSignal.aborted ? 'stop' : 'continue',
      turnNumber,
      promptTokenCount: this.promptEstimate,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      messages: [...this.messages],
      toolDefinitions: this.definitions().map(toInferenceTool),
      inForcedFinishMode: this.forced,
    };
  }

  async chat(options: {
    turnNumber: number; preparedTurn: AgentLoopPreparedTurn; messages: InferenceChatMessage[]; tools: InferenceToolDefinition[]; allowedToolNames: string[];
  }): Promise<AgentLoopModelResponse> {
    try {
      const response = await this.input.inference.chat({
        messages: options.messages, images: this.input.images, tools: options.tools, abortSignal: this.input.abortSignal,
      });
      this.promptEstimate = (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0);
      return { outcome: 'continue', response, data: null };
    } catch (error) {
      if (this.input.abortSignal.aborted) return { outcome: 'stop', data: null };
      throw error;
    }
  }

  inspectResponse(): AgentLoopTurnOutcome | null {
    return null;
  }

  parseActions(context: AgentLoopResponseContext): AgentLoopAction[] {
    return parseNativePlannerActions(context.response, { toolDefinitions: this.definitions(), contentWithoutTools: 'invalid' });
  }

  /** A bad tool call is answered as a tool error; no tool call gets one reminder; a forced turn must submit. */
  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    const { error, response } = context;
    if (error instanceof NativePlannerToolCallError && !this.forced) {
      this.messages.push({
        role: 'assistant', content: response.narrationText || null,
        tool_calls: [{ id: error.callId, type: 'function', function: { name: error.toolName, arguments: JSON.stringify(error.args) } }],
      });
      this.messages.push({ role: 'tool', tool_call_id: error.callId, content: `Error: ${error.message}` });
      return { outcome: 'continue' };
    }
    if (this.forced || this.reminded) {
      this.rawSample = response.rawText.slice(0, RAW_SAMPLE_LIMIT);
      return { outcome: 'stop' };
    }
    this.reminded = true;
    this.messages.push({ role: 'assistant', content: response.rawText }, { role: 'user', content: NO_TOOL_REMINDER });
    return { outcome: 'continue' };
  }

  async evaluateFinish(action: AgentLoopFinishAction): Promise<AgentLoopFinishEvaluation> {
    this.submitted = VaultEditResponseSchema.parse(action.rawAction).operations;
    this.toolCalls.push('submit_edits');
    return { accepted: true, outcome: 'stop' };
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    this.messages.push({
      role: 'assistant', content: context.response.narrationText || null,
      tool_calls: actions.map((action) => ({ id: action.callId, type: 'function', function: { name: action.toolName, arguments: JSON.stringify(action.args) } })),
    });
    const results = actions.map((action) => {
      const text = this.input.tools.execute(action.toolName, action.args);
      this.toolCalls.push(action.toolName);
      this.messages.push({ role: 'tool', tool_call_id: action.callId, content: text });
      this.promptEstimate += Math.ceil(text.length / CHARS_PER_TOKEN);
      return { callId: action.callId, toolName: action.toolName, args: action.args, text, raw: text };
    });
    return { outcome: 'continue', results };
  }
}
