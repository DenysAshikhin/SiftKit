import { useEffect, useState } from 'react';

import { toError } from '../../../src/lib/errors.js';
import {
  condenseChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  updateChatSession,
} from '../api';
import { ChatSessionRuntimeStore } from '../lib/chat-session-runtime-store';
import type { ChatStreamToolEvent } from '../lib/chat-stream-parser';
import type { ChatSession, ChatSessionResponse, ChatSessionOperationKind } from '../types';

export type CreateChatSessionRequest = {
  title: string;
  presetId?: string;
};

export function pickFirstSessionId(sessions: ChatSession[]): string {
  return sessions[0]?.id ?? '';
}

export function findSessionByIdStrict(sessions: ChatSession[], sessionId: string): ChatSession {
  const found = sessions.find((session) => session.id === sessionId);
  if (!found) {
    throw new Error(`useChatSessions: unknown session id "${sessionId}"`);
  }
  return found;
}

export function upsertSession(sessions: ChatSession[], updated: ChatSession): ChatSession[] {
  const index = sessions.findIndex((s) => s.id === updated.id);
  if (index < 0) {
    return [updated, ...sessions];
  }
  const next = sessions.slice();
  next[index] = updated;
  return next;
}

export function useChatSessions(deps: {
  initialSelectedSessionId: string;
  refreshToken: number;
  buildCreateSessionRequest(): CreateChatSessionRequest | null;
  confirmDeleteSession(): boolean;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(deps.initialSelectedSessionId);
  const [runtimeStore, setRuntimeStore] = useState<ChatSessionRuntimeStore>(new ChatSessionRuntimeStore());
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  function recordSessionError(sessionId: string, error: Error): void {
    if (!sessionId) {
      return;
    }
    setRuntimeStore((prev) => prev.apply({ kind: 'failure', sessionId, message: error.message }));
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await getChatSessions();
        if (cancelled) {
          return;
        }
        setSessions(response.sessions);
        setRuntimeStore((prev) => {
          let store = prev;
          for (const session of response.sessions) {
            store = store.ensureSession(session.id);
          }
          return store;
        });
        if (!selectedSessionId) {
          const firstId = pickFirstSessionId(response.sessions);
          if (firstId) {
            setSelectedSessionId(firstId);
          }
        }
      } catch (error) {
        if (!cancelled) {
          recordSessionError(selectedSessionId, toError(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, deps.refreshToken]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    let cancelled = false;
    void getChatSession(selectedSessionId)
      .then((response) => {
        if (!cancelled) {
          setSessions((previous) => upsertSession(previous, response.session));
          setRuntimeStore((previous) => previous.apply({
            kind: 'context-usage',
            sessionId: response.session.id,
            contextUsage: response.contextUsage,
          }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          recordSessionError(selectedSessionId, toError(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  function applySessionResponse(response: ChatSessionResponse): void {
    setSessions((previous) => upsertSession(previous, response.session));
    setRuntimeStore((previous) => previous.apply({
      kind: 'context-usage',
      sessionId: response.session.id,
      contextUsage: response.contextUsage,
    }));
  }

  function beginSessionOperation(sessionId: string, operationKind: ChatSessionOperationKind): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'begin', sessionId, operationKind }));
  }

  function appendSessionThinking(sessionId: string, text: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'thinking', sessionId, text }));
  }

  function applySessionToolEvent(sessionId: string, toolEvent: ChatStreamToolEvent): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'tool', sessionId, toolEvent }));
  }

  function applySessionAnswer(sessionId: string, text: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'answer', sessionId, text }));
  }

  function applySessionWarning(sessionId: string, text: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'warning', sessionId, text }));
  }

  function completeSessionOperation(sessionId: string, response: ChatSessionResponse): void {
    if (response.session.id !== sessionId) {
      throw new Error(`Chat stream session mismatch: expected "${sessionId}", received "${response.session.id}"`);
    }
    setSessions((previous) => upsertSession(previous, response.session));
    setRuntimeStore((previous) => previous.apply({ kind: 'done', sessionId: response.session.id, response }));
  }

  function failSessionOperation(sessionId: string, message: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'failure', sessionId, message }));
  }

  function setSessionDraft(sessionId: string, draft: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'draft', sessionId, draft }));
  }

  function setSessionImages(sessionId: string, images: string[]): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'images', sessionId, images }));
  }

  function setSessionPlanInputs(sessionId: string, planRepoRootInput: string, planMaxTurnsInput: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'plan-inputs', sessionId, planRepoRootInput, planMaxTurnsInput }));
  }

  async function refreshSessions(): Promise<void> {
    try {
      const response = await getChatSessions();
      setSessions(response.sessions);
      setRuntimeStore((prev) => {
        let store = prev;
        for (const session of response.sessions) {
          store = store.ensureSession(session.id);
        }
        return store;
      });
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function createSession(): Promise<void> {
    const request = deps.buildCreateSessionRequest();
    if (!request) {
      return;
    }
    try {
      const response = await createChatSession(request);
      setSessions((previous) => [response.session, ...previous]);
      setSelectedSessionId(response.session.id);
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function deleteSession(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    if (!deps.confirmDeleteSession()) {
      return;
    }
    try {
      await deleteChatSession(selectedSessionId);
      const response = await getChatSessions();
      setSessions(response.sessions);
      const nextSession = response.sessions[0] ?? null;
      setSelectedSessionId(nextSession ? nextSession.id : '');
      setRuntimeStore((prev) => prev.removeSession(selectedSessionId));
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function updateSessionPreset(presetId: string): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await updateChatSession(selectedSessionId, { presetId });
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function toggleThinking(enabled: boolean): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await updateChatSession(selectedSessionId, { thinkingEnabled: enabled });
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function toggleWebSearch(enabled: boolean): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await updateChatSession(selectedSessionId, { webSearchEnabled: enabled });
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function savePlanRepoRoot(planRepoRootInput: string, presetId: string | undefined): Promise<void> {
    if (!selectedSessionId || !planRepoRootInput.trim()) {
      return;
    }
    try {
      const response = await updateChatSession(selectedSessionId, {
        ...(presetId ? { presetId } : {}),
        planRepoRoot: planRepoRootInput.trim(),
      });
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function condense(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await condenseChatSession(selectedSessionId);
      applySessionResponse(response);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
  }

  async function deleteMessage(messageId: string): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || !messageId) {
      return null;
    }
    try {
      const response = await deleteChatMessage(selectedSessionId, messageId);
      applySessionResponse(response);
      return response;
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
      return null;
    }
  }

  async function deleteMessages(messageIds: string[]): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || messageIds.length === 0) {
      return null;
    }
    try {
      let response: ChatSessionResponse | null = null;
      for (const messageId of messageIds) {
        if (!messageId) {
          continue;
        }
        response = await deleteChatMessage(selectedSessionId, messageId);
        applySessionResponse(response);
      }
      return response;
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
      return null;
    }
  }

  function selectSession(sessionId: string): void {
    if (sessions.length > 0) {
      findSessionByIdStrict(sessions, sessionId);
    }
    setSelectedSessionId(sessionId);
  }

  return {
    sessions,
    selectedSessionId,
    selectedSession,
    runtimeStore,
    selectSession,
    refreshSessions,
    createSession,
    deleteSession,
    updateSessionPreset,
    toggleThinking,
    toggleWebSearch,
    savePlanRepoRoot,
    condense,
    deleteMessage,
    deleteMessages,
    applySessionResponse,
    beginSessionOperation,
    appendSessionThinking,
    applySessionToolEvent,
    applySessionAnswer,
    applySessionWarning,
    completeSessionOperation,
    failSessionOperation,
    setSessionDraft,
    setSessionImages,
    setSessionPlanInputs,
  };
}

export type UseChatSessionsResult = ReturnType<typeof useChatSessions>;
