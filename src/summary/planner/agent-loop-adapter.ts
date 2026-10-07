import { AgentLoopActionParser } from '../../agent-loop/action-parser.ts';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.ts';
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
} from '../../agent-loop/types.ts';
import type { AgentLoopModelClient } from '../../agent-loop/agent-loop.ts';

export interface SummaryPlannerLoopController {
  readonly allowUnsupportedInput: boolean;
  prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn>;
  requestModelResponse(preparedTurn: AgentLoopPreparedTurn): Promise<AgentLoopModelResponse>;
  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null;
  handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult>;
  evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation>;
  executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution>;
}

export class SummaryPlannerPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'summary-planner' as const;

  private readonly controller: SummaryPlannerLoopController;

  constructor(controller: SummaryPlannerLoopController) {
    this.controller = controller;
  }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    return this.controller.prepareTurn(turnNumber);
  }
}

export class SummaryPlannerActionAdapter implements AgentLoopActionAdapter {
  private readonly parser = new AgentLoopActionParser();

  private readonly controller: SummaryPlannerLoopController;
  private readonly toolDefinitions: readonly PlannerToolDefinition[];

  constructor(
    controller: SummaryPlannerLoopController,
    toolDefinitions: readonly PlannerToolDefinition[],
  ) {
    this.controller = controller;
    this.toolDefinitions = toolDefinitions;
  }

  parseActions(context: AgentLoopResponseContext): AgentLoopAction[] {
    return this.parser.parseSummaryPlannerActions(context.response, {
      toolDefinitions: this.toolDefinitions,
    });
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
  private readonly controller: SummaryPlannerLoopController;

  constructor(controller: SummaryPlannerLoopController) {
    this.controller = controller;
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    return this.controller.executeTools(actions, context);
  }
}

export class SummaryPlannerResultAssembler {
  private readonly decision: StructuredModelDecision | null;

  constructor(decision: StructuredModelDecision | null) {
    this.decision = decision;
  }

  assemble(): StructuredModelDecision | null {
    return this.decision;
  }
}

type StructuredModelDecision = import('../types.ts').StructuredModelDecision;

export class SummaryPlannerModelClient implements AgentLoopModelClient {
  private readonly controller: SummaryPlannerLoopController;

  constructor(controller: SummaryPlannerLoopController) {
    this.controller = controller;
  }

  async chat(options: Parameters<AgentLoopModelClient['chat']>[0]): Promise<AgentLoopModelResponse> {
    return this.controller.requestModelResponse(options.preparedTurn);
  }
}
