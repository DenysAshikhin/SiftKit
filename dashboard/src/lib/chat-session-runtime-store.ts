import {
  buildLiveUserMessage,
  LIVE_USER_MESSAGE_ID,
  upsertLiveMessageInto,
} from './chat-live-messages';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';
import {
  reduceChatTranscript,
  DEFAULT_APPROVAL_MODE,
  type ApprovalMode,
  type ChatStreamApproval,
  type ChatStreamProgress,
  type ChatStreamPromptEvent,
  type ChatStreamTextDelta,
  type ChatStreamUsageEvent,
  type ChatTranscriptEvent,
  type ChatMessageQueueState,
  type ChatStreamQueuedUserMessage,
  type ChatOperationSnapshot,
  type ChatRecoveryStatus,
  type ChatRecoveryReport,
} from '@siftkit/contracts';
import type { PendingImage } from './downscale-image';
import type { RepoAgentDecision } from '../api';

export type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'local'; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'remote'; operationKind: ChatSessionOperationKind };

export type SubmittedChatInput = { content: string; images: PendingImage[] };
export type ResolvedRepoAgentApproval = {
  approval: ChatStreamApproval;
  decision: RepoAgentDecision;
  decidedAtUtc: string;
};

export type ChatSessionRuntime = {
  journalSnapshot: ChatOperationSnapshot | null;
  recoveryStatus: ChatRecoveryStatus;
  tokenTurns: ReadonlyMap<number, LiveTokenTurn>;
  queue: ChatMessageQueueState | null;
  sessionId: string;
  activity: ChatSessionActivity;
  liveMessages: ChatMessage[];
  error: string | null;
  warnings: string[];
  contextUsage: ContextUsage | null;
  /** The backend-measured context the running turn generates against; null before its frame. */
  liveTokenBase: ChatStreamPromptEvent | null;
  /** Streamed text characters since that base; sizes the in-flight tail on top of it. */
  streamedCharsSinceBase: number;
  draft: string;
  pendingImages: PendingImage[];
  submittedInput: SubmittedChatInput | null;
  /** The submitted turn has produced nothing yet; cleared by the first streamed evidence. */
  awaitingResponse: boolean;
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  pendingApproval: ChatStreamApproval | null;
  resolvedApproval: ResolvedRepoAgentApproval | null;
  repoAgentApprovalMode: ApprovalMode;
};

type LiveTokenTurn = {
  prompt: ChatStreamPromptEvent | null;
  usage: ChatStreamUsageEvent | null;
};

