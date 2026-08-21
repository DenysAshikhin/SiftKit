import type { ChatMessage } from '../types';

/** How many recent thinking blocks a live turn keeps on screen, newest last. */
export const LIVE_THINKING_STACK_DEPTH = 3;

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
  /** Live-only: the newest thinking blocks, oldest first. Always empty once settled. */
  liveThinking: ChatMessage[];
  /** Live-only status bar note; never part of steps, the thinking stack, or main. */
  progress: ChatMessage | null;
  main: ChatMessage | null;
};

export function normalizeMessageKind(message: ChatMessage): NonNullable<ChatMessage['kind']> {
  return message.kind ?? (message.role === 'user' ? 'user_text' : 'assistant_answer');
}

function isAnswerMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_answer';
}

function isStepMessage(message: ChatMessage): boolean {
  const kind = normalizeMessageKind(message);
  return kind === 'assistant_thinking' || kind === 'assistant_tool_call';
}

function isThinkingMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_thinking';
}

function isToolCallMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_tool_call';
}

function isProgressMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_progress';
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
  // Live turn with no answer yet: the newest tool call owns the main slot. The
  // reasoning that led to it lives in the thinking stack instead of being
  // demoted into Internal Logic the moment the tool starts.
  if (turn.isLive) {
    const toolCalls = turn.messages.filter(isToolCallMessage);
    const toolCall = toolCalls[toolCalls.length - 1];
    if (toolCall) {
      return toolCall;
    }
  }
  // No answer and no owning tool call: surface the last non-step message (e.g.
  // a lone user_text message, or the live user bubble before the turn's
  // assistant side starts). A run that is only thinking/tool steps (answer
  // deleted) has no main slot, so everything stays in Internal Logic.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message) && !isProgressMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}

function pickLiveThinking(turn: ChatTurn): ChatMessage[] {
  // Settled turns keep every step in Internal Logic; the stack is live-only.
  if (!turn.isLive) return [];
  // Once the answer streams, the turn settles into the ordinary shape.
  if (turn.messages.some(isAnswerMessage)) return [];
  return turn.messages.filter(isThinkingMessage).slice(-LIVE_THINKING_STACK_DEPTH);
}

function finalizeTurn(turn: ChatTurn): void {
  const main = pickMainMessage(turn);
  const liveThinking = pickLiveThinking(turn);
  const progressMessages = turn.messages.filter(isProgressMessage);
  turn.main = main;
  turn.liveThinking = liveThinking;
  turn.progress = progressMessages[progressMessages.length - 1] ?? null;
  // steps = everything that is neither the main slot, on the stack, nor the
  // progress bar. No other kind filter, so a stray extra message in a run
  // renders inside Internal Logic rather than being dropped.
  turn.steps = turn.messages.filter((message) => message !== main && !liveThinking.includes(message) && !isProgressMessage(message));
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
      turns.push({ key, isLive, messages: [message], steps: [], liveThinking: [], progress: null, main: null });
    }
  }
  for (const turn of turns) {
    finalizeTurn(turn);
  }
  return turns;
}
