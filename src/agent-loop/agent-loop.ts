import type { LlamaCppChatMessage, LlamaCppToolDefinition, NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';
import type {
  AgentLoopAction,
  AgentLoopActionAdapter,
  AgentLoopModelResponse,
  AgentLoopPreparedTurn,
  AgentLoopPromptAdapter,
  AgentLoopResult,
  AgentLoopToolAdapter,
  AgentLoopTurn,
} from './types.js';

export interface AgentLoopModelClient {
  chat(options: {
    turnNumber: number;
    preparedTurn: AgentLoopPreparedTurn;
    messages: LlamaCppChatMessage[];
    tools: LlamaCppToolDefinition[];
    allowedToolNames: string[];
    stream: boolean;
  }): Promise<AgentLoopModelResponse>;
}

export type AgentLoopOptions = {
  maxTurns: number;
  stream?: boolean;
  promptAdapter?: AgentLoopPromptAdapter;
  actionAdapter?: AgentLoopActionAdapter;
  toolAdapter?: AgentLoopToolAdapter;
  modelClient?: AgentLoopModelClient;
};

export class AgentLoop {
  private readonly turns: AgentLoopTurn[] = [];

  constructor(private readonly options: AgentLoopOptions) {}

  async run(): Promise<AgentLoopResult> {
    if (!this.options.modelClient || !this.options.actionAdapter || !this.options.toolAdapter || !this.options.promptAdapter) {
      throw new Error('AgentLoop requires prompt/action/tool/model adapters.');
    }

    for (let turnNumber = 1; turnNumber <= this.options.maxTurns; turnNumber += 1) {
      const preparedTurn = await this.options.promptAdapter.prepareTurn(turnNumber);
      if (preparedTurn.outcome === 'stop') {
        return this.buildResult('', 'aborted');
      }
      const messages = preparedTurn.messages;
      const toolDefinitions = preparedTurn.toolDefinitions;
      const modelResponse = await this.options.modelClient.chat({
        turnNumber,
        preparedTurn,
        messages,
        tools: toolDefinitions,
        allowedToolNames: toolDefinitions.map((tool) => tool.function.name),
        stream: this.options.stream === true,
      });
      if (modelResponse.outcome === 'stop') {
        return this.buildResult('', 'aborted');
      }
      const response = modelResponse.response;

      const responseContext = {
        turnNumber,
        preparedTurn,
        response,
        modelData: modelResponse.data,
        turns: this.turns as readonly AgentLoopTurn[],
      };
      const inspected = this.options.actionAdapter.inspectResponse(responseContext);
      if (inspected === 'stop') {
        return this.buildResult('', 'aborted');
      }
      if (inspected === 'continue') {
        continue;
      }

      let actions: AgentLoopAction[];
      try {
        actions = this.options.actionAdapter.parseActions(response);
      } catch (error) {
        const invalidResult = await this.options.actionAdapter.handleInvalidResponse({
          ...responseContext,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        if (invalidResult.outcome === 'stop') {
          return this.buildResult('', 'aborted');
        }
        continue;
      }
      const turn: AgentLoopTurn = { turnNumber, response, actions, toolResults: [] };
      this.turns.push(turn);

      const toolActions = [];
      for (const action of actions) {
        if (action.kind === 'finish') {
          const evaluation = await this.options.actionAdapter.evaluateFinish(action, {
            ...responseContext,
            turns: this.turns,
          });
          if (evaluation.accepted) {
            return this.buildResult(evaluation.finishText ?? action.text, 'finished');
          }
          if (evaluation.outcome === 'stop') {
            return this.buildResult('', 'aborted');
          }
          continue;
        }
        toolActions.push(action);
      }
      if (toolActions.length === 0) {
        continue;
      }
      const toolExecution = await this.options.toolAdapter.executeTools(toolActions, {
        ...responseContext,
        turns: this.turns,
      });
      for (const toolResult of toolExecution.results) {
        turn.toolResults.push(toolResult);
      }
      if (toolExecution.outcome === 'stop') {
        return this.buildResult('', 'aborted');
      }
    }

    return this.buildResult('', 'max_turns');
  }

  private buildResult(finishText: string, reason: AgentLoopResult['reason']): AgentLoopResult {
    return {
      finishText,
      turns: this.turns,
      reason,
      promptTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.promptTokens || 0), 0),
      outputTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.outputTokens || 0), 0),
      thinkingTokens: this.turns.reduce((sum, turn) => sum + Number(turn.response.usage.thinkingTokens || 0), 0),
    };
  }
}