export type ChatSessionRuntimeTransition =
  | { kind: 'recovery'; sessionId: string; reports: ChatRecoveryReport[] }
  | { kind: 'snapshot'; sessionId: string; snapshot: ChatOperationSnapshot }
  | { kind: 'queue'; sessionId: string; queue: ChatMessageQueueState }
  | { kind: 'queued-user'; sessionId: string; message: ChatStreamQueuedUserMessage }
  | { kind: 'queued-submit'; sessionId: string; content: string; images: PendingImage[] }
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'attach'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'user-turn'; sessionId: string; content: string; images: string[] }
  | { kind: 'detach'; sessionId: string }
  | { kind: 'remote-begin'; sessionId: string; operationKind: ChatSessionOperationKind }
  | { kind: 'remote-clear'; sessionId: string }
  | { kind: 'thinking'; sessionId: string; delta: ChatStreamTextDelta }
  | { kind: 'narration'; sessionId: string; delta: ChatStreamTextDelta }
  | { kind: 'tool'; sessionId: string; toolEvent: ChatStreamToolEvent }
  | { kind: 'progress'; sessionId: string; progress: ChatStreamProgress }
  | { kind: 'approval'; sessionId: string; approval: ChatStreamApproval }
  | { kind: 'approval-decision'; sessionId: string; resolution: ResolvedRepoAgentApproval }
  | { kind: 'approval-clear'; sessionId: string }
  | { kind: 'answer'; sessionId: string; delta: ChatStreamTextDelta }
  | { kind: 'warning'; sessionId: string; text: string }
  | { kind: 'submit'; sessionId: string; content: string; images: PendingImage[] }
  | { kind: 'done'; sessionId: string; response: ChatSessionResponse }
  | { kind: 'failure'; sessionId: string; message: string; issue?: import('@siftkit/contracts').ChatRecoveryIssue }
  | { kind: 'control-error'; sessionId: string; message: ChatSessionRuntime['error'] }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'usage'; sessionId: string; usage: ChatStreamUsageEvent }
  | { kind: 'prompt'; sessionId: string; prompt: ChatStreamPromptEvent }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: PendingImage[] }
  | { kind: 'append-images'; sessionId: string; images: PendingImage[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string }
  | { kind: 'repo-agent-approval-mode'; sessionId: string; approval: ApprovalMode };

function createChatSessionRuntime(sessionId: string, planRepoRootInput: string): ChatSessionRuntime {
  return {
    sessionId,
    journalSnapshot: null,
    recoveryStatus: 'ok',
    queue: null,
    activity: { kind: 'idle' },
    liveMessages: [],
    tokenTurns: new Map(),
    error: null,
    warnings: [],
    contextUsage: null,
    liveTokenBase: null,
    streamedCharsSinceBase: 0,
    draft: '',
    pendingImages: [],
    submittedInput: null,
    awaitingResponse: false,
    planRepoRootInput,
    planMaxTurnsInput: '',
    pendingApproval: null,
    resolvedApproval: null,
    repoAgentApprovalMode: DEFAULT_APPROVAL_MODE,
  };
}

/** The live view of a turn, which stops being true the moment a stream stops feeding this session. */
function clearedLiveTurn(): Pick<
  ChatSessionRuntime,
  'liveMessages' | 'tokenTurns' | 'submittedInput' | 'awaitingResponse' | 'pendingApproval' | 'resolvedApproval'
> {
  return {
    liveMessages: [],
    tokenTurns: new Map(),
    submittedInput: null,
    awaitingResponse: false,
    pendingApproval: null,
    resolvedApproval: null,
  };
}

function applyTranscriptEvent(
  runtime: ChatSessionRuntime,
  event: ChatTranscriptEvent,
): ChatSessionRuntime {
  return {
    ...runtime,
    awaitingResponse: false,
    liveMessages: reduceChatTranscript(runtime.liveMessages, event, {
      messageIdPrefix: 'live',
      sourceRunId: null,
      createdAtUtc: new Date().toISOString(),
    }),
  };
}

function applyToolEvent(runtime: ChatSessionRuntime, toolEvent: ChatStreamToolEvent): ChatSessionRuntime {
  return applyTranscriptEvent(runtime, { kind: 'tool', tool: toolEvent });
}

function applyTransition(
  runtime: ChatSessionRuntime,
  transition: ChatSessionRuntimeTransition,
): ChatSessionRuntime {
  switch (transition.kind) {
    case 'recovery': {
      if (transition.reports.some(report => report.sessionId !== runtime.sessionId)) throw new Error('Chat recovery report session mismatch.');
      const recoveryStatus = transition.reports.some(report => report.status === 'recovery_failed') ? 'recovery_failed'
        : transition.reports.some(report => report.status === 'recovery_needed') ? 'recovery_needed' : 'ok';
      return { ...runtime, recoveryStatus };
    }
    case 'snapshot': {
      const snapshot = transition.snapshot;
      if (snapshot.sessionId !== runtime.sessionId || !snapshot.complete) throw new Error('Invalid chat runtime snapshot.');
      const previous = runtime.journalSnapshot;
      if (previous && (snapshot.runOrder < previous.runOrder
        || snapshot.operationId === previous.operationId && snapshot.cursor.sequence < previous.cursor.sequence)) return runtime;
      if (runtime.activity.kind === 'local' && previous && previous.controlOperationId !== runtime.activity.operationId
        && snapshot.operationId === previous.operationId) return runtime;
      const activity: ChatSessionActivity = snapshot.terminalCause !== null ? { kind: 'idle' }
        : snapshot.controlOperationId !== null ? { kind: 'local', operationKind: snapshot.operationKind, operationId: snapshot.controlOperationId }
          : { kind: 'remote', operationKind: snapshot.operationKind };
      return { ...runtime, journalSnapshot: snapshot, recoveryStatus: snapshot.status, activity, liveMessages: snapshot.messages,
        awaitingResponse: false, submittedInput: null,
        pendingApproval: snapshot.approval?.actionable ? snapshot.approval : null,
        tokenTurns: new Map(snapshot.tokenTurns.map(turn => [turn.turn, { prompt: turn.prompt, usage: turn.usage }])),
        liveTokenBase: [...snapshot.tokenTurns].reverse().find(turn => turn.prompt !== null)?.prompt ?? null,
        streamedCharsSinceBase: snapshot.streamedCharsSinceBase, warnings: snapshot.warnings,
        error: snapshot.status === 'recovery_failed' ? 'Chat recovery requires repair before continuing.' : null };
    }
    case 'queue':
      if (transition.queue.sessionId !== runtime.sessionId) throw new Error('Queue session mismatch.');
      return runtime.queue && runtime.queue.revision > transition.queue.revision
        ? runtime : { ...runtime, queue: transition.queue };
    case 'queued-user':
      return applyTranscriptEvent(runtime, { kind: 'user_message', message: transition.message });
    case 'queued-submit':
      return {
        ...runtime,
        error: null,
        draft: runtime.draft.trim() === transition.content ? '' : runtime.draft,
        pendingImages: runtime.pendingImages.filter((image) => !transition.images.includes(image)),
      };
    case 'begin':
      // A new run measures its own prompt: the previous run's base counts a context this one
      // no longer generates against, so the bar would restart behind itself if it survived.
      return {
        ...runtime,
        activity: {
          kind: 'local',
          operationKind: transition.operationKind,
          operationId: transition.operationId,
        },
        liveTokenBase: null,
        tokenTurns: new Map(),
        streamedCharsSinceBase: 0,
      };
    case 'attach':
      // Adopting a run in flight: the replay that follows rebuilds the whole live transcript, so
      // anything left over from a previous view of this session would be counted twice. The draft
      // and pending images are the user's unsent work and survive.
      return {
        ...runtime,
        ...clearedLiveTurn(),
        activity: {
          kind: 'local',
          operationKind: transition.operationKind,
          operationId: transition.operationId,
        },
        warnings: [],
        error: null,
        liveTokenBase: null,
        streamedCharsSinceBase: 0,
      };
    // The server's copy of the prompt. Upserting by the shared live id keeps this idempotent for
    // the client that already inserted the bubble on submit.
    case 'user-turn':
      return {
        ...runtime,
        awaitingResponse: true,
        liveMessages: upsertLiveMessageInto(
          runtime.liveMessages,
          buildLiveUserMessage(transition.content, transition.images),
        ),
      };
    // This client is no longer reading a stream for the session: the operation ended without a
    // payload, or the reader was aborted. Either way the live view it built is no longer current.
    case 'detach':
      return { ...runtime, liveMessages: runtime.liveMessages.filter(message => message.id !== LIVE_USER_MESSAGE_ID),
        activity: { kind: 'idle' }, awaitingResponse: false, pendingApproval: null, error: null };
    case 'remote-begin':
      return { ...runtime, activity: { kind: 'remote', operationKind: transition.operationKind } };
    case 'remote-clear':
      return runtime.activity.kind === 'remote'
        ? { ...runtime, activity: { kind: 'idle' }, error: null }
        : runtime;
    // Every streamed character sizes the in-flight tail, whichever text channel carried it.
    case 'thinking':
    case 'narration':
    case 'answer': {
      const next = applyTranscriptEvent(runtime, { kind: transition.kind, delta: transition.delta });
      return { ...next, streamedCharsSinceBase: next.streamedCharsSinceBase + transition.delta.text.length };
    }
    case 'tool':
      return applyToolEvent(runtime, transition.toolEvent);
    case 'progress':
      return applyTranscriptEvent(runtime, { kind: 'progress', progress: transition.progress });
    case 'approval':
      return { ...runtime, awaitingResponse: false, pendingApproval: transition.approval };
    case 'approval-decision':
      return { ...runtime, pendingApproval: null, resolvedApproval: transition.resolution };
    case 'approval-clear':
      return { ...runtime, pendingApproval: null, resolvedApproval: null };
    case 'warning':
      return { ...runtime, warnings: [...runtime.warnings, transition.text] };
    case 'submit':
      return {
        ...runtime,
        error: null,
        draft: '',
        pendingImages: [],
        submittedInput: { content: transition.content, images: transition.images },
        awaitingResponse: true,
        pendingApproval: null,
        resolvedApproval: null,
        liveMessages: upsertLiveMessageInto(
          runtime.liveMessages,
          buildLiveUserMessage(transition.content, transition.images.map((image) => image.dataUrl)),
        ),
      };
    case 'done':
      return {
        ...runtime,
        ...clearedLiveTurn(),
        journalSnapshot: null,
        activity: { kind: 'idle' },
        contextUsage: transition.response.contextUsage,
        error: null,
      };
    case 'failure':
      return {
        ...runtime,
        recoveryStatus: transition.issue ? 'recovery_failed' : runtime.recoveryStatus,
        liveMessages: runtime.liveMessages.filter(message => message.id !== LIVE_USER_MESSAGE_ID),
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        activity: { kind: 'idle' },
        error: transition.message,
        draft: runtime.draft || runtime.submittedInput?.content || '',
        pendingImages: [...(runtime.submittedInput?.images ?? []), ...runtime.pendingImages],
      };
    case 'control-error':
      return { ...runtime, error: transition.message };
    case 'context-usage':
      return { ...runtime, contextUsage: transition.contextUsage };
    case 'usage': {
      const tokenTurns = new Map(runtime.tokenTurns);
      tokenTurns.set(transition.usage.turn, {
        prompt: tokenTurns.get(transition.usage.turn)?.prompt ?? null,
        usage: transition.usage,
      });
      return applyTranscriptEvent({ ...runtime, tokenTurns }, { kind: 'usage', usage: transition.usage });
    }
    // The turn about to generate measured its own prompt, so the base moves and the tail that
    // sized the previous base is now counted inside it.
    case 'prompt': {
      const tokenTurns = new Map(runtime.tokenTurns);
      tokenTurns.set(transition.prompt.turn, {
        prompt: transition.prompt,
        usage: tokenTurns.get(transition.prompt.turn)?.usage ?? null,
      });
      return { ...runtime, tokenTurns, liveTokenBase: transition.prompt, streamedCharsSinceBase: 0 };
    }
    case 'draft':
      return { ...runtime, draft: transition.draft };
    case 'images':
      return { ...runtime, pendingImages: transition.images };
    case 'append-images':
      return { ...runtime, pendingImages: [...runtime.pendingImages, ...transition.images] };
    case 'plan-inputs':
      return {
        ...runtime,
        planRepoRootInput: transition.planRepoRootInput,
        planMaxTurnsInput: transition.planMaxTurnsInput,
      };
    case 'repo-agent-approval-mode':
      return { ...runtime, repoAgentApprovalMode: transition.approval };
  }
}

export class ChatSessionRuntimeStore {
  private readonly runtimesBySessionId: Map<string, ChatSessionRuntime>;

  constructor(runtimesBySessionId: Map<string, ChatSessionRuntime> = new Map()) {
    this.runtimesBySessionId = runtimesBySessionId;
  }

  /** Readers must name a session that exists; a miss is a bug, not a default. */
  get(sessionId: string): ChatSessionRuntime {
    const runtime = this.runtimesBySessionId.get(sessionId);
    if (!runtime) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    return runtime;
  }

  getAll(): ChatSessionRuntime[] {
    return [...this.runtimesBySessionId.values()];
  }

  /** Seeds the composer repo root from the session so the default directory is visible and editable. */
  ensureSession(sessionId: string, planRepoRootInput: string): ChatSessionRuntimeStore {
    if (this.runtimesBySessionId.has(sessionId)) {
      return this;
    }
    const next = new Map(this.runtimesBySessionId);
    next.set(sessionId, createChatSessionRuntime(sessionId, planRepoRootInput));
    return new ChatSessionRuntimeStore(next);
  }

  /** The single copy-on-write path. The session must have been seeded by ensureSession first. */
  apply(transition: ChatSessionRuntimeTransition): ChatSessionRuntimeStore {
    const next = new Map(this.runtimesBySessionId);
    next.set(transition.sessionId, applyTransition(this.get(transition.sessionId), transition));
    return new ChatSessionRuntimeStore(next);
  }

  removeSession(sessionId: string): ChatSessionRuntimeStore {
    const next = new Map(this.runtimesBySessionId);
    next.delete(sessionId);
    return new ChatSessionRuntimeStore(next);
  }
}
