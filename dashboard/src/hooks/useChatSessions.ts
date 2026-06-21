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
import type { ChatSession, ChatSessionResponse, ContextUsage } from '../types';

export type CreateChatSessionRequest = {
  title: string;
  model: string;
  presetId?: string;
};

export type UseChatSessionsResult = {
  sessions: ChatSession[];
  selectedSessionId: string;
  selectedSession: ChatSession | null;
  selectSession(sessionId: string): void;
  refreshSessions(): Promise<void>;
  createSession(): Promise<void>;
  deleteSession(): Promise<void>;
  updateSessionPreset(presetId: string): Promise<void>;
  toggleThinking(enabled: boolean): Promise<void>;
  toggleWebSearch(enabled: boolean): Promise<void>;
  savePlanRepoRoot(planRepoRootInput: string, presetId: string | undefined): Promise<void>;
  condense(): Promise<void>;
  deleteMessage(messageId: string): Promise<ChatSessionResponse | null>;
  deleteMessages(messageIds: string[]): Promise<ChatSessionResponse | null>;
  applySessionResponse(response: ChatSessionResponse): void;
  setChatBusy(busy: boolean): void;
  chatBusy: boolean;
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

export function useChatSessions(deps: {
  onError(error: Error): void;
  initialSelectedSessionId: string;
  refreshToken: number;
  buildCreateSessionRequest(): CreateChatSessionRequest;
  confirmDeleteSession(): boolean;
  applyContextUsage(value: ContextUsage | null): void;
}): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(deps.initialSelectedSessionId);
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);
  const [chatBusy, setChatBusy] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await getChatSessions();
        if (cancelled) {
          return;
        }
        setSessions(response.sessions);
        if (!selectedSessionId) {
          const firstId = pickFirstSessionId(response.sessions);
          if (firstId) {
            setSelectedSessionId(firstId);
          }
        }
      } catch (error) {
        if (!cancelled) {
          deps.onError(toError(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, deps.refreshToken]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSelectedSession(null);
      deps.applyContextUsage(null);
      return;
    }
    let cancelled = false;
    void getChatSession(selectedSessionId)
      .then((response) => {
        if (!cancelled) {
          setSelectedSession(response.session);
          deps.applyContextUsage(response.contextUsage);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          deps.onError(toError(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  function applySessionResponse(response: ChatSessionResponse): void {
    setSelectedSession(response.session);
    deps.applyContextUsage(response.contextUsage);
  }

  async function refreshSessions(): Promise<void> {
    try {
      const response = await getChatSessions();
      setSessions(response.sessions);
    } catch (error) {
      deps.onError(toError(error));
    }
  }

  async function createSession(): Promise<void> {
    setChatBusy(true);
    try {
      const response = await createChatSession(deps.buildCreateSessionRequest());
      setSessions((previous) => [response.session, ...previous]);
      setSelectedSessionId(response.session.id);
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function deleteSession(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    if (!deps.confirmDeleteSession()) {
      return;
    }
    setChatBusy(true);
    try {
      await deleteChatSession(selectedSessionId);
      const response = await getChatSessions();
      setSessions(response.sessions);
      const nextSession = response.sessions[0] ?? null;
      setSelectedSessionId(nextSession ? nextSession.id : '');
      setSelectedSession(nextSession);
      deps.applyContextUsage(null);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function updateSessionPreset(presetId: string): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    try {
      const response = await updateChatSession(selectedSessionId, { presetId });
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function toggleThinking(enabled: boolean): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    try {
      const response = await updateChatSession(selectedSessionId, { thinkingEnabled: enabled });
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function toggleWebSearch(enabled: boolean): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    try {
      const response = await updateChatSession(selectedSessionId, { webSearchEnabled: enabled });
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function savePlanRepoRoot(planRepoRootInput: string, presetId: string | undefined): Promise<void> {
    if (!selectedSessionId || !planRepoRootInput.trim()) {
      return;
    }
    setChatBusy(true);
    try {
      const response = await updateChatSession(selectedSessionId, {
        ...(presetId ? { presetId } : {}),
        planRepoRoot: planRepoRootInput.trim(),
      });
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function condense(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    try {
      const response = await condenseChatSession(selectedSessionId);
      applySessionResponse(response);
    } catch (error) {
      deps.onError(toError(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function deleteMessage(messageId: string): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || !messageId) {
      return null;
    }
    setChatBusy(true);
    try {
      const response = await deleteChatMessage(selectedSessionId, messageId);
      applySessionResponse(response);
      return response;
    } catch (error) {
      deps.onError(toError(error));
      return null;
    } finally {
      setChatBusy(false);
    }
  }

  // Non-atomic, best-effort: the backend exposes only a single-message DELETE and
  // must not change, so deletes run sequentially and each response is applied as it
  // lands. A mid-loop failure leaves the turn partially deleted (already-removed
  // messages stay removed), routes the error through deps.onError, and returns null.
  async function deleteMessages(messageIds: string[]): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || messageIds.length === 0) {
      return null;
    }
    setChatBusy(true);
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
      deps.onError(toError(error));
      return null;
    } finally {
      setChatBusy(false);
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
    setChatBusy,
    chatBusy,
  };
}
