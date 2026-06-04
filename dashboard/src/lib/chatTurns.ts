import type { ChatMessage } from '../types';

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
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

function resolveTurnKey(message: ChatMessage, isLive: boolean): string {
  if (isLive) return 'live';
  if (message.role === 'user') return `user:${message.id}`;
  const runId = typeof message.sourceRunId === 'string' ? message.sourceRunId.trim() : '';
  return runId ? `run:${runId}` : `solo:${message.id}`;
}

function pickMainMessage(turn: ChatTurn): ChatMessage | null {
  const answer = turn.messages.find(isAnswerMessage);
  if (answer) return answer;
  // Live turn with no answer yet: surface the latest streamed item ("show latest").
  if (turn.isLive) return turn.messages[turn.messages.length - 1] ?? null;
  // Settled, no answer: surface the last non-step message (e.g. a lone user_text
  // message). A settled run that is only thinking/tool steps (answer deleted) has
  // no main slot, so everything stays in Internal Logic.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}

function finalizeTurn(turn: ChatTurn): void {
  const main = pickMainMessage(turn);
  turn.main = main;
  // steps = everything that is not the main slot. No kind filter on steps, so a
  // stray extra message in a run renders inside Internal Logic rather than dropped.
  turn.steps = turn.messages.filter((message) => message !== main);
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
      turns.push({ key, isLive, messages: [message], steps: [], main: null });
    }
  }
  for (const turn of turns) {
    finalizeTurn(turn);
  }
  return turns;
}
