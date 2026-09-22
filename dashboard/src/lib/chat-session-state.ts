import type { ChatSessionSummary } from '../types';
import type { ChatSessionRuntime } from './chat-session-runtime-store';

export type SessionIndicator = 'streaming' | 'tool' | 'failed' | 'completed';

export function deriveSessionIndicator(
  session: ChatSessionSummary,
  runtime: ChatSessionRuntime | null,
): SessionIndicator {
  if (runtime && runtime.activity.kind !== 'idle') {
    const hasRunningTool = runtime.liveMessages.some((message) => message.toolCallStatus === 'running');
    return hasRunningTool ? 'tool' : 'streaming';
  }
  if (runtime?.error) {
    return 'failed';
  }
  const liveLast = runtime?.liveMessages[runtime.liveMessages.length - 1];
  const exitCode = liveLast ? liveLast.toolCallExitCode ?? null : session.lastToolCallExitCode;
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed';
}

export function isSessionBusy(runtime: ChatSessionRuntime | null): boolean {
  return runtime !== null && (
    runtime.activity.kind !== 'idle'
    || runtime.pendingApproval !== null
    || runtime.submissionPhase !== null
  );
}

/** True when this session has a repo-agent run in flight, whether or not this client started it. */
export function hasActiveRepoAgentRun(runtime: ChatSessionRuntime | null): boolean {
  return runtime !== null
    && runtime.activity.kind !== 'idle'
    && runtime.activity.operationKind === 'repo-agent';
}
