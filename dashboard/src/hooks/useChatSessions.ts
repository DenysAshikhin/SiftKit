import { useEffect, useRef, useState } from 'react';

import {
  assessImageVramHeadroom,
  estimateVisionPeakVramBytesForImagePixels,
  type ApprovalMode,
  type ChatQueueOperationKind,
  type ChatQueueEnqueueRequest,
  type ChatQueueForceRequest,
} from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.js';
import {
  condenseChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatMessageImage,
  deleteChatSession,
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
import { ChatSessionRuntimeStore, type ChatSessionRuntimeTransition } from '../lib/chat-session-runtime-store';
import { hasActiveRepoAgentRun, isSessionBusy } from '../lib/chat-session-state';
import { toRuntimeTransitions } from '../lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../lib/chat-stream-parser';
import type { ChatSession, ChatSessionResponse, ChatSessionOperationKind } from '../types';
import type { ToastLevel } from './useToasts';
import type { PendingImage } from '../lib/downscale-image';

const CHAT_ATTACH_RECONNECT_MS = 1000;

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
  // The sessions whose stream this client is draining itself. A ref, not state: it is a fact about
  // in-flight work, read at the instant the attach effect runs, and no render displays it. The
  // effect must not read activity instead — it writes activity, so that guard would be circular.
  const ownedStreamSessionIds = useRef<Set<string>>(new Set());
  const queueSubmissions = useRef(new Map<string, ChatQueueEnqueueRequest>());
  const forceSubmissions = useRef(new Map<string, ChatQueueForceRequest>());
  const queueMutations = useRef(new Set<string>());
  const queueOperationIds = useRef(new Map<string, string | null>());
  const pendingTerminalTransitions = useRef(new Map<string, Extract<ChatSessionRuntimeTransition, { kind: 'terminal' }>>());
  // Bumped when a submitted turn is rejected because the session is already running elsewhere.
  // Nothing else tells the attach effect that a run it should follow now exists.
  const [remoteRunGeneration, setRemoteRunGeneration] = useState(0);
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
        const [response, active] = await Promise.all([getChatSessions(), listActiveChatOperations()]);
        if (cancelled) {
          return;
        }
        setSessions(response.sessions);
        const busyKindBySessionId = new Map(
          active.operations.map((operation) => [operation.sessionId, operation.operationKind] as const),
        );
        setRuntimeStore((prev) => {
          let store = prev;
          for (const session of response.sessions) {
            store = store.ensureSession(session.id, session.planRepoRoot);
            if (response.recovery) store = store.apply({ kind: 'recovery', sessionId: session.id,
              reports: response.recovery.filter(report => report.sessionId === session.id) });
            const runtime = store.get(session.id);
            const busyKind = busyKindBySessionId.get(session.id) ?? null;
            // The rail reads this; a client-owned stream already reports itself and must not be
            // downgraded to remote, and a session that has since finished must stop showing busy.
            if (runtime.activity.kind === 'local') {
              continue;
            }
            store = busyKind
              ? store.apply({ kind: 'remote-begin', sessionId: session.id, operationKind: busyKind })
              : store.apply({ kind: 'remote-clear', sessionId: session.id });
          }
          return store;
        });
        if (!selectedSessionId) {
          // Prefer a session that is actually running: a run in flight never touches updatedAtUtc,
          // so the busy session is usually not the first one the listing returns. The listing has
          // no order of its own, so the longest-running operation decides.
          const oldestRunning = [...active.operations]
            .sort((left, right) => left.startedAtUtc.localeCompare(right.startedAtUtc))[0];
          const firstId = oldestRunning?.sessionId || pickFirstSessionId(response.sessions);
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
    void Promise.all([
      getChatSession(selectedSessionId),
      getActiveRepoAgentRun(selectedSessionId),
    ])
      .then(([response, activeRun]) => {
        if (cancelled) {
          return;
        }
        setSessions((previous) => upsertSession(previous, response.session));
        setRuntimeStore((previous) => {
          let withUsage = previous.apply({
            kind: 'context-usage',
            sessionId: response.session.id,
            contextUsage: response.contextUsage,
          });
          if (response.recovery) withUsage = withUsage.apply({ kind: 'recovery', sessionId: response.session.id, reports: response.recovery });
          return activeRun
            ? withUsage.apply({
                kind: 'repo-agent-approval-mode',
                sessionId: response.session.id,
                approval: activeRun.approvalMode,
              })
            : withUsage;
        });
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

  // Sessions are seeded into the runtime store together with the listing, so a runtime exists
  // exactly when the selected session does.
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
            setRuntimeStore(store => store.apply({ kind: 'control-error', sessionId, message: event.error }));
            continue;
          }
          const queue = event.queue;
          if (queue.sessionId !== sessionId) throw new Error('Queue session mismatch.');
          setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue }));
          queueOperationIds.current.set(sessionId, queue.activeOperationId ?? null);
          if (lastOperationId !== queue.activeOperationId) {
            lastOperationId = queue.activeOperationId;
            if (queue.activeOperationId) setRemoteRunGeneration((generation) => generation + 1);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setRuntimeStore((store) => store.apply({ kind: 'control-error', sessionId, message: toError(error).message }));
      }
    })();
    return () => controller.abort();
  }, [selectedSessionId, selectedLoaded]);

  useEffect(() => {
    // A turn this client started already renders its own frames; latching on again would double
    // every one of them.
    if (!selectedSessionId || selectedSession === null || ownedStreamSessionIds.current.has(selectedSessionId)) {
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
      setRuntimeStore(store => store.apply({ kind: 'control-error', sessionId, message: error.message }));
      scheduleReconnect();
    };
    const refreshSession = async (): Promise<boolean> => {
      const response = await getChatSession(sessionId);
      if (cancelled) {
        return false;
      }
      setSessions((previous) => upsertSession(previous, response.session));
      setRuntimeStore((previous) => {
        const next = previous.apply({ kind: 'context-usage', sessionId, contextUsage: response.contextUsage });
        return response.recovery ? next.apply({ kind: 'recovery', sessionId, reports: response.recovery }) : next;
      });
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
              if (!cancelled) setRuntimeStore((previous) => previous.apply(transition));
            } catch (error) {
              pendingTerminalTransitions.current.set(sessionId, transition);
              reconnectAfterError(toError(error));
            }
            continue;
          }
          setRuntimeStore((previous) => previous.apply(transition));
          if (transition.kind === 'snapshot') {
            attached = true;
          }
          if (transition.kind === 'failure') {
            try { if (await refreshSession()) scheduleReconnect(); }
            catch (error) { reconnectAfterError(toError(error)); }
          }
        }
        attached = false;
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof ChatOperationIdleError)) { reconnectAfterError(toError(error)); return; }
        // Nothing is running: the run may have finished while this client was away, so take the
        // stored transcript rather than leaving the session pinned as busy.
        try {
          await refreshSession();
          const pendingTerminal = pendingTerminalTransitions.current.get(sessionId);
          if (pendingTerminal) {
            pendingTerminalTransitions.current.delete(sessionId);
            setRuntimeStore((previous) => previous.apply(pendingTerminal));
          }
        }
        catch (error) { reconnectAfterError(toError(error)); return; }
        if (cancelled) {
          return;
        }
        setRuntimeStore((previous) => previous
          .apply({ kind: 'approval-clear', sessionId })
          .apply({ kind: 'remote-clear', sessionId }));
      }
    })();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      controller.abort();
      // Aborting mid-stream leaves the session marked as streamed by this client with nothing
      // behind it. Un-own it, or it reports itself busy forever and no later attach can take it.
      if (attached) {
        setRuntimeStore((previous) => previous.apply({ kind: 'detach', sessionId }));
      }
    };
  }, [selectedSessionId, selectedLoaded, remoteRunGeneration]);

  function applySessionResponse(response: ChatSessionResponse): void {
    setSessions((previous) => upsertSession(previous, response.session));
    setRuntimeStore((previous) => {
      const next = previous.apply({ kind: 'context-usage', sessionId: response.session.id, contextUsage: response.contextUsage });
      return response.recovery ? next.apply({ kind: 'recovery', sessionId: response.session.id, reports: response.recovery }) : next;
    });
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
    setRuntimeStore((previous) => {
      const next = previous.apply({ kind: 'plan-inputs', sessionId, planRepoRootInput, planMaxTurnsInput });
      return next.get(sessionId).error === PLAN_MAX_TURNS_VALIDATION_ERROR
        && PlanMaxTurnsOverrideSchema.safeParse(planMaxTurnsInput).success
        ? next.apply({ kind: 'control-error', sessionId, message: null })
        : next;
    });
  }

  async function refreshSessions(): Promise<void> {
    try {
      const response = await getChatSessions();
      setSessions(response.sessions);
      setRuntimeStore((prev) => {
        let store = prev;
        for (const session of response.sessions) {
          store = store.ensureSession(session.id, session.planRepoRoot);
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
      setRuntimeStore((prev) => prev.ensureSession(response.session.id, response.session.planRepoRoot));
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
    operationId: string,
    stream: AsyncGenerator<ChatStreamEvent>,
  ): Promise<void> {
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    // Held for the whole turn, so the attach effect leaves this session to the frames rendered here.
    ownedStreamSessionIds.current.add(sessionId);
    let ownedElsewhere = false;
    let retryTerminalRefresh = false;
    let accepted = false;
    try {
      for await (const transition of toRuntimeTransitions(
        sessionId,
        { kind: 'owned', operationKind, operationId },
        stream,
        thinkingEnabled,
      )) {
        if (transition.kind === 'terminal') {
          try {
            applySessionResponse(await getChatSession(sessionId));
            pendingTerminalTransitions.current.delete(sessionId);
            setRuntimeStore((previous) => previous.apply(transition));
          } catch (error) {
            pendingTerminalTransitions.current.set(sessionId, transition);
            setRuntimeStore((previous) => previous.apply({ kind: 'control-error', sessionId, message: toError(error).message }));
            retryTerminalRefresh = true;
          }
          continue;
        }
        setRuntimeStore((previous) => previous.apply(transition));
        if (transition.kind === 'snapshot') accepted = true;
        if (transition.kind === 'failure' && (accepted || queueOperationIds.current.get(sessionId) === operationId)) ownedElsewhere = true;
        if (transition.kind === 'remote-begin') ownedElsewhere = true;
      }
    } finally {
      // Released before the re-arm, so the attach effect cannot run while this session still
      // looks owned and skip the very run it was woken for.
      ownedStreamSessionIds.current.delete(sessionId);
      const queuedOperationId = queueOperationIds.current.get(sessionId);
      if (retryTerminalRefresh || ownedElsewhere || (queuedOperationId && queuedOperationId !== operationId)) {
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
    const runtime = runtimeStore.get(sessionId);
    return {
      draft: runtime.draft.trim(),
      pendingImages: runtime.pendingImages,
      planRepoRootInput: runtime.planRepoRootInput,
      planMaxTurnsInput: runtime.planMaxTurnsInput,
      repoAgentApprovalMode: runtime.repoAgentApprovalMode,
    };
  }

  function submitRuntimeInputs(sessionId: string, content: string, images: PendingImage[]): void {
    setRuntimeStore((previous) => previous.apply({ kind: 'submit', sessionId, content, images }));
  }

  function parseSessionMaxTurnsOverride(sessionId: string, input: string): ParsedMaxTurnsOverride | null {
    try {
      return parsePlanMaxTurnsOverride(input);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== PLAN_MAX_TURNS_VALIDATION_ERROR) {
        throw error;
      }
      setRuntimeStore((previous) => previous.apply({ kind: 'control-error', sessionId, message: error.message }));
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
    submitRuntimeInputs(selectedSession.id, inputs.draft, inputs.pendingImages);
    const operationId = crypto.randomUUID();
    await runChatStream(
      selectedSession.id,
      'message',
      operationId,
      streamChatMessage(selectedSession.id, {
        content: inputs.draft,
        images: inputs.pendingImages.map((image) => image.dataUrl),
        operationId,
      }),
    );
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
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    const operationId = crypto.randomUUID();
    await runChatStream(session.id, 'plan', operationId, streamPlanMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot),
      ...maxTurnsOverride,
      operationId,
    }));
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
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    const operationId = crypto.randomUUID();
    await runChatStream(session.id, 'repo-search', operationId, streamRepoSearchMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot),
      ...maxTurnsOverride,
      operationId,
    }));
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
    submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);
    const operationId = crypto.randomUUID();
    await runChatStream(session.id, 'repo-agent', operationId, streamRepoAgentMessage(session.id, {
      content: inputs.draft,
      images: inputs.pendingImages.map((image) => image.dataUrl),
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot),
      approval: inputs.repoAgentApprovalMode,
      ...maxTurnsOverride,
      operationId,
    }));
  }

  async function submitRepoAgentDecision(decision: RepoAgentDecision): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    await decideRepoAgent(session.id, decision);
  }

  function shouldQueue(sessionId: string): boolean {
    const runtime = runtimeStore.get(sessionId);
    return isSessionBusy(runtime) || Boolean(runtime.queue?.messages.some((message) => message.state === 'pending'));
  }

  async function refreshQueue(sessionId: string): Promise<void> {
    const { queue } = await getChatQueue(sessionId);
    setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue }));
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
    const runtime = runtimeStore.get(session.id);
    const afterOperationId = runtime.activity.kind === 'local' ? runtime.activity.operationId : runtime.queue?.activeOperationId ?? undefined;
    const previous = queueSubmissions.current.get(session.id);
    const request = previous && JSON.stringify({ content: previous.content, images: previous.images, options: previous.options }) === JSON.stringify(body)
      ? previous : { id: crypto.randomUUID(), ...body, ...(afterOperationId ? { afterOperationId } : {}) };
    queueSubmissions.current.set(session.id, request);
    queueMutations.current.add(session.id);
    try {
      const { queue } = await enqueueChatMessage(session.id, request);
      setRuntimeStore((store) => store
        .apply({ kind: 'queue', sessionId: session.id, queue })
        .apply({ kind: 'queued-submit', sessionId: session.id, content: inputs.draft, images: inputs.pendingImages }));
      queueSubmissions.current.delete(session.id);
    } catch (error) {
      setRuntimeStore((store) => store.apply({ kind: 'control-error', sessionId: session.id, message: toError(error).message }));
    } finally { queueMutations.current.delete(session.id); }
  }

  async function forceQueue(): Promise<void> {
    const sessionId = selectedSessionId;
    if (!sessionId || queueMutations.current.has(sessionId)) return;
    const runtime = runtimeStore.get(sessionId);
    const operationId = runtime.queue?.activeOperationId ?? (runtime.activity.kind === 'local' ? runtime.activity.operationId : null);
    const request = forceSubmissions.current.get(sessionId) ?? { id: crypto.randomUUID(), operationId };
    forceSubmissions.current.set(sessionId, request);
    queueMutations.current.add(sessionId);
    try {
      const { queue } = await forceChatQueue(sessionId, request);
      setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue }));
      forceSubmissions.current.delete(sessionId);
      setRemoteRunGeneration((generation) => generation + 1);
    } catch (error) {
      setRuntimeStore((store) => store.apply({ kind: 'control-error', sessionId, message: toError(error).message }));
      if (error instanceof ChatQueueRejectedError) {
        setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue: error.response.queue }));
        forceSubmissions.current.delete(sessionId);
      }
    } finally { queueMutations.current.delete(sessionId); }
  }

  async function editQueueMessage(id: string, content: string, revision: number): Promise<void> {
    const sessionId = selectedSessionId;
    try {
      const { queue } = await editQueuedChatMessage(sessionId, id, content, revision);
      setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue }));
    } catch (error) { await refreshQueue(sessionId); throw error; }
  }

  async function removeQueueMessage(id: string): Promise<void> {
    const sessionId = selectedSessionId;
    try {
      const { queue } = await removeQueuedChatMessage(sessionId, id);
      setRuntimeStore((store) => store.apply({ kind: 'queue', sessionId, queue }));
    } catch (error) { await refreshQueue(sessionId); throw error; }
  }

  async function setRepoAgentApprovalMode(approval: ApprovalMode): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const runtime = runtimeStore.get(session.id);
    const previous = runtime.repoAgentApprovalMode;
    setRuntimeStore((store) => store.apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval }));
    if (!hasActiveRepoAgentRun(runtime)) {
      return;
    }
    try {
      await updateRepoAgentApprovalMode(session.id, approval);
    } catch (error) {
      setRuntimeStore((store) => store
        .apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval: previous })
        .apply({ kind: 'control-error', sessionId: session.id, message: toError(error).message }));
    }
  }

  async function stopOperation(): Promise<void> {
    if (!selectedSessionId) {
      return;
    }
    const activity = runtimeStore.get(selectedSessionId).activity;
    if (activity.kind !== 'local') {
      return;
    }
    try {
      await stopChatOperation(selectedSessionId, activity.operationId);
    } catch (error) {
      setRuntimeStore((previous) => previous.apply({
        kind: 'control-error',
        sessionId: selectedSessionId,
        message: toError(error).message,
      }));
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
    setRepoAgentApprovalMode,
    stopOperation,
    forceQueue,
    editQueueMessage,
    removeQueueMessage,
    loadQueueMessage: (id: string) => getQueuedChatMessage(selectedSessionId, id),
  };
}

export type UseChatSessionsResult = ReturnType<typeof useChatSessions>;
