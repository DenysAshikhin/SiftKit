import { getErrorMessage } from '../../../src/lib/errors.js';
import {
  streamChatMessage,
  streamPlanMessage,
  streamRepoSearchMessage,
} from '../api';
import type { ChatStreamEvent, ChatStreamToolEvent } from '../lib/chat-stream-parser';
import type {
  ChatSession,
  ChatSessionOperationKind,
  ChatSessionResponse,
} from '../types';

export type UseChatComposerResult = {
  sendMessage(): Promise<void>;
  sendPlan(): Promise<void>;
  sendRepoSearch(): Promise<void>;
};

export type ParsedMaxTurnsOverride = { maxTurns: number } | Record<string, never>;

export function parsePlanMaxTurnsOverride(input: string): ParsedMaxTurnsOverride {
  const parsed = Number(input);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { maxTurns: parsed };
  }
  return {};
}

export function resolveRepoRoot(planRepoRootInput: string, fallback: string): string {
  const trimmed = planRepoRootInput.trim();
  if (trimmed) {
    return trimmed;
  }
  return fallback;
}

export function requireSelectedSession(session: ChatSession | null): ChatSession {
  if (!session) {
    throw new Error('useChatComposer: selectedSession is required');
  }
  return session;
}

export type RuntimeActions = {
  beginSessionOperation(sessionId: string, operationKind: ChatSessionOperationKind): void;
  appendSessionThinking(sessionId: string, text: string): void;
  applySessionToolEvent(sessionId: string, toolEvent: ChatStreamToolEvent): void;
  applySessionAnswer(sessionId: string, text: string): void;
  applySessionWarning(sessionId: string, text: string): void;
  completeSessionOperation(sessionId: string, response: ChatSessionResponse): void;
  failSessionOperation(sessionId: string, message: string): void;
};

export async function consumeChatStream(
  sessionId: string,
  operationKind: ChatSessionOperationKind,
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
  runtimes: RuntimeActions,
): Promise<void> {
  runtimes.beginSessionOperation(sessionId, operationKind);
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.kind === 'thinking') {
        if (thinkingEnabled) {
          runtimes.appendSessionThinking(sessionId, event.text);
        }
      } else if (event.kind === 'warning') {
        runtimes.applySessionWarning(sessionId, event.text);
      } else if (event.kind === 'tool') {
        runtimes.applySessionToolEvent(sessionId, event.tool);
      } else if (event.kind === 'answer') {
        runtimes.applySessionAnswer(sessionId, event.text);
      } else if (event.kind === 'done') {
        runtimes.completeSessionOperation(sessionId, event.payload);
        completed = true;
      }
    }
    if (!completed) {
      throw new Error('Chat stream ended before the done event');
    }
  } catch (error) {
    runtimes.failSessionOperation(sessionId, getErrorMessage(error));
  }
}

export function useChatComposer(deps: {
  selectedSession: ChatSession | null;
  draft: string;
  pendingImages: string[];
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  isThinkingEnabledForCurrentSession: boolean;
  runtimes: RuntimeActions;
}): UseChatComposerResult {
  async function sendMessage(): Promise<void> {
    if (!deps.selectedSession || (!deps.draft.trim() && deps.pendingImages.length === 0)) {
      return;
    }
    const session = deps.selectedSession;
    const capturedInput = deps.draft.trim();
    const capturedImages = deps.pendingImages;
    const thinkingEnabled = deps.isThinkingEnabledForCurrentSession;
    await consumeChatStream(
      session.id,
      'message',
      streamChatMessage(session.id, { content: capturedInput, images: capturedImages }),
      thinkingEnabled,
      deps.runtimes,
    );
  }

  async function sendPlan(): Promise<void> {
    const session = requireSelectedSession(deps.selectedSession);
    const capturedInput = deps.draft.trim();
    const thinkingEnabled = deps.isThinkingEnabledForCurrentSession;
    if (!capturedInput) {
      return;
    }
    const repoRoot = resolveRepoRoot(deps.planRepoRootInput, session.planRepoRoot || '');
    await consumeChatStream(
      session.id,
      'plan',
      streamPlanMessage(session.id, {
        content: capturedInput,
        repoRoot,
        ...parsePlanMaxTurnsOverride(deps.planMaxTurnsInput),
      }),
      thinkingEnabled,
      deps.runtimes,
    );
  }

  async function sendRepoSearch(): Promise<void> {
    const session = requireSelectedSession(deps.selectedSession);
    const capturedInput = deps.draft.trim();
    const thinkingEnabled = deps.isThinkingEnabledForCurrentSession;
    if (!capturedInput) {
      return;
    }
    const repoRoot = resolveRepoRoot(deps.planRepoRootInput, session.planRepoRoot || '');
    await consumeChatStream(
      session.id,
      'repo-search',
      streamRepoSearchMessage(session.id, {
        content: capturedInput,
        repoRoot,
        ...parsePlanMaxTurnsOverride(deps.planMaxTurnsInput),
      }),
      thinkingEnabled,
      deps.runtimes,
    );
  }

  return {
    sendMessage,
    sendPlan,
    sendRepoSearch,
  };
}
