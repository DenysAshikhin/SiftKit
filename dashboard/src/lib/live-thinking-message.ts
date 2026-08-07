import { applyTextDelta } from './stream-text-delta';
import type { ChatStreamTextDelta } from '@siftkit/contracts';
import type { ChatMessage } from '../types';

const LIVE_THINKING_ID_PREFIX = 'live-thinking-';

function buildThinkingMessage(id: string, thinkingText: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    kind: 'assistant_thinking',
    content: thinkingText,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: Math.max(1, Math.ceil(String(thinkingText || '').length / 4)),
    associatedToolTokens: 0,
    createdAtUtc: new Date().toISOString(),
    sourceRunId: null,
  };
}

function findLatestThinkingIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === 'assistant_thinking') {
      return index;
    }
  }
  return -1;
}

function pruneOlderThinkingMessages(messages: ChatMessage[]): ChatMessage[] {
  const latestThinkingIndex = findLatestThinkingIndex(messages);
  if (latestThinkingIndex < 0) {
    return messages;
  }
  return messages.filter((message, index) => {
    return message.kind !== 'assistant_thinking' || index === latestThinkingIndex;
  });
}

export function applyLiveThinkingDelta(
  previous: ChatMessage[],
  delta: ChatStreamTextDelta,
  maintainPerStepThinking: boolean,
): ChatMessage[] {
  const id = `${LIVE_THINKING_ID_PREFIX}${delta.turn}`;
  const index = previous.findIndex((message) => message.id === id);
  let next: ChatMessage[];
  if (index >= 0) {
    next = previous.slice();
    next[index] = buildThinkingMessage(id, applyTextDelta(previous[index]?.content ?? '', delta));
  } else {
    next = [...previous, buildThinkingMessage(id, applyTextDelta('', delta))];
  }
  return maintainPerStepThinking ? next : pruneOlderThinkingMessages(next);
}
