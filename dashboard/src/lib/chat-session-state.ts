import type { ChatSessionSummary } from '../types';
import type { ChatSessionRuntime, SessionIndicator } from './chat-session-runtime-store';

export function deriveSessionIndicator(session: ChatSessionSummary, runtime: ChatSessionRuntime | null): SessionIndicator {
  if (runtime?.indicator) {
    return runtime.indicator;
  }
  const exitCode = session.lastToolCallExitCode;
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed';
}

export function isSessionBusy(runtime: Pick<ChatSessionRuntime, 'activity' | 'pendingApproval' | 'submissionPhase'> | null): boolean {
  return runtime !== null && (
    runtime.activity.kind !== 'idle'
    || runtime.pendingApproval !== null
    || runtime.submissionPhase !== null
  );
}

/** True when this session has a repo-agent run in flight, whether or not this client started it. */
export function hasActiveRepoAgentRun(runtime: Pick<ChatSessionRuntime, 'activity'> | null): boolean {
  return runtime !== null
    && runtime.activity.kind !== 'idle'
    && runtime.activity.operationKind === 'repo-agent';
}
