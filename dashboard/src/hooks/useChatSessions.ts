import { useEffect, useRef, useState } from 'react';

import {
  assessImageVramHeadroom,
  estimateVisionPeakVramBytesForImagePixels,
  type ApprovalMode,
  type ChatQueueOperationKind,
  type ChatQueueEnqueueRequest,
  type ChatQueueForceRequest,
  type ChatMessageStreamRequest,
  type ChatRepoStreamRequest,
  type ChatRepoAgentStreamRequest,
  type ChatQuestionReply,
} from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.js';
import {
  condenseChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatMessageImage,
  deleteChatSession,
  answerChatQuestion,
  decideRepoAgent,
  attachChatOperationStream,
  getActiveRepoAgentRun,
  getChatSession,
  getChatSessions,
  getInferenceRuntimeStatus,
  listActiveChatOperations,
  streamChatMessage,
  streamPlanMessage,
  streamRepoSearchMessage,
  streamRepoAgentMessage,
  stopChatOperation,
  updateChatSession,
  updateRepoAgentApprovalMode,
  ChatOperationIdleError,
  getChatQueue, enqueueChatMessage, streamChatQueue, forceChatQueue,
  getQueuedChatMessage, editQueuedChatMessage, removeQueuedChatMessage,
  ChatQueueRejectedError,
  type RepoAgentDecision,
} from '../api';
import {
  PLAN_MAX_TURNS_VALIDATION_ERROR,
  PlanMaxTurnsOverrideSchema,
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveRepoRoot,
  type ParsedMaxTurnsOverride,
} from '../lib/chat-composer-inputs';
import type { ChatSessionRuntimeTransition } from '../lib/chat-session-runtime-store';
import { ChatRuntimeHub } from '../lib/chat-runtime-hub';
import { hasActiveRepoAgentRun, isSessionBusy } from '../lib/chat-session-state';
import { useLatest } from '../lib/use-latest';
import { ownedStreamTransitions, toRuntimeTransitions } from '../lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../lib/chat-stream-parser';
import { ChatSessionSummarySchema } from '../types';
import type { ChatSession, ChatSessionResponse, ChatSessionSummary } from '../types';
import type { ToastLevel } from './useToasts';
import type { PendingImage } from '../lib/downscale-image';
import { waitForAbortableDelay } from '../lib/abortable-delay';

const CHAT_ATTACH_RECONNECT_MS = 1000;

type OwnedChatSubmission =
  | { operationKind: 'message'; payload: ChatMessageStreamRequest }
  | { operationKind: 'plan' | 'repo-search'; payload: ChatRepoStreamRequest }
  | { operationKind: 'repo-agent'; payload: ChatRepoAgentStreamRequest };

function openOwnedSubmissionStream(
  sessionId: string,
  submission: OwnedChatSubmission,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  switch (submission.operationKind) {
    case 'message': return streamChatMessage(sessionId, submission.payload, signal);
    case 'plan': return streamPlanMessage(sessionId, submission.payload, signal);
    case 'repo-search': return streamRepoSearchMessage(sessionId, submission.payload, signal);
    case 'repo-agent': return streamRepoAgentMessage(sessionId, submission.payload, signal);
  }
}

export type CreateChatSessionRequest = {
  title: string;
  presetId?: string;
};

export function pickFirstSessionId(sessions: readonly ChatSessionSummary[]): string {
  return sessions[0]?.id ?? '';
}

export function findSessionByIdStrict(sessions: readonly ChatSessionSummary[], sessionId: string): ChatSessionSummary {
  const found = sessions.find((session) => session.id === sessionId);
  if (!found) {
    throw new Error(`useChatSessions: unknown session id "${sessionId}"`);
  }
  return found;
}

/** The rail's view of a full session; the schema drops the transcript for us. */
export function summarizeChatSession(session: ChatSession): ChatSessionSummary {
  const last = session.messages[session.messages.length - 1];
  return ChatSessionSummarySchema.parse({ ...session, lastToolCallExitCode: last?.toolCallExitCode ?? null });
}

