import { AgentLoopActionParser } from '../agent-loop/action-parser.js';
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
} from '../agent-loop/types.js';
import type { AgentLoopModelClient } from '../agent-loop/agent-loop.js';
import type { NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';

export interface RepoSearchLoopController {
  prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn>;
  requestModelResponse(context: AgentLoopResponseContext['preparedTurn']): Promise<AgentLoopModelResponse>;
  inspectModelResponse(context: AgentLoopResponseContext): 'continue' | 'stop' | null;
  handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult>;
  evaluateFinish(action: AgentLoopFinishAction, context: AgentLoopResponseContext): Promise<AgentLoopFinishEvaluation>;
  executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution>;
}

export interface RepoSearchResultSource<TResult> {
  buildAgentLoopResult(): Promise<TResult>;
}

export class RepoSearchPromptAdapter implements AgentLoopPromptAdapter {
  readonly kind = 'repo-search' as const;

  constructor(private readonly controller: RepoSearchLoopController) {}

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    return this.controller.prepareTurn(turnNumber);
  }
}

export class RepoSearchActionAdapter implements AgentLoopActionAdapter {
  private readonly parser = new AgentLoopActionParser();

  constructor(
    private readonly allowedToolNames: readonly string[],
    private readonly controller: RepoSearchLoopController,
  ) {}

  parseActions(response: NormalizedLlamaCppChatResponse): AgentLoopAction[] {
    return this.parser.parseRepoSearchActions(response.text, this.allowedToolNames);
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
  constructor(private readonly controller: RepoSearchLoopController) {}

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    return this.controller.executeTools(actions, context);
  }
}

export class RepoSearchResultAssembler<TResult> {
  constructor(private readonly source: RepoSearchResultSource<TResult>) {}

  async assemble(): Promise<TResult> {
    return this.source.buildAgentLoopResult();
  }
}

export class RepoSearchPlannerModelClient implements AgentLoopModelClient {
  constructor(private readonly controller: RepoSearchLoopController) {}

  async chat(options: Parameters<AgentLoopModelClient['chat']>[0]): Promise<AgentLoopModelResponse> {
    return this.controller.requestModelResponse(options.preparedTurn);
  }
}
