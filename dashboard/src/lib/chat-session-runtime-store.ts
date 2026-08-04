import { appendLiveThinkingMessage } from './live-thinking-message';
import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from './chat-live-messages';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';

export type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'active'; operationKind: ChatSessionOperationKind };

export type ChatSessionRuntime = {
  sessionId: string;
  activity: ChatSessionActivity;
  liveMessages: ChatMessage[];
  error: string | null;
  warnings: string[];
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  draft: string;
  pendingImages: string[];
  planRepoRootInput: string;
  planMaxTurnsInput: string;
};

export type ChatSessionRuntimeTransition =
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind }
  | { kind: 'thinking'; sessionId: string; text: string }
  | { kind: 'tool'; sessionId: string; toolEvent: ChatStreamToolEvent }
  | { kind: 'answer'; sessionId: string; text: string }
  | { kind: 'warning'; sessionId: string; text: string }
  | { kind: 'done'; sessionId: string; response: ChatSessionResponse }
  | { kind: 'failure'; sessionId: string; message: string }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: string[] }
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
    planRepoRootInput: '',
    planMaxTurnsInput: '',
  };
}

function applyToolEvent(runtime: ChatSessionRuntime, toolEvent: ChatStreamToolEvent): ChatSessionRuntime {
  const toolMessage = toolEvent.kind === 'tool_start'
    ? buildAppendedLiveToolMessage(toolEvent)
    : buildCompletedLiveToolMessage(toolEvent);
  return {
    ...runtime,
    liveMessages: upsertLiveMessageInto(runtime.liveMessages, toolMessage),
    liveToolPromptTokenCount: typeof toolEvent.promptTokenCount === 'number'
      ? toolEvent.promptTokenCount
      : runtime.liveToolPromptTokenCount,
  };
}

function applyAnswer(runtime: ChatSessionRuntime, text: string): ChatSessionRuntime {
  const answerMessage = createLiveMessage('live-answer', 'assistant_answer', 'assistant', text);
  answerMessage.outputTokensEstimate = Math.max(1, Math.ceil(text.length / 4));
  return { ...runtime, liveMessages: upsertLiveMessageInto(runtime.liveMessages, answerMessage) };
}

function applyTransition(
  runtime: ChatSessionRuntime,
  transition: ChatSessionRuntimeTransition,
): ChatSessionRuntime {
  switch (transition.kind) {
    case 'begin':
      return { ...runtime, activity: { kind: 'active', operationKind: transition.operationKind } };
    case 'thinking':
      return {
        ...runtime,
        liveMessages: appendLiveThinkingMessage(runtime.liveMessages, transition.text, true),
      };
    case 'tool':
      return applyToolEvent(runtime, transition.toolEvent);
    case 'answer':
      return applyAnswer(runtime, transition.text);
    case 'warning':
      return { ...runtime, warnings: [...runtime.warnings, transition.text] };
    case 'done':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        contextUsage: transition.response.contextUsage,
        liveMessages: [],
        error: null,
        draft: '',
        pendingImages: [],
      };
    case 'failure':
      return { ...runtime, activity: { kind: 'idle' }, error: transition.message, liveMessages: [] };
    case 'context-usage':
      return { ...runtime, contextUsage: transition.contextUsage };
    case 'draft':
      return { ...runtime, draft: transition.draft };
    case 'images':
      return { ...runtime, pendingImages: transition.images };
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