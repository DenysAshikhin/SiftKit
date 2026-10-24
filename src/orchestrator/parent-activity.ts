import { ORCHESTRATOR_RECENT_TURN_LIMIT, type OrchestratorParentActivity, type OrchestratorParentTurn } from '@siftkit/contracts';

import type { OperationProgressEvent } from '../repo-search/types.ts';

/** How much of one turn's thinking, text, and tool output the live view keeps: the latest part. */
const TURN_TEXT_TAIL_CHARS = 6_000;
const TOOL_OUTPUT_TAIL_CHARS = 3_000;

export const IDLE_PARENT_ACTIVITY: OrchestratorParentActivity = {
  waitingForModel: false, parked: false, promptTokens: 0, prompt: null, turnCount: 0, turns: [],
};

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function withTurn(activity: OrchestratorParentActivity, turn: number,
  change: (current: OrchestratorParentTurn) => OrchestratorParentTurn): OrchestratorParentActivity {
  const existing = activity.turns.find((entry) => entry.turn === turn);
  const next = change(existing ?? { turn, thinking: '', text: '', tools: [] });
  const turns = existing === undefined
    ? [...activity.turns, next].slice(-ORCHESTRATOR_RECENT_TURN_LIMIT)
    : activity.turns.map((entry) => (entry.turn === turn ? next : entry));
  return { ...activity, turnCount: Math.max(activity.turnCount, turn), turns };
}

/** Folds one parent progress event into its live conversation; the same object back means nothing visible changed. */
export function reduceParentActivity(activity: OrchestratorParentActivity, event: OperationProgressEvent): OrchestratorParentActivity {
  switch (event.kind) {
    case 'lock_wait':
      return activity.waitingForModel ? activity : { ...activity, waitingForModel: true };
    case 'llm_start':
      return withTurn({ ...activity, waitingForModel: false, parked: false, promptTokens: event.promptTokenCount }, event.turn,
        (turn) => turn);
    case 'thinking':
      return withTurn(activity, event.turn, (turn) => ({ ...turn, thinking: tail(event.thinkingText, TURN_TEXT_TAIL_CHARS) }));
    case 'answer':
      return withTurn(activity, event.turn, (turn) => ({ ...turn, text: tail(event.answerText, TURN_TEXT_TAIL_CHARS) }));
    case 'narration':
      return withTurn(activity, event.turn, (turn) => ({ ...turn, text: tail(event.narrationText, TURN_TEXT_TAIL_CHARS) }));
    case 'tool_start':
      return withTurn(activity, event.turn, (turn) => ({
        ...turn, tools: [...turn.tools, { toolCallId: event.toolCallId, command: event.command, status: 'running', output: '' }],
      }));
    case 'tool_result':
      return withTurn(activity, event.turn, (turn) => ({
        ...turn, tools: turn.tools.map((tool) => (tool.toolCallId === event.toolCallId
          ? { ...tool, status: event.exitCode === 0 ? 'succeeded' : 'failed', output: tail(event.outputSnippet, TOOL_OUTPUT_TAIL_CHARS) }
          : tool)),
      }));
    default:
      return activity;
  }
}
