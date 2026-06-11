import { AgentLoopActionParser } from '../../agent-loop/action-parser.js';
import type {
  AgentLoopAction,
  AgentLoopActionAdapter,
  AgentLoopFinishAction,
  AgentLoopFinishEvaluation,
  AgentLoopInvalidResponseResult,
  AgentLoopModelResponse,
  AgentLoopPreparedTurn,
  AgentLoopPromptAdapter,
  AgentLoopResponseContext,
  AgentLoopToolAdapter,
  AgentLoopToolAction,
  AgentLoopToolExecution,
} from '../../agent-loop/types.js';
import type { AgentLoopModelClient } from '../../agent-loop/agent-loop.js';
import type { NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';

export interface SummaryPlannerLoopController {
  prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn>;
  requestModelResponse(preparedTurn: AgentLoopPreparedTurn): Promise<AgentLoopModelResponse>;
  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null;
  handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult>;
  evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation>;
  executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution>;
}

export class SummaryPlannerPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'summary-planner' as const;

  constructor(private readonly controller: SummaryPlannerLoopController) {}

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    return this.controller.prepareTurn(turnNumber);
  }
}

export class SummaryPlannerActionAdapter implements AgentLoopActionAdapter {
  private readonly parser = new AgentLoopActionParser();

  constructor(private readonly controller: SummaryPlannerLoopController) {}

  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[] {
    return this.parser.parseSummaryPlannerActions(response.text);
  }

  inspectResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null {
    return this.controller.inspectModelResponse(context);
  }

  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    return this.controller.handleInvalidResponse(context);
  }

  async evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation> {
    return this.controller.evaluateFinish(action, context);
  }
}

export class SummaryPlannerToolAdapter implements AgentLoopToolAdapter {
  constructor(private readonly controller: SummaryPlannerLoopController) {}

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    return this.controller.executeTools(actions, context);
  }
}

export class SummaryPlannerResultAssembler {
  constructor(private readonly decision: StructuredModelDecision | null) {}

  assemble(): StructuredModelDecision | null {
    return this.decision;
  }
}

type StructuredModelDecision = import('../types.js').StructuredModelDecision;

export class SummaryPlannerModelClient implements AgentLoopModelClient {
  constructor(private readonly controller: SummaryPlannerLoopController) {}

  async chat(options: Parameters<AgentLoopModelClient['chat']>[0]): Promise<AgentLoopModelResponse> {
    return this.controller.requestModelResponse(options.preparedTurn);
  }
}
