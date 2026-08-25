import type { JsonObject, JsonValue, LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';

export type AgentLoopKind = 'repo-search' | 'chat' | 'summary-planner';

export type AgentLoopFinishAction = {
  kind: 'finish';
  text: string;
  classification?: string;
  rawReviewRequired?: boolean;
  rawAction?: JsonObject;
};

export type AgentLoopToolAction = {
  kind: 'tool';
  callId: string;
  toolName: string;
  args: JsonObject;
};

export type AgentLoopAction = AgentLoopFinishAction | AgentLoopToolAction;

export type AgentLoopToolResult = {
  callId: string;
  toolName: string;
  args: JsonObject;
  text: string;
  raw: JsonValue;
};

export type AgentLoopModelData = {
  readonly kind: string;
};

export type AgentLoopModelContinueResponse = {
  outcome: 'continue';
  response: NormalizedLlamaCppChatResponse;
  data: AgentLoopModelData | null;
};

export type AgentLoopModelStopResponse = {
  outcome: 'stop';
  data: AgentLoopModelData | null;
};

export type AgentLoopModelResponse = AgentLoopModelContinueResponse | AgentLoopModelStopResponse;

export type AgentLoopTurn = {
  turnNumber: number;
  response: NormalizedLlamaCppChatResponse;
  actions: AgentLoopAction[];
  toolResults: AgentLoopToolResult[];
};

export type AgentLoopResult = {
  finishText: string;
  turns: AgentLoopTurn[];
  reason: 'finished' | 'max_turns' | 'aborted';
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
};

export type AgentLoopTurnOutcome = 'continue' | 'stop';

/**
 * A turn's prompt measured two ways, kept apart because conflating them either inflates
 * every reported figure or under-budgets the request.
 */
export type TurnPromptTokens = {
  /** Tokens that actually occupy the model's context. Reported, displayed and persisted. */
  reported: number;
  /** The reported count plus the provider request-envelope reserve: the size budget decisions must fit. */
  budgeted: number;
};

export type AgentLoopPreparedTurn = {
  outcome: AgentLoopTurnOutcome;
  turnNumber: number;
  promptTokens: TurnPromptTokens;
  maxOutputTokens: number;
  messages: LlamaCppChatMessage[];
  toolDefinitions: LlamaCppToolDefinition[];
  inForcedFinishMode: boolean;
};

export type AgentLoopTurnContext = {
  turnNumber: number;
  preparedTurn: AgentLoopPreparedTurn;
};

export type AgentLoopResponseContext = AgentLoopTurnContext & {
  response: NormalizedLlamaCppChatResponse;
  modelData: AgentLoopModelData | null;
  turns: readonly AgentLoopTurn[];
};

export type AgentLoopFinishEvaluation = {
  accepted: boolean;
  outcome: AgentLoopTurnOutcome;
  finishText?: string;
};

export type AgentLoopInvalidResponseResult = {
  outcome: AgentLoopTurnOutcome;
};

export type AgentLoopToolExecution = {
  outcome: AgentLoopTurnOutcome;
  results: AgentLoopToolResult[];
};

export interface AgentLoopPromptAdapter {
  readonly kind: AgentLoopKind;
  prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn>;
}

export interface AgentLoopActionAdapter {
  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[];
  inspectResponse(context: AgentLoopResponseContext): AgentLoopTurnOutcome | null;
  handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult>;
  evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation>;
}

export interface AgentLoopToolAdapter {
  executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution>;
}
