import type { NormalizedLlamaCppChatResponse } from '../llm-protocol/types.js';
import { parseNativePlannerActions } from '../planner-protocol/native-actions.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import type { AgentLoopAction } from './types.js';

type SummaryPlannerParseOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
};

export class AgentLoopActionParser {
  parseRepoSearchActions(
    response: NormalizedLlamaCppChatResponse,
    toolDefinitions: readonly PlannerToolDefinition[],
  ): AgentLoopAction[] {
    return parseNativePlannerActions(response, {
      toolDefinitions,
      contentWithoutTools: 'finish',
    });
  }

  parseSummaryPlannerActions(
    response: NormalizedLlamaCppChatResponse,
    options: SummaryPlannerParseOptions,
  ): AgentLoopAction[] {
    return parseNativePlannerActions(response, {
      toolDefinitions: options.toolDefinitions,
      contentWithoutTools: 'invalid',
    });
  }
}
