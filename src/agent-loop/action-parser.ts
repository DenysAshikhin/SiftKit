import { ModelJson } from '../lib/model-json.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../repo-search/planner-protocol.js';
import { buildPlannerToolDefinitions } from '../summary/planner/tools.js';
import type { AgentLoopAction } from './types.js';

export class AgentLoopActionParser {
  parseRepoSearchAction(text: string, allowedToolNames: readonly string[]): AgentLoopAction {
    return this.parseRepoSearchActions(text, allowedToolNames)[0];
  }

  parseRepoSearchActions(text: string, allowedToolNames: readonly string[]): AgentLoopAction[] {
    const parsed = ModelJson.parseRepoSearchPlannerAction(text, {
      toolDefinitions: resolveRepoSearchPlannerToolDefinitions(allowedToolNames),
    });
    if (parsed.action === 'finish') {
      return [
        {
          kind: 'finish',
          text: parsed.output,
          rawAction: { action: 'finish', output: parsed.output },
        },
      ];
    }
    if (parsed.action === 'tool_batch') {
      return parsed.tool_calls.map((toolCall, index) => ({
        kind: 'tool',
        callId: `call_${index + 1}`,
        toolName: toolCall.tool_name,
        args: toolCall.args,
      }));
    }
    return [
      {
        kind: 'tool',
        callId: 'call_1',
        toolName: parsed.tool_name,
        args: parsed.args,
      },
    ];
  }

  parseSummaryPlannerAction(text: string): AgentLoopAction {
    return this.parseSummaryPlannerActions(text)[0];
  }

  parseSummaryPlannerActions(text: string): AgentLoopAction[] {
    const parsed = ModelJson.parseSummaryPlannerAction(text, {
      toolDefinitions: buildPlannerToolDefinitions(),
    });
    if (parsed.action === 'finish') {
      return [
        {
          kind: 'finish',
          text: parsed.output,
          classification: parsed.classification,
          rawReviewRequired: parsed.rawReviewRequired,
          rawAction: {
            action: 'finish',
            classification: parsed.classification,
            rawReviewRequired: parsed.rawReviewRequired,
            output: parsed.output,
          },
        },
      ];
    }
    if (parsed.action === 'tool_batch') {
      return parsed.tool_calls.map((toolCall, index) => ({
        kind: 'tool',
        callId: `call_${index + 1}`,
        toolName: toolCall.tool_name,
        args: toolCall.args,
      }));
    }
    return [
      {
        kind: 'tool',
        callId: 'call_1',
        toolName: parsed.tool_name,
        args: parsed.args,
      },
    ];
  }
}
