import type { ChatMessage, ChatSession } from '../types';

export type SessionIndicator = 'streaming' | 'tool' | 'failed' | 'completed';

export function deriveSessionIndicator(
  session: ChatSession,
  options: { isActive: boolean; chatBusy: boolean; liveMessages: ChatMessage[] },
): SessionIndicator {
  const { isActive, chatBusy, liveMessages } = options;
  if (isActive && chatBusy) {
    const hasRunningTool = liveMessages.some((message) => message.toolCallStatus === 'running');
    return hasRunningTool ? 'tool' : 'streaming';
  }
  const messages = isActive ? [...session.messages, ...liveMessages] : session.messages;
  const last = messages[messages.length - 1];
  if (last && typeof last.toolCallExitCode === 'number' && last.toolCallExitCode !== 0) {
    return 'failed';
  }
  return 'completed';
}
