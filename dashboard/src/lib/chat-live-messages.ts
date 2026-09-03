import { ChatMessageSchema, type ChatMessage } from '../types';

type LiveMessageKind = Exclude<ChatMessage['kind'], 'assistant_tool_call'>;

export function createLiveMessage(
  id: string,
  kind: LiveMessageKind,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  const thinkingTokens = kind === 'assistant_thinking' ? Math.max(1, Math.ceil(String(content || '').length / 4)) : 0;
  return ChatMessageSchema.parse({
    id,
    role,
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: thinkingTokens > 0,
    associatedToolTokens: 0,
    createdAtUtc: new Date().toISOString(),
    sourceRunId: null,
  });
}

export const LIVE_USER_MESSAGE_ID = 'live-user';

export function buildLiveUserMessage(content: string, imageDataUrls: string[]): ChatMessage {
  return {
    ...createLiveMessage(LIVE_USER_MESSAGE_ID, 'user_text', 'user', content),
    images: imageDataUrls,
  };
}

export function upsertLiveMessageInto(previous: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = previous.findIndex((entry) => entry.id === message.id);
  if (index < 0) {
    return [...previous, message];
  }
  const next = previous.slice();
  next[index] = { ...previous[index], ...message };
  return next;
}
