import { AgentLoopActionParser } from '../agent-loop/action-parser.ts';
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
} from '../agent-loop/types.ts';
import type { AgentLoopModelClient } from '../agent-loop/agent-loop.ts';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.ts';

export interface RepoSearchLoopController {
  prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn>;
  requestModelResponse(context: AgentLoopResponseContext['preparedTurn']): Promise<AgentLoopModelResponse>;
  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null;
  validateActions(actions: AgentLoopAction[], turnNumber: number): AgentLoopAction[];
  handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult>;
  evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation>;
  executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution>;
}

export interface RepoSearchResultSource<TResult> {
  buildAgentLoopResult(): Promise<TResult>;
}

export class RepoSearchPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'repo-search' as const;

  private readonly controller: RepoSearchLoopController;

  constructor(controller: RepoSearchLoopController) {
    this.controller = controller;
  }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    return this.controller.prepareTurn(turnNumber);
  }
}

export class RepoSearchActionAdapter implements AgentLoopActionAdapter {
  private readonly parser = new AgentLoopActionParser();

  private readonly toolDefinitions: readonly PlannerToolDefinition[];
  private readonly controller: RepoSearchLoopController;

  constructor(
    toolDefinitions: readonly PlannerToolDefinition[],
    controller: RepoSearchLoopController,
  ) {
    this.toolDefinitions = toolDefinitions;
    this.controller = controller;
  }

  parseActions(context: AgentLoopResponseContext): AgentLoopAction[] {
    return this.controller.validateActions(
      this.parser.parseRepoSearchActions(context.response, this.toolDefinitions),
      context.turnNumber,
    );
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

export class RepoSearchToolAdapter implements AgentLoopToolAdapter {
  private readonly controller: RepoSearchLoopController;

  constructor(controller: RepoSearchLoopController) {
    this.controller = controller;
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    return this.controller.executeTools(actions, context);
  }
}

export class RepoSearchResultAssembler<TResult> {
  private readonly source: RepoSearchResultSource<TResult>;

  constructor(source: RepoSearchResultSource<TResult>) {
    this.source = source;
  }

  async assemble(): Promise<TResult> {
    return this.source.buildAgentLoopResult();
  }
}

export class RepoSearchPlannerModelClient implements AgentLoopModelClient {
  private readonly controller: RepoSearchLoopController;

  constructor(controller: RepoSearchLoopController) {
    this.controller = controller;
  }

  async chat(options: Parameters<AgentLoopModelClient['chat']>[0]): Promise<AgentLoopModelResponse> {
    return this.controller.requestModelResponse(options.preparedTurn);
  }
}
