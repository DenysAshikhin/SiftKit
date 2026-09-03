import {
  buildLiveUserMessage,
  upsertLiveMessageInto,
} from './chat-live-messages';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';
import {
  reduceChatTranscript,
  type ChatStreamApproval,
  type ChatStreamProgress,
  type ChatStreamTextDelta,
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
  liveToolPromptTokenCount: number | null;
  draft: string;
  pendingImages: PendingImage[];
  submittedInput: SubmittedChatInput | null;
  /** The submitted turn has produced nothing yet; cleared by the first streamed evidence. */
  awaitingResponse: boolean;
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  pendingApproval: ChatStreamApproval | null;
  resolvedApproval: ResolvedRepoAgentApproval | null;
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
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: PendingImage[] }
  | { kind: 'append-images'; sessionId: string; images: PendingImage[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string };

function createChatSessionRuntime(sessionId: string): ChatSessionRuntime {
  return {
    sessionId,
    activity: { kind: 'idle' },
    liveMessages: [],
    error: null,
    warnings: [],
    contextUsage: null,
    liveToolPromptTokenCount: null,
    draft: '',
    pendingImages: [],
    submittedInput: null,
    awaitingResponse: false,
    planRepoRootInput: '',
    planMaxTurnsInput: '',
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
  return {
    ...applyTranscriptEvent(runtime, { kind: 'tool', tool: toolEvent }),
    liveToolPromptTokenCount: toolEvent.promptTokenCount,
  };
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
    case 'thinking':
      return applyTranscriptEvent(runtime, { kind: 'thinking', delta: transition.delta });
    case 'narration':
      return applyTranscriptEvent(runtime, { kind: 'narration', delta: transition.delta });
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
    case 'answer':
      return applyTranscriptEvent(runtime, { kind: 'answer', delta: transition.delta });
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

  ensureSession(sessionId: string): ChatSessionRuntimeStore {
    if (this.runtimesBySessionId.has(sessionId)) {
      return this;
    }
    const next = new Map(this.runtimesBySessionId);
    next.set(sessionId, createChatSessionRuntime(sessionId));
    return new ChatSessionRuntimeStore(next);
  }

  /** The single copy-on-write path. Writers create the runtime if it is absent. */
  apply(transition: ChatSessionRuntimeTransition): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(transition.sessionId)
      ?? createChatSessionRuntime(transition.sessionId);
    const next = new Map(this.runtimesBySessionId);
    next.set(transition.sessionId, applyTransition(existing, transition));
    return new ChatSessionRuntimeStore(next);
  }

  removeSession(sessionId: string): ChatSessionRuntimeStore {
    const next = new Map(this.runtimesBySessionId);
    next.delete(sessionId);
    return new ChatSessionRuntimeStore(next);
  }
}
