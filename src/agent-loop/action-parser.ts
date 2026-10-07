import type { NormalizedInferenceChatResponse } from '../llm-protocol/types.ts';
import { parseNativePlannerActions } from '../planner-protocol/native-actions.ts';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.ts';
import type { AgentLoopAction } from './types.ts';

type SummaryPlannerParseOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
};

export class AgentLoopActionParser {
  parseRepoSearchActions(
    response: NormalizedInferenceChatResponse,
    toolDefinitions: readonly PlannerToolDefinition[],
  ): AgentLoopAction[] {
    return parseNativePlannerActions(response, {
      toolDefinitions,
      contentWithoutTools: 'finish',
    });
  }

  parseSummaryPlannerActions(
    response: NormalizedInferenceChatResponse,
    options: SummaryPlannerParseOptions,
  ): AgentLoopAction[] {
    return parseNativePlannerActions(response, {
      toolDefinitions: options.toolDefinitions,
      contentWithoutTools: 'invalid',
    });
  }
}
