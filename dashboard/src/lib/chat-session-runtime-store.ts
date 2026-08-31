import { applyLiveThinkingDelta } from './live-thinking-message';
import {
  applyNarrationDelta,
  demoteNarrationForTurn,
  liveNarrationMessageId,
  promoteNarrationToAnswer,
} from './live-narration-message';
import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  buildLiveUserMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from './chat-live-messages';
import { applyTextDelta } from './stream-text-delta';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';
import type { ChatStreamApproval, ChatStreamProgress, ChatStreamTextDelta } from '@siftkit/contracts';
import type { PendingImage } from './downscale-image';
import type { RepoAgentDecision } from '../api';

export type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'active'; operationKind: ChatSessionOperationKind };

export type SubmittedChatInput = { content: string; images: PendingImage[] };
export type ResolvedRepoAgentApproval = {
  approval: ChatStreamApproval;
  decision: RepoAgentDecision;
  decidedAtUtc: string;
};

export type ChatSessionRuntime = {
  sessionId: string;
  activity: ChatSessionActivity;
  remoteBusy: boolean;
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
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind }
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
  | { kind: 'failure'; sessionId: string; message: string; remoteBusy?: boolean }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: PendingImage[] }
  | { kind: 'append-images'; sessionId: string; images: PendingImage[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string };

function createChatSessionRuntime(sessionId: string): ChatSessionRuntime {
  return {
    sessionId,
    activity: { kind: 'idle' },
    remoteBusy: false,
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

function applyToolEvent(runtime: ChatSessionRuntime, toolEvent: ChatStreamToolEvent): ChatSessionRuntime {
  const toolMessage = toolEvent.kind === 'tool_start'
    ? buildAppendedLiveToolMessage(toolEvent)
    : buildCompletedLiveToolMessage(toolEvent);
  return {
    ...runtime,
    awaitingResponse: false,
    liveMessages: upsertLiveMessageInto(
      toolEvent.kind === 'tool_start'
        ? demoteNarrationForTurn(runtime.liveMessages, toolEvent.turn)
        : runtime.liveMessages,
      toolMessage,
    ),
    liveToolPromptTokenCount: toolEvent.promptTokenCount,
  };
}

function applyAnswer(runtime: ChatSessionRuntime, delta: ChatStreamTextDelta): ChatSessionRuntime {
  const narrationId = liveNarrationMessageId(delta.turn);
  if (runtime.liveMessages.some((message) => message.id === narrationId)) {
    return {
      ...runtime,
      awaitingResponse: false,
      liveMessages: promoteNarrationToAnswer(runtime.liveMessages, delta),
    };
  }
  const existing = runtime.liveMessages.find((message) => message.id === 'live-answer');
  const text = applyTextDelta(existing?.content ?? '', delta);
  const answerMessage = createLiveMessage('live-answer', 'assistant_answer', 'assistant', text);
  answerMessage.outputTokensEstimate = Math.max(1, Math.ceil(text.length / 4));
  return {
    ...runtime,
    awaitingResponse: false,
    liveMessages: upsertLiveMessageInto(runtime.liveMessages, answerMessage),
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
        activity: { kind: 'active', operationKind: transition.operationKind },
        remoteBusy: false,
      };
    case 'thinking':
      return {
        ...runtime,
        awaitingResponse: false,
        liveMessages: applyLiveThinkingDelta(runtime.liveMessages, transition.delta, true),
      };
    case 'narration':
      return {
        ...runtime,
        awaitingResponse: false,
        liveMessages: applyNarrationDelta(runtime.liveMessages, transition.delta),
      };
    case 'tool':
      return applyToolEvent(runtime, transition.toolEvent);
    case 'progress': {
      const progressMessage = createLiveMessage('live-progress', 'assistant_progress', 'assistant', transition.progress.text);
      return {
        ...runtime,
        awaitingResponse: false,
        liveMessages: upsertLiveMessageInto(runtime.liveMessages, progressMessage),
      };
    }
    case 'approval':
      return { ...runtime, awaitingResponse: false, pendingApproval: transition.approval };
    case 'approval-decision':
      return { ...runtime, pendingApproval: null, resolvedApproval: transition.resolution };
    case 'approval-clear':
      return { ...runtime, pendingApproval: null, resolvedApproval: null };
    case 'answer':
      return applyAnswer(runtime, transition.delta);
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
        remoteBusy: false,
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
        remoteBusy: transition.remoteBusy === true,
        error: transition.message,
        liveMessages: [],
        draft: runtime.submittedInput ? runtime.submittedInput.content : runtime.draft,
        pendingImages: runtime.submittedInput ? runtime.submittedInput.images : runtime.pendingImages,
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        resolvedApproval: null,
      };
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
