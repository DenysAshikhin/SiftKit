import { ORCHESTRATOR_RECENT_TOOL_LIMIT, type OrchestratorChildActivity, type OrchestratorToolCallActivity } from '@siftkit/contracts';

import type { OperationProgressEvent } from '../repo-search/types.ts';

/** Folds one child progress event into its live view; the same object back means nothing visible changed. */
export function reduceChildActivity(activity: OrchestratorChildActivity, event: OperationProgressEvent): OrchestratorChildActivity {
  switch (event.kind) {
    case 'lock_wait':
      return activity.waitingForModel ? activity : { ...activity, waitingForModel: true };
    case 'llm_start':
      return { ...activity, waitingForModel: false, turn: event.turn, maxTurns: event.maxTurns, promptTokens: event.promptTokenCount };
    case 'tool_start': {
      const started: OrchestratorToolCallActivity = {
        toolCallId: event.toolCallId, turn: event.turn, activityKind: event.activityKind, command: event.command, status: 'running',
      };
      return { ...activity, waitingForModel: false, tools: [...activity.tools, started].slice(-ORCHESTRATOR_RECENT_TOOL_LIMIT) };
    }
    case 'tool_result': {
      if (!activity.tools.some((tool) => tool.toolCallId === event.toolCallId)) return activity;
      const status: OrchestratorToolCallActivity['status'] = event.exitCode === 0 ? 'succeeded' : 'failed';
      return { ...activity, tools: activity.tools.map((tool) => (tool.toolCallId === event.toolCallId ? { ...tool, status } : tool)) };
    }
    default:
      return activity;
  }
}
