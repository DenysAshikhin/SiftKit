import { useEffect, useState } from 'react';

import {
  assessImageVramHeadroom,
  estimateVisionPeakVramBytesForImagePixels,
} from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.js';
import {
  condenseChatSession,
  ActiveRepoAgentApprovalStateSchema,
  createChatSession,
  deleteChatMessage,
  deleteChatMessageImage,
  deleteChatSession,
  decideRepoAgent,
  getActiveRepoAgentRun,
  getChatSession,
  getChatSessions,
  getInferenceRuntimeStatus,
  streamChatMessage,
  streamPlanMessage,
  streamRepoSearchMessage,
  streamRepoAgentMessage,
  stopChatOperation,
  updateChatSession,
} from '../api';
import {
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveRepoRoot,
} from '../lib/chat-composer-inputs';
import { ChatSessionRuntimeStore } from '../lib/chat-session-runtime-store';
import { toRuntimeTransitions } from '../lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../lib/chat-stream-parser';
import type { ChatSession, ChatSessionResponse, ChatSessionOperationKind } from '../types';
import type { ToastLevel } from './useToasts';
import type { PendingImage } from '../lib/downscale-image';

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
  enqueueToast(level: ToastLevel, text: string): void;
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
    void Promise.all([getChatSession(selectedSessionId), getActiveRepoAgentRun(selectedSessionId)])
      .then(([response, activeRun]) => {
        if (!cancelled) {
          setSessions((previous) => upsertSession(previous, response.session));
          setRuntimeStore((previous) => previous.apply({
            kind: 'context-usage',
            sessionId: response.session.id,
            contextUsage: response.contextUsage,
          }));
          const state = ActiveRepoAgentApprovalStateSchema.safeParse(activeRun?.state);
          if (activeRun && state.success) {
            setRuntimeStore((previous) => previous.apply({
              kind: 'approval',
              sessionId: response.session.id,
              approval: { runId: activeRun.runId, ...state.data.approval },
            }));
          } else {
            setRuntimeStore((previous) => previous.apply({
              kind: 'approval-clear',
              sessionId: response.session.id,
            }));
          }
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

  function failSessionOperation(sessionId: string, message: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'failure', sessionId, message }));
  }

  function setSessionDraft(sessionId: string, draft: string): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'draft', sessionId, draft }));
  }

  function setSessionImages(sessionId: string, images: PendingImage[]): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'images', sessionId, images }));
  }

  function appendSessionImages(sessionId: string, images: PendingImage[]): void {
    setRuntimeStore((prev) => prev.apply({ kind: 'append-images', sessionId, images }));
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

  async function deleteMessageImage(messageId: string, imageIndex: number): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || !messageId) {
      return null;
    }
    try {
      const response = await deleteChatMessageImage(selectedSessionId, messageId, imageIndex);
      applySessionResponse(response);
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

  async function runChatStream(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    stream: AsyncGenerator<ChatStreamEvent>,
  ): Promise<void> {
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    for await (const transition of toRuntimeTransitions(sessionId, operationKind, stream, thinkingEnabled)) {
      setRuntimeStore((previous) => previous.apply(transition));
      if (transition.kind === 'done') {
        setSessions((previous) => upsertSession(previous, transition.response.session));
      }
    }
  }

  function readRuntimeInputs(sessionId: string): {
    draft: string;
    pendingImages: PendingImage[];
    planRepoRootInput: string;
    planMaxTurnsInput: string;
  } {
    const runtime = runtimeStore.get(sessionId);
    return {
      draft: runtime.draft.trim(),
      pendingImages: runtime.pendingImages,
      planRepoRootInput: runtime.planRepoRootInput,
      planMaxTurnsInput: runtime.planMaxTurnsInput,
    };
  }

  function submitRuntimeInputs(sessionId: string, content: string, images: PendingImage[]): void {
    setRuntimeStore((previous) => previous.apply({ kind: 'submit', sessionId, content, images }));
  }

  async function sendMessage(): Promise<void> {
    if (!selectedSession) {
      return;
    }
    const inputs = readRuntimeInputs(selectedSession.id);
    if (!inputs.draft && inputs.pendingImages.length === 0) {
      return;
    }
    if (inputs.pendingImages.length > 0) {
      try {
        const runtimeStatus = await getInferenceRuntimeStatus();
        const budget = runtimeStatus.imageTokenBudget;
        const sessionPreset = selectedSession.modelPreset;
        const finding = budget && sessionPreset
          ? assessImageVramHeadroom({
              freeBytes: runtimeStatus.gpuFreeBytes,
              peakEncodeBytes: estimateVisionPeakVramBytesForImagePixels(
                budget,
                sessionPreset.VisionMaxImagePixels,
              ),
            })
          : null;
        if (finding) {
          deps.enqueueToast(finding.level, finding.message);
        }
      } catch {
        // The warning is advisory; a failed probe must not block a user who knows the image is safe.
      }
    }
    submitRuntimeInputs(selectedSession.id, inputs.draft, inputs.pendingImages);
    await runChatStream(
      selectedSession.id,
      'message',
      streamChatMessage(selectedSession.id, {
        content: inputs.draft,
        images: inputs.pendingImages.map((image) => image.dataUrl),
      }),
    );
  }

  async function sendPlan(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    await runChatStream(session.id, 'plan', streamPlanMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
      ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
    }));
  }

  async function sendRepoSearch(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    await runChatStream(session.id, 'repo-search', streamRepoSearchMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
      ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
    }));
  }

  async function sendRepoAgent(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    await runChatStream(session.id, 'repo-agent', streamRepoAgentMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
      ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
    }));
  }

  async function submitRepoAgentDecision(
    decision: Parameters<typeof decideRepoAgent>[1],
  ): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const approval = runtimeStore.get(session.id).pendingApproval;
    await decideRepoAgent(session.id, decision);
    if (approval) {
      setRuntimeStore((previous) => previous.apply({
        kind: 'approval-decision',
        sessionId: session.id,
        resolution: { approval, decision, decidedAtUtc: new Date().toISOString() },
      }));
    }
  }

  async function stopOperation(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    try {
      await stopChatOperation(selectedSessionId);
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
    }
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
    deleteMessageImage,
    applySessionResponse,
    failSessionOperation,
    setSessionDraft,
    setSessionImages,
    appendSessionImages,
    setSessionPlanInputs,
    sendMessage,
    sendPlan,
    sendRepoSearch,
    sendRepoAgent,
    submitRepoAgentDecision,
    stopOperation,
  };
}

export type UseChatSessionsResult = ReturnType<typeof useChatSessions>;
