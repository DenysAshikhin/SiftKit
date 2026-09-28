import type { ChatOperationSnapshot } from '@siftkit/contracts';
import type { ChatMessage } from '../types';
import type { ChatSessionLive, ChatSessionRuntime, ChatSessionRuntimeStore } from './chat-session-runtime-store';

// Every selector returns a store-owned value or a primitive, so an unchanged store yields an identical slice.

export const NO_MESSAGES: readonly ChatMessage[] = [];

export function selectRuntime(store: ChatSessionRuntimeStore, sessionId: string): ChatSessionRuntime | null {
  return store.has(sessionId) ? store.get(sessionId) : null;
}

export function selectLive(store: ChatSessionRuntimeStore, sessionId: string): ChatSessionLive | null {
  return store.has(sessionId) ? store.getLive(sessionId) : null;
}

export function selectAwaitingResponse(store: ChatSessionRuntimeStore, sessionId: string): boolean {
  return selectRuntime(store, sessionId)?.awaitingResponse ?? false;
}

export function selectLiveOperationId(store: ChatSessionRuntimeStore, sessionId: string): string | null {
  return selectLive(store, sessionId)?.journalSnapshot?.operationId ?? null;
}

export function selectCompactedEarlierHistory(store: ChatSessionRuntimeStore, sessionId: string): boolean {
  return selectLive(store, sessionId)?.journalSnapshot?.compactedEarlierHistory ?? false;
}

export function selectStreamedCharsSinceBase(store: ChatSessionRuntimeStore, sessionId: string): number {
  return selectLive(store, sessionId)?.streamedCharsSinceBase ?? 0;
}

/** The projection keeps an unchanged approval's identity across frames, so Object.is equality holds per token. */
export function selectActionableApproval(store: ChatSessionRuntimeStore, sessionId: string): NonNullable<ChatOperationSnapshot['approval']> | null {
  const approval = selectLive(store, sessionId)?.journalSnapshot?.approval ?? null;
  return approval?.actionable ? approval : null;
}

export function selectActionableQuestion(store: ChatSessionRuntimeStore, sessionId: string): NonNullable<ChatOperationSnapshot['question']> | null {
  const question = selectLive(store, sessionId)?.journalSnapshot?.question ?? null;
  return question?.actionable ? question : null;
}

export function selectQuestionId(store: ChatSessionRuntimeStore, sessionId: string): string | null {
  return selectLive(store, sessionId)?.journalSnapshot?.question?.questionId ?? null;
}
