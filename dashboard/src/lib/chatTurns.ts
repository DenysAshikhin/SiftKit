import type { ChatMessage, ChatToolCallMessage } from '../types';
import { buildToolActivityRing, type ToolActivityGroup } from './tool-activity-ring';

/** How many recent thinking blocks a live turn keeps on screen, newest last. */
export const LIVE_THINKING_STACK_DEPTH = 3;

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
  /** Live-only: the newest thinking blocks, oldest first. Always empty once settled. */
  liveThinking: ChatMessage[];
  /** Live-only: the newest grouped tool activities, oldest first. */
  recentActivities: ToolActivityGroup[];
  /** The activity shell stays visible for the live assistant phase, including before its first tool. */
  showRecentActivity: boolean;
  main: ChatMessage | null;
};

function isAnswerMessage(message: ChatMessage): boolean {
  return message.kind === 'assistant_answer';
}

function isStepMessage(message: ChatMessage): boolean {
  const kind = message.kind;
  return kind === 'assistant_thinking' || kind === 'assistant_tool_call' || kind === 'assistant_progress';
}

function isThinkingMessage(message: ChatMessage): boolean {
  return message.kind === 'assistant_thinking';
}

function isToolCallMessage(message: ChatMessage): message is ChatToolCallMessage {
  return message.kind === 'assistant_tool_call';
}

function resolveTurnKey(message: ChatMessage, isLive: boolean): string {
  // A user message always owns its own turn. Keying it as 'live' too would fold the
  // optimistic bubble into the assistant's live turn, where the streaming answer takes
  // the main slot and the user's own words get demoted into Internal Logic.
  if (message.role === 'user') return `user:${message.id}`;
  if (isLive) return 'live';
  const runId = typeof message.sourceRunId === 'string' ? message.sourceRunId.trim() : '';
  return runId ? `run:${runId}` : `solo:${message.id}`;
}

function pickMainMessage(turn: ChatTurn): ChatMessage | null {
  const answer = turn.messages.find(isAnswerMessage);
  if (answer) return answer;
  // No answer: surface the last non-step message (e.g. a lone user_text message,
  // or the live user bubble before the assistant side starts). A run that is
  // only thinking/tool steps has no main slot.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}

function pickLiveThinking(turn: ChatTurn): ChatMessage[] {
  // Settled turns keep every step in Internal Logic; the stack is live-only.
  if (!turn.isLive) return [];
  // Once the answer streams, the turn settles into the ordinary shape.
  if (turn.messages.some(isAnswerMessage)) return [];
  return turn.messages.filter(isThinkingMessage).slice(-LIVE_THINKING_STACK_DEPTH);
}

function pickRecentActivities(turn: ChatTurn): ToolActivityGroup[] {
  if (!turn.isLive) return [];
  if (turn.messages.some(isAnswerMessage)) return [];
  return buildToolActivityRing(turn.messages.filter(isToolCallMessage));
}

function finalizeTurn(turn: ChatTurn): void {
  const main = pickMainMessage(turn);
  const liveThinking = pickLiveThinking(turn);
  const recentActivities = pickRecentActivities(turn);
  const hideLiveTools = turn.isLive && !turn.messages.some(isAnswerMessage);
  turn.main = main;
  turn.liveThinking = liveThinking;
  turn.recentActivities = recentActivities;
  turn.showRecentActivity = turn.isLive
    && turn.messages.some((message) => message.role === 'assistant')
    && !turn.messages.some(isAnswerMessage);
  // Live tools belong only to the recent ring. Everything else that is not the
  // main slot, thinking stack, or progress bar stays in Internal Logic.
  turn.steps = turn.messages.filter((message) => (
    message !== main
    && !liveThinking.includes(message)
    && !(hideLiveTools && isToolCallMessage(message))
  ));
}

export function groupMessagesIntoTurns(messages: ChatMessage[], liveMessageIds: Set<string>): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const isLive = liveMessageIds.has(message.id);
    const key = resolveTurnKey(message, isLive);
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.key === key) {
      lastTurn.messages.push(message);
    } else {
      turns.push({
        key,
        isLive,
        messages: [message],
        steps: [],
        liveThinking: [],
        recentActivities: [],
        showRecentActivity: false,
        main: null,
      });
    }
  }
  for (const turn of turns) {
    finalizeTurn(turn);
  }
  return turns;
}
