import { isDisplayOnlyImageMessage } from '@siftkit/contracts';
import type { ChatMessage, ChatToolCallMessage } from '../types';
import { buildToolActivityRing, type ToolActivityGroup } from './tool-activity-ring';

/** How many recent thinking blocks a live turn keeps on screen, newest last. */
export const LIVE_THINKING_STACK_DEPTH = 3;

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
  /** Images the assistant showed with show_image; rendered in the bubble, never folded away. */
  shownImages: ChatToolCallMessage[];
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
  return kind === 'assistant_thinking' || kind === 'assistant_tool_call' || kind === 'assistant_narration' || kind === 'assistant_progress';
}

function isStatusUpdate(message: ChatMessage): boolean {
  return message.kind === 'assistant_narration' && message.content.trim() !== '';
}

function isThinkingMessage(message: ChatMessage): boolean {
  return message.kind === 'assistant_thinking';
}

function isToolCallMessage(message: ChatMessage): message is ChatToolCallMessage {
  return message.kind === 'assistant_tool_call';
}

function isShownImageMessage(message: ChatMessage): message is ChatToolCallMessage {
  return isToolCallMessage(message) && isDisplayOnlyImageMessage(message) && (message.images?.length ?? 0) > 0;
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

function pickMainMessage(turn: ChatTurn, answer: ChatMessage | undefined): ChatMessage | null {
  if (answer) return answer;
  // The newest status update holds the slot until a newer one or the answer replaces it.
  const statusUpdates = turn.messages.filter(isStatusUpdate);
  const status = statusUpdates[statusUpdates.length - 1];
  if (status) return status;
  // No answer or status: surface the last non-step message (e.g. a lone user_text message,
  // or the live user bubble before the assistant side starts). A run that is
  // only thinking/tool steps has no main slot.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}

function pickLiveThinking(turn: ChatTurn, liveUnanswered: boolean): ChatMessage[] {
  // Settled or answering turns keep every step in Internal Logic; the stack is live-only.
  if (!liveUnanswered) return [];
  return turn.messages.filter(isThinkingMessage).slice(-LIVE_THINKING_STACK_DEPTH);
}

function pickRecentActivities(turn: ChatTurn, liveUnanswered: boolean): ToolActivityGroup[] {
  if (!liveUnanswered) return [];
  return buildToolActivityRing(turn.messages.filter(isToolCallMessage));
}

function finalizeTurn(turn: ChatTurn): void {
  const answer = turn.messages.find(isAnswerMessage);
  // Once the answer streams, a live turn settles into the ordinary shape.
  const liveUnanswered = turn.isLive && answer === undefined;
  const main = pickMainMessage(turn, answer);
  const liveThinking = pickLiveThinking(turn, liveUnanswered);
  turn.main = main;
  turn.liveThinking = liveThinking;
  turn.recentActivities = pickRecentActivities(turn, liveUnanswered);
  turn.showRecentActivity = liveUnanswered && turn.messages.some((message) => message.role === 'assistant');
  // Live tools belong only to the recent ring. Everything else that is not the
  // main slot or thinking stack stays in Internal Logic.
  turn.shownImages = turn.messages.filter(isShownImageMessage);
  turn.steps = turn.messages.filter((message) => (
    message !== main
    && !liveThinking.includes(message)
    && !isShownImageMessage(message)
    && !(liveUnanswered && isToolCallMessage(message))
  ));
}

export function groupMessagesIntoTurns(messages: ChatMessage[], liveMessageIds: Set<string>): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let lastGroupingKey: string | null = null;
  for (const message of messages) {
    const isLive = liveMessageIds.has(message.id);
    const key = resolveTurnKey(message, isLive);
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastGroupingKey === key) {
      lastTurn.messages.push(message);
    } else {
      turns.push({
        key: message.role === 'user' ? `user:${message.id}` : `assistant-segment:${message.id}`,
        isLive,
        messages: [message],
        steps: [],
        shownImages: [],
        liveThinking: [],
        recentActivities: [],
        showRecentActivity: false,
        main: null,
      });
    }
    lastGroupingKey = key;
  }
  for (const turn of turns) {
    finalizeTurn(turn);
  }
  return turns;
}