export function upsertSession(sessions: readonly ChatSessionSummary[], updated: ChatSession): ChatSessionSummary[] {
  const summary = summarizeChatSession(updated);
  const index = sessions.findIndex((s) => s.id === updated.id);
  if (index < 0) {
    return [summary, ...sessions];
  }
  const next = sessions.slice();
  next[index] = summary;
  return next;
}

export function useChatSessions(deps: {
  initialSelectedSessionId: string;
  refreshToken: number;
  buildCreateSessionRequest(): CreateChatSessionRequest | null;
  confirmDeleteSession(): boolean;
  enqueueToast(level: ToastLevel, text: string): void;
}) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  // Transcripts fetched this page-load, by id. A session is fetched once and then read from here.
  const [loadedSessions, setLoadedSessions] = useState<ReadonlyMap<string, ChatSession>>(new Map());
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(deps.initialSelectedSessionId);
  const selectedSessionIdRef = useLatest(selectedSessionId);
  // Runtime state lives outside React so a streamed token re-renders only its subscribers.
  const [runtimeHub] = useState(() => new ChatRuntimeHub());
  // The detail effect deliberately depends on the selection alone, so it reads the transcript map
  // through a ref: the "already loaded" answer it acts on is the current one, not a captured one.
  const loadedSessionsRef = useLatest(loadedSessions);
  // The sessions whose stream this client is draining itself. A ref, not state: it is a fact about
  // in-flight work, read at the instant the attach effect runs, and no render displays it. The
  // effect must not read activity instead — it writes activity, so that guard would be circular.
  const ownedSubmissions = useRef(new Map<string, { submission: OwnedChatSubmission; controller: AbortController }>());
  const queueSubmissions = useRef(new Map<string, ChatQueueEnqueueRequest>());
  const forceSubmissions = useRef(new Map<string, ChatQueueForceRequest>());
  const queueMutations = useRef(new Set<string>());
  const queueOperationIds = useRef(new Map<string, string | null>());
  const pendingTerminalTransitions = useRef(new Map<string, Extract<ChatSessionRuntimeTransition, { kind: 'terminal' }>>());

  useEffect(() => () => {
    for (const owned of ownedSubmissions.current.values()) owned.controller.abort();
    ownedSubmissions.current.clear();
  }, []);
  // Bumped when a submitted turn is rejected because the session is already running elsewhere.
  // Nothing else tells the attach effect that a run it should follow now exists.
  const [remoteRunGeneration, setRemoteRunGeneration] = useState(0);
  const selectedSession = loadedSessions.get(selectedSessionId) ?? null;
  const selectedSessionLoading = selectedSessionId !== '' && loadingSessionId === selectedSessionId;
  // A loaded session always has a runtime: its detail may land before the listing seeds the store.
  function storeSession(session: ChatSession): void {
    setLoadedSessions((previous) => new Map(previous).set(session.id, session));
    setSessions((previous) => upsertSession(previous, session));
    runtimeHub.ensureSession(session.id, session.planRepoRoot);
  }

  /** A session without a runtime (never listed, or deleted) has nowhere to show its error. */
  function recordSessionError(sessionId: string, error: Error): void {
    if (!runtimeHub.getStore().has(sessionId)) {
      deps.enqueueToast('error', error.message);
      return;
    }
    runtimeHub.apply({ kind: 'failure', sessionId, message: error.message });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [response, active] = await Promise.all([getChatSessions(), listActiveChatOperations()]);
        if (cancelled) {
          return;
        }
        setSessions(response.sessions);
        const busyKindBySessionId = new Map(
          active.operations.map((operation) => [operation.sessionId, operation.operationKind] as const),
        );
        for (const session of response.sessions) {
          runtimeHub.ensureSession(session.id, session.planRepoRoot);
          if (response.recovery) runtimeHub.apply({ kind: 'recovery', sessionId: session.id,
            reports: response.recovery.filter(report => report.sessionId === session.id) });
          const busyKind = busyKindBySessionId.get(session.id) ?? null;
          // The rail reads this; a client-owned stream already reports itself and must not be
          // downgraded to remote, and a session that has since finished must stop showing busy.
          if (runtimeHub.getStore().get(session.id).activity.kind === 'local') {
            continue;
          }
          runtimeHub.apply(busyKind
            ? { kind: 'remote-begin', sessionId: session.id, operationKind: busyKind }
            : { kind: 'remote-clear', sessionId: session.id });
        }
        // Prefer a session that is actually running: a run in flight never touches updatedAtUtc,
        // so the busy session is usually not the first one the listing returns. The listing has
        // no order of its own, so the longest-running operation decides.
        const oldestRunning = [...active.operations]
          .sort((left, right) => left.startedAtUtc.localeCompare(right.startedAtUtc))[0];
        const firstId = oldestRunning?.sessionId || pickFirstSessionId(response.sessions);
        // A URL can name a session deleted since; only a listed or already-loaded one stays selected.
        setSelectedSessionId((current) => (
          response.sessions.some((session) => session.id === current) || loadedSessionsRef.current.has(current) ? current : firstId
        ));
      } catch (error) {
        if (!cancelled) {
          recordSessionError(selectedSessionIdRef.current, toError(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deps.refreshToken]);

  useEffect(() => {
    if (!selectedSessionId || loadedSessionsRef.current.has(selectedSessionId)) {
      return;
    }
    let cancelled = false;
    setLoadingSessionId(selectedSessionId);
    void Promise.all([
      getChatSession(selectedSessionId),
      getActiveRepoAgentRun(selectedSessionId),
    ])
      .then(([response, activeRun]) => {
        if (cancelled) {
          return;
        }
        applySessionResponse(response);
        if (activeRun) {
          runtimeHub.apply({ kind: 'repo-agent-approval-mode', sessionId: response.session.id, approval: activeRun.approvalMode });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          recordSessionError(selectedSessionId, toError(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSessionId((current) => (current === selectedSessionId ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  // Both the listing and storeSession seed the runtime store, so a runtime exists exactly when
  // the selected session does.
  const selectedLoaded = selectedSession !== null;

  useEffect(() => {
    if (!selectedSessionId || !selectedLoaded) return;
    const sessionId = selectedSessionId;
    const controller = new AbortController();
    let lastOperationId: string | null | undefined;
    void (async () => {
      try {
        for await (const event of streamChatQueue(sessionId, controller.signal)) {
          if (controller.signal.aborted) return;
          if (event.kind === 'error') {
            runtimeHub.apply({ kind: 'control-error', sessionId, message: event.error });
            continue;
          }
          const queue = event.queue;
          if (queue.sessionId !== sessionId) throw new Error('Queue session mismatch.');
          runtimeHub.apply({ kind: 'queue', sessionId, queue });
          queueOperationIds.current.set(sessionId, queue.activeOperationId ?? null);
          if (lastOperationId !== queue.activeOperationId) {
            lastOperationId = queue.activeOperationId;
            if (queue.activeOperationId) setRemoteRunGeneration((generation) => generation + 1);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) runtimeHub.apply({ kind: 'control-error', sessionId, message: toError(error).message });
      }
    })();
    return () => controller.abort();
  }, [selectedSessionId, selectedLoaded]);

  useEffect(() => {
    // A turn this client started already renders its own frames; latching on again would double
    // every one of them.
    if (!selectedSessionId || selectedSession === null || ownedSubmissions.current.has(selectedSessionId)) {
      return;
    }
    const sessionId = selectedSessionId;
    const thinkingEnabled = selectedSession.thinkingEnabled !== false;
    const controller = new AbortController();
    let cancelled = false;
    let attached = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => { if (!cancelled) setRemoteRunGeneration(generation => generation + 1); }, CHAT_ATTACH_RECONNECT_MS);
    };
    const reconnectAfterError = (error: Error): void => {
      if (cancelled) return;
      runtimeHub.apply({ kind: 'control-error', sessionId, message: error.message });
      scheduleReconnect();
    };
    const refreshSession = async (): Promise<boolean> => {
      const response = await getChatSession(sessionId);
      if (cancelled) {
        return false;
      }
      applySessionResponse(response);
      return !response.recovery?.some(report => report.status === 'recovery_failed');
    };
    void (async () => {
      try {
        for await (const transition of toRuntimeTransitions(
          sessionId,
          { kind: 'attached' },
          attachChatOperationStream(sessionId, controller.signal),
          thinkingEnabled,
        )) {
          if (cancelled) {
            return;
          }
          if (transition.kind === 'terminal') {
            // The stored session replaces the live view; refresh it first so the transcript never blanks.
            try {
              await refreshSession();
              pendingTerminalTransitions.current.delete(sessionId);
              if (!cancelled) runtimeHub.apply(transition);
            } catch (error) {
              pendingTerminalTransitions.current.set(sessionId, transition);
              reconnectAfterError(toError(error));
            }
            continue;
          }
          runtimeHub.apply(transition);
          if (transition.kind === 'snapshot') {
            attached = true;
          }
          if (transition.kind === 'failure' || transition.kind === 'interrupted') {
            try { if (await refreshSession()) scheduleReconnect(); }
            catch (error) { reconnectAfterError(toError(error)); }
          }
        }
        attached = false;
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof ChatOperationIdleError)) { reconnectAfterError(toError(error)); return; }
        // Nothing is running. A session last seen busy may have finished while this client was
        // away, so refetch it; otherwise the transcript loaded this page-load is reused.
        if (runtimeHub.getStore().get(sessionId).activity.kind !== 'idle') {
          try { await refreshSession(); }
          catch (error) { reconnectAfterError(toError(error)); return; }
        }
        const pendingTerminal = pendingTerminalTransitions.current.get(sessionId);
        if (pendingTerminal) {
          pendingTerminalTransitions.current.delete(sessionId);
          runtimeHub.apply(pendingTerminal);
        }
        if (cancelled) {
          return;
        }
        runtimeHub.apply({ kind: 'approval-clear', sessionId }, { kind: 'remote-clear', sessionId });
      }
    })();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      controller.abort();
      // Aborting mid-stream leaves the session marked as streamed by this client with nothing
      // behind it. Un-own it, or it reports itself busy forever and no later attach can take it.
      if (attached) {
        runtimeHub.apply({ kind: 'detach', sessionId });
      }
    };
  }, [selectedSessionId, selectedLoaded, remoteRunGeneration]);

  function applySessionResponse(response: ChatSessionResponse): void {
    storeSession(response.session);
    runtimeHub.apply(
      { kind: 'context-usage', sessionId: response.session.id, contextUsage: response.contextUsage },
      ...(response.recovery ? [{ kind: 'recovery' as const, sessionId: response.session.id, reports: response.recovery }] : []),
    );
  }

  function failSessionOperation(sessionId: string, message: string): void {
    runtimeHub.apply({ kind: 'failure', sessionId, message });
  }

  function setSessionDraft(sessionId: string, draft: string): void {
    runtimeHub.apply({ kind: 'draft', sessionId, draft });
  }

  function setSessionImages(sessionId: string, images: PendingImage[]): void {
    runtimeHub.apply({ kind: 'images', sessionId, images });
  }

  function appendSessionImages(sessionId: string, images: PendingImage[]): void {
    runtimeHub.apply({ kind: 'append-images', sessionId, images });
  }

  function setSessionPlanInputs(sessionId: string, planRepoRootInput: string, planMaxTurnsInput: string): void {
    runtimeHub.apply({ kind: 'plan-inputs', sessionId, planRepoRootInput, planMaxTurnsInput });
    if (runtimeHub.getStore().get(sessionId).error === PLAN_MAX_TURNS_VALIDATION_ERROR
      && PlanMaxTurnsOverrideSchema.safeParse(planMaxTurnsInput).success) {
      runtimeHub.apply({ kind: 'control-error', sessionId, message: null });
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      const response = await getChatSessions();
      setSessions(response.sessions);
      for (const session of response.sessions) {
        runtimeHub.ensureSession(session.id, session.planRepoRoot);
      }
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
      setSelectedSessionId(response.session.id);
      runtimeHub.ensureSession(response.session.id, response.session.planRepoRoot);
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
      const remaining = sessions.filter((session) => session.id !== selectedSessionId);
      setSessions(remaining);
      setLoadedSessions((previous) => { const next = new Map(previous); next.delete(selectedSessionId); return next; });
      setSelectedSessionId(pickFirstSessionId(remaining));
      runtimeHub.removeSession(selectedSessionId);
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
    submission: OwnedChatSubmission,
  ): Promise<void> {
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    const controller = new AbortController();
    ownedSubmissions.current.set(sessionId, { submission, controller });
    let ownedElsewhere = false;
    let retryTerminalRefresh = false;
    try {
      while (!controller.signal.aborted) {
        const stream = openOwnedSubmissionStream(sessionId, submission, controller.signal);
        let interrupted = false;
        for await (const transition of toRuntimeTransitions(
          sessionId,
          { kind: 'owned', operationKind: submission.operationKind, operationId: submission.payload.operationId,
            submissionId: submission.payload.submissionId },
          stream,
          thinkingEnabled,
        )) {
          if (transition.kind === 'terminal') {
            runtimeHub.apply({ kind: 'submission-phase', sessionId,
              submissionId: submission.payload.submissionId, phase: 'settling' });
            try {
              applySessionResponse(await getChatSession(sessionId));
              pendingTerminalTransitions.current.delete(sessionId);
              runtimeHub.apply(transition);
            } catch (error) {
              pendingTerminalTransitions.current.set(sessionId, transition);
              runtimeHub.apply({ kind: 'control-error', sessionId, message: toError(error).message });
              retryTerminalRefresh = true;
            }
            continue;
          }
          runtimeHub.apply(...ownedStreamTransitions(transition, sessionId, submission.payload.submissionId));
          if (transition.kind === 'interrupted') interrupted = true;
          if (transition.kind === 'failure' || transition.kind === 'remote-begin') ownedElsewhere = true;
        }
        if (!interrupted || retryTerminalRefresh || ownedElsewhere) break;
        await waitForAbortableDelay(controller.signal, CHAT_ATTACH_RECONNECT_MS);
      }
    } finally {
      const owner = ownedSubmissions.current.get(sessionId);
      if (owner?.submission.payload.submissionId === submission.payload.submissionId) {
        ownedSubmissions.current.delete(sessionId);
      }
      controller.abort();
      const queuedOperationId = queueOperationIds.current.get(sessionId);
      if (retryTerminalRefresh || ownedElsewhere || (queuedOperationId && queuedOperationId !== submission.payload.operationId)) {
        setRemoteRunGeneration((generation) => generation + 1);
      }
    }
  }

  function readRuntimeInputs(sessionId: string): {
    draft: string;
    pendingImages: PendingImage[];
    planRepoRootInput: string;
    planMaxTurnsInput: string;
    repoAgentApprovalMode: ApprovalMode;
  } {
    const runtime = runtimeHub.getStore().get(sessionId);
    return {
      draft: runtime.draft.trim(),
      pendingImages: runtime.pendingImages,
      planRepoRootInput: runtime.planRepoRootInput,
      planMaxTurnsInput: runtime.planMaxTurnsInput,
      repoAgentApprovalMode: runtime.repoAgentApprovalMode,
    };
  }

  function submitRuntimeInputs(sessionId: string, content: string, images: PendingImage[], submissionId: string): void {
    runtimeHub.apply({ kind: 'submit', sessionId, content, images, submissionId });
  }

  function parseSessionMaxTurnsOverride(sessionId: string, input: string): ParsedMaxTurnsOverride | null {
    try {
      return parsePlanMaxTurnsOverride(input);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== PLAN_MAX_TURNS_VALIDATION_ERROR) {
        throw error;
      }
      runtimeHub.apply({ kind: 'control-error', sessionId, message: error.message });
      return null;
    }
  }

  async function sendMessage(): Promise<void> {
    if (!selectedSession) {
      return;
    }
    const inputs = readRuntimeInputs(selectedSession.id);
    if (!inputs.draft && inputs.pendingImages.length === 0) {
      return;
    }
    if (shouldQueue(selectedSession.id)) { await queueMessage('message'); return; }
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
    const operationId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    submitRuntimeInputs(selectedSession.id, inputs.draft, inputs.pendingImages, submissionId);
    await runChatStream(selectedSession.id, {
      operationKind: 'message',
      payload: {
        content: inputs.draft,
        images: inputs.pendingImages.map((image) => image.dataUrl),
        operationId,
        submissionId,
      },
    });
  }

  async function sendPlan(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    if (shouldQueue(session.id)) { await queueMessage('plan'); return; }
    const maxTurnsOverride = parseSessionMaxTurnsOverride(session.id, inputs.planMaxTurnsInput);
    if (!maxTurnsOverride) {
      return;
    }
    const operationId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages, submissionId);
    await runChatStream(session.id, { operationKind: 'plan', payload: {
      content: inputs.draft, images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot), ...maxTurnsOverride,
      operationId, submissionId,
    } });
  }

  async function sendRepoSearch(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    if (shouldQueue(session.id)) { await queueMessage('repo-search'); return; }
    const maxTurnsOverride = parseSessionMaxTurnsOverride(session.id, inputs.planMaxTurnsInput);
    if (!maxTurnsOverride) {
      return;
    }
    const operationId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages, submissionId);
    await runChatStream(session.id, { operationKind: 'repo-search', payload: {
      content: inputs.draft, images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot), ...maxTurnsOverride,
      operationId, submissionId,
    } });
  }

  async function sendRepoAgent(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    if (shouldQueue(session.id)) { await queueMessage('repo-agent'); return; }
    const maxTurnsOverride = parseSessionMaxTurnsOverride(session.id, inputs.planMaxTurnsInput);
    if (!maxTurnsOverride) {
      return;
    }
    const operationId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages, submissionId);
    await runChatStream(session.id, { operationKind: 'repo-agent', payload: {
      content: inputs.draft, images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot), approval: inputs.repoAgentApprovalMode,
      ...maxTurnsOverride, operationId, submissionId,
    } });
  }

  async function submitRepoAgentDecision(decision: RepoAgentDecision): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    await decideRepoAgent(session.id, decision);
  }

  async function answerQuestion(reply: ChatQuestionReply): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const question = runtimeHub.getStore().getLive(session.id).journalSnapshot?.question;
    if (!question?.actionable) return;
    try {
      await answerChatQuestion(session.id, { questionId: question.questionId, reply });
    } catch (error) {
      recordSessionError(session.id, toError(error));
    }
  }

  function shouldQueue(sessionId: string): boolean {
    const runtime = runtimeHub.getStore().get(sessionId);
    return isSessionBusy(runtime) || Boolean(runtime.queue?.messages.some((message) => message.state === 'pending'));
  }

  async function refreshQueue(sessionId: string): Promise<void> {
    const { queue } = await getChatQueue(sessionId);
    runtimeHub.apply({ kind: 'queue', sessionId, queue });
  }

  async function queueMessage(operationKind: ChatQueueOperationKind): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    if (queueMutations.current.has(session.id)) return;
    const inputs = readRuntimeInputs(session.id);
    const maxTurns = operationKind === 'message' ? {} : parseSessionMaxTurnsOverride(session.id, inputs.planMaxTurnsInput);
    if (!maxTurns) return;
    const body = {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      options: { operationKind, repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot), approval: inputs.repoAgentApprovalMode, ...maxTurns },
    };
    const runtime = runtimeHub.getStore().get(session.id);
    const afterOperationId = runtime.activity.kind === 'local' ? runtime.activity.operationId : runtime.queue?.activeOperationId ?? undefined;
    const previous = queueSubmissions.current.get(session.id);
    const request = previous && JSON.stringify({ content: previous.content, images: previous.images, options: previous.options }) === JSON.stringify(body)
      ? previous : { id: crypto.randomUUID(), ...body, ...(afterOperationId ? { afterOperationId } : {}) };
    queueSubmissions.current.set(session.id, request);
    queueMutations.current.add(session.id);
    try {
      const { queue } = await enqueueChatMessage(session.id, request);
      runtimeHub.apply({ kind: 'queue', sessionId: session.id, queue }, { kind: 'queued-submit', sessionId: session.id, content: inputs.draft, images: inputs.pendingImages });
      queueSubmissions.current.delete(session.id);
    } catch (error) {
      runtimeHub.apply({ kind: 'control-error', sessionId: session.id, message: toError(error).message });
    } finally { queueMutations.current.delete(session.id); }
  }

  async function forceQueue(): Promise<void> {
    const sessionId = selectedSessionId;
    if (!sessionId || queueMutations.current.has(sessionId)) return;
    const runtime = runtimeHub.getStore().get(sessionId);
    const operationId = runtime.queue?.activeOperationId ?? (runtime.activity.kind === 'local' ? runtime.activity.operationId : null);
    const request = forceSubmissions.current.get(sessionId) ?? { id: crypto.randomUUID(), operationId };
    forceSubmissions.current.set(sessionId, request);
    queueMutations.current.add(sessionId);
    try {
      const { queue } = await forceChatQueue(sessionId, request);
      runtimeHub.apply({ kind: 'queue', sessionId, queue });
      forceSubmissions.current.delete(sessionId);
      setRemoteRunGeneration((generation) => generation + 1);
    } catch (error) {
      runtimeHub.apply({ kind: 'control-error', sessionId, message: toError(error).message });
      if (error instanceof ChatQueueRejectedError) {
        runtimeHub.apply({ kind: 'queue', sessionId, queue: error.response.queue });
        forceSubmissions.current.delete(sessionId);
      }
    } finally { queueMutations.current.delete(sessionId); }
  }

  async function editQueueMessage(id: string, content: string, revision: number): Promise<void> {
    const sessionId = selectedSessionId;
    try {
      const { queue } = await editQueuedChatMessage(sessionId, id, content, revision);
      runtimeHub.apply({ kind: 'queue', sessionId, queue });
    } catch (error) { await refreshQueue(sessionId); throw error; }
  }

  async function removeQueueMessage(id: string): Promise<void> {
    const sessionId = selectedSessionId;
    try {
      const { queue } = await removeQueuedChatMessage(sessionId, id);
      runtimeHub.apply({ kind: 'queue', sessionId, queue });
    } catch (error) { await refreshQueue(sessionId); throw error; }
  }

  async function setRepoAgentApprovalMode(approval: ApprovalMode): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const runtime = runtimeHub.getStore().get(session.id);
    const previous = runtime.repoAgentApprovalMode;
    runtimeHub.apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval });
    if (!hasActiveRepoAgentRun(runtime)) {
      return;
    }
    try {
      await updateRepoAgentApprovalMode(session.id, approval);
    } catch (error) {
      runtimeHub.apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval: previous }, { kind: 'control-error', sessionId: session.id, message: toError(error).message });
    }
  }

  async function stopOperation(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    const activity = runtimeHub.getStore().get(selectedSessionId).activity;
    if (activity.kind !== 'local') {
      return;
    }
    try {
      await stopChatOperation(selectedSessionId, activity.operationId);
    } catch (error) {
      runtimeHub.apply({
        kind: 'control-error',
        sessionId: selectedSessionId,
        message: toError(error).message,
      });
    }
  }

  return {
    sessions,
    selectedSessionId,
    selectedSession,
    selectedSessionLoading,
    runtimeHub,
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
    answerQuestion,
    setRepoAgentApprovalMode,
    stopOperation,
    forceQueue,
    editQueueMessage,
    removeQueueMessage,
    loadQueueMessage: (id: string) => getQueuedChatMessage(selectedSessionId, id),
  };
}

export type UseChatSessionsResult = ReturnType<typeof useChatSessions>;
