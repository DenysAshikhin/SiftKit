import { appendLiveThinkingMessage } from './live-thinking-message';
import { buildAppendedLiveToolMessage, buildCompletedLiveToolMessage, upsertLiveMessageInto, createLiveMessage } from './chat-live-messages';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';

function createIdleActivity(): { kind: 'idle' } {
  return { kind: 'idle' as const };
}

function createActiveActivity(operationKind: ChatSessionOperationKind): { kind: 'active'; operationKind: ChatSessionOperationKind } {
  return { kind: 'active' as const, operationKind };
}

type ChatSessionActivity =
  | ReturnType<typeof createIdleActivity>
  | ReturnType<typeof createActiveActivity>;

function createChatSessionRuntime(
  sessionId: string,
  activity: ChatSessionActivity = createIdleActivity(),
  liveMessages: ChatMessage[] = [],
  error: string | null = null,
  warnings: string[] = [],
  contextUsage: ContextUsage | null = null,
  liveToolPromptTokenCount: number | null = null,
  draft: string = '',
  pendingImages: string[] = [],
  planRepoRootInput: string = '',
  planMaxTurnsInput: string = '',
) {
  return {
    sessionId,
    activity,
    liveMessages,
    error,
    warnings,
    contextUsage,
    liveToolPromptTokenCount,
    draft,
    pendingImages,
    planRepoRootInput,
    planMaxTurnsInput,
  };
}

export type ChatSessionRuntime = ReturnType<typeof createChatSessionRuntime>;

function cloneMap(map: Map<string, ChatSessionRuntime>): Map<string, ChatSessionRuntime> {
  return new Map(map);
}

function cloneRuntime(runtime: ChatSessionRuntime): ChatSessionRuntime {
  return {
    sessionId: runtime.sessionId,
    activity: runtime.activity,
    liveMessages: runtime.liveMessages,
    error: runtime.error,
    warnings: runtime.warnings,
    contextUsage: runtime.contextUsage,
    liveToolPromptTokenCount: runtime.liveToolPromptTokenCount,
    draft: runtime.draft,
    pendingImages: runtime.pendingImages,
    planRepoRootInput: runtime.planRepoRootInput,
    planMaxTurnsInput: runtime.planMaxTurnsInput,
  };
}

export class ChatSessionRuntimeStore {
  private readonly runtimesBySessionId: Map<string, ChatSessionRuntime>;

  constructor(runtimesBySessionId: Map<string, ChatSessionRuntime> = new Map()) {
    this.runtimesBySessionId = runtimesBySessionId;
  }

  get(sessionId: string): ChatSessionRuntime {
    const runtime = this.runtimesBySessionId.get(sessionId);
    if (!runtime) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    return runtime;
  }

  getAll(): ChatSessionRuntime[] {
    return Array.from(this.runtimesBySessionId.values());
  }

  ensureSession(sessionId: string): ChatSessionRuntimeStore {
    if (this.runtimesBySessionId.has(sessionId)) {
      return this;
    }
    const next = cloneMap(this.runtimesBySessionId);
    next.set(sessionId, createChatSessionRuntime(sessionId));
    return new ChatSessionRuntimeStore(next);
  }

  begin(sessionId: string, operationKind: ChatSessionOperationKind): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    next.set(sessionId, {
      ...cloneRuntime(existing),
      activity: createActiveActivity(operationKind),
    });
    return new ChatSessionRuntimeStore(next);
  }

  appendThinking(sessionId: string, text: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.liveMessages = appendLiveThinkingMessage(updated.liveMessages, text, true);
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  applyToolEvent(sessionId: string, toolEvent: ChatStreamToolEvent): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    if (toolEvent.kind === 'tool_start') {
      const toolMsg = buildAppendedLiveToolMessage(toolEvent);
      updated.liveMessages = upsertLiveMessageInto(updated.liveMessages, toolMsg);
      if (typeof toolEvent.promptTokenCount === 'number') {
        updated.liveToolPromptTokenCount = toolEvent.promptTokenCount;
      }
    } else {
      const toolMsg = buildCompletedLiveToolMessage(toolEvent);
      updated.liveMessages = upsertLiveMessageInto(updated.liveMessages, toolMsg);
      if (typeof toolEvent.promptTokenCount === 'number') {
        updated.liveToolPromptTokenCount = toolEvent.promptTokenCount;
      }
    }
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  applyAnswer(sessionId: string, text: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    const answerMsg = createLiveMessage('live-answer', 'assistant_answer', 'assistant', text);
    answerMsg.outputTokensEstimate = Math.max(1, Math.ceil(String(text || '').length / 4));
    updated.liveMessages = upsertLiveMessageInto(updated.liveMessages, answerMsg);
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  applyWarning(sessionId: string, text: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.warnings = [...updated.warnings, text];
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  applyDone(sessionId: string, response: ChatSessionResponse): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.activity = createIdleActivity();
    updated.contextUsage = response.contextUsage;
    updated.liveMessages = [];
    updated.error = null;
    updated.draft = '';
    updated.pendingImages = [];
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  applyFailure(sessionId: string, message: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.activity = createIdleActivity();
    updated.error = message;
    updated.liveMessages = [];
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  setContextUsage(sessionId: string, contextUsage: ContextUsage): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.contextUsage = contextUsage;
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  setDraft(sessionId: string, draft: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.draft = draft;
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  setImages(sessionId: string, images: string[]): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.pendingImages = images;
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  setPlanInputs(sessionId: string, planRepoRootInput: string, planMaxTurnsInput: string): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(sessionId);
    if (!existing) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    const next = cloneMap(this.runtimesBySessionId);
    const updated = cloneRuntime(existing);
    updated.planRepoRootInput = planRepoRootInput;
    updated.planMaxTurnsInput = planMaxTurnsInput;
    next.set(sessionId, updated);
    return new ChatSessionRuntimeStore(next);
  }

  removeSession(sessionId: string): ChatSessionRuntimeStore {
    const next = cloneMap(this.runtimesBySessionId);
    next.delete(sessionId);
    return new ChatSessionRuntimeStore(next);
  }
}
