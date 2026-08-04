import type { ChatSession } from '../types';
import type { ChatSessionRuntime } from './chat-session-runtime-store';

export type SessionIndicator = 'streaming' | 'tool' | 'failed' | 'completed';

export function deriveSessionIndicator(
  session: ChatSession,
  runtime: ChatSessionRuntime | null,
): SessionIndicator {
  if (runtime && runtime.activity.kind === 'active') {
    const hasRunningTool = runtime.liveMessages.some((message) => message.toolCallStatus === 'running');
    return hasRunningTool ? 'tool' : 'streaming';
  }
  if (runtime?.error) {
    return 'failed';
  }
  const messages = runtime ? [...session.messages, ...runtime.liveMessages] : session.messages;
  const last = messages[messages.length - 1];
  if (last && typeof last.toolCallExitCode === 'number' && last.toolCallExitCode !== 0) {
    return 'failed';
  }
  return 'completed';
}

export function isSessionBusy(runtime: ChatSessionRuntime | null): boolean {
  return runtime !== null && runtime.activity.kind === 'active';
}
