import {
  buildLiveUserMessage,
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
  type ChatStreamTextDelta,
  type ChatStreamUsageEvent,
  type ChatTranscriptEvent,
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
  sessionId: string;
  activity: ChatSessionActivity;
  liveMessages: ChatMessage[];
  error: string | null;
  warnings: string[];
  contextUsage: ContextUsage | null;
  latestUsage: ChatStreamUsageEvent | null;
  /** Streamed text characters since the last usage frame; sizes the in-flight tail. */
  streamedCharsSinceUsage: number;
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

export type ChatSessionRuntimeTransition =
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string }
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
  | { kind: 'failure'; sessionId: string; message: string }
  | { kind: 'control-error'; sessionId: string; message: string }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'usage'; sessionId: string; usage: ChatStreamUsageEvent }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: PendingImage[] }
  | { kind: 'append-images'; sessionId: string; images: PendingImage[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string }
  | { kind: 'repo-agent-approval-mode'; sessionId: string; approval: ApprovalMode };

function createChatSessionRuntime(sessionId: string, planRepoRootInput: string): ChatSessionRuntime {
  return {
    sessionId,
    activity: { kind: 'idle' },
    liveMessages: [],
    error: null,
    warnings: [],
    contextUsage: null,
    latestUsage: null,
    streamedCharsSinceUsage: 0,
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

function applyUsageEvent(runtime: ChatSessionRuntime, usage: ChatStreamUsageEvent): ChatSessionRuntime {
  const next = applyTranscriptEvent(runtime, { kind: 'usage', usage });
  return { ...next, latestUsage: usage, streamedCharsSinceUsage: 0 };
}

function applyTransition(
  runtime: ChatSessionRuntime,
  transition: ChatSessionRuntimeTransition,
): ChatSessionRuntime {
  switch (transition.kind) {
    case 'begin':
      return {
        ...runtime,
        activity: {
          kind: 'local',
          operationKind: transition.operationKind,
          operationId: transition.operationId,
        },
      };
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
      return { ...next, streamedCharsSinceUsage: next.streamedCharsSinceUsage + transition.delta.text.length };
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
        activity: { kind: 'idle' },
        contextUsage: transition.response.contextUsage,
        liveMessages: [],
        error: null,
        draft: '',
        pendingImages: [],
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        resolvedApproval: null,
      };
    case 'failure':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        error: transition.message,
        liveMessages: [],
        draft: runtime.submittedInput ? runtime.submittedInput.content : runtime.draft,
        pendingImages: runtime.submittedInput ? runtime.submittedInput.images : runtime.pendingImages,
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        resolvedApproval: null,
      };
    case 'control-error':
      return { ...runtime, error: transition.message };
    case 'context-usage':
      return { ...runtime, contextUsage: transition.contextUsage };
    case 'usage':
      return applyUsageEvent(runtime, transition.usage);
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
