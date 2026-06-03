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

export function appendLiveThinkingMessage(previous: ChatMessage[], thinkingText: string): ChatMessage[] {
  const last = previous[previous.length - 1];
  if (last && last.kind === 'assistant_thinking') {
    const next = previous.slice();
    next[next.length - 1] = buildThinkingMessage(last.id, thinkingText);
    return next;
  }
  const id = `${LIVE_THINKING_ID_PREFIX}${previous.length}`;
  return [...previous, buildThinkingMessage(id, thinkingText)];
}
