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

export function appendLiveThinkingMessage(
  previous: ChatMessage[],
  thinkingText: string,
  maintainPerStepThinking: boolean,
): ChatMessage[] {
  const last = previous[previous.length - 1];
  let next: ChatMessage[];
  if (last && last.kind === 'assistant_thinking') {
    next = previous.slice();
    next[next.length - 1] = buildThinkingMessage(last.id, thinkingText);
  } else {
    const id = `${LIVE_THINKING_ID_PREFIX}${previous.length}`;
    next = [...previous, buildThinkingMessage(id, thinkingText)];
  }
  return maintainPerStepThinking ? next : pruneOlderThinkingMessages(next);
}
