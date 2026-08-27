import type { ChatStreamTextDelta } from '@siftkit/contracts';
import type { ChatMessage } from '../types';
import { createLiveMessage, upsertLiveMessageInto } from './chat-live-messages';
import { applyTextDelta } from './stream-text-delta';

export function liveNarrationMessageId(turn: number): string {
  return `assistant-narration-turn-${turn}`;
}

export function applyNarrationDelta(
  messages: ChatMessage[],
  delta: ChatStreamTextDelta,
): ChatMessage[] {
  const id = liveNarrationMessageId(delta.turn);
  const existing = messages.find((message) => message.id === id);
  const content = applyTextDelta(existing?.content ?? '', delta);
  return upsertLiveMessageInto(
    messages,
    createLiveMessage(id, 'assistant_narration', 'assistant', content),
  );
}

export function demoteNarrationForTurn(messages: ChatMessage[], turn: number): ChatMessage[] {
  const id = liveNarrationMessageId(turn);
  return messages.map((message) => message.id === id && message.kind === 'assistant_narration'
    ? { ...message, kind: 'assistant_progress' }
    : message);
}

export function promoteNarrationToAnswer(
  messages: ChatMessage[],
  delta: ChatStreamTextDelta,
): ChatMessage[] {
  const id = liveNarrationMessageId(delta.turn);
  return messages.map((message) => {
    if (message.id !== id) return message;
    const content = applyTextDelta(message.content, delta);
    return {
      ...message,
      kind: 'assistant_answer',
      content,
      outputTokensEstimate: Math.max(1, Math.ceil(content.length / 4)),
    };
  });
}
