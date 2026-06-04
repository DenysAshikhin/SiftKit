import { useState } from 'react';
import {
  appendChatMessage,
  streamChatMessage,
  streamPlanMessage,
  streamRepoSearchMessage,
} from '../api';
import { buildRepoSearchAutoAppendPayload } from '../lib/repo-append-controls';
import { resolveEffectiveWebSearchEnabled } from '../lib/web-search-controls';
import type { ChatStreamToolEvent } from '../lib/chat-stream-parser';
import type {
  ChatSession,
  ContextUsage,
  DashboardPreset,
  RepoSearchAutoAppendSelection,
  WebSearchOverride,
} from '../types';
import type { UseLiveMessagesResult } from './useLiveMessages';
import type { UseContextUsageResult } from './useContextUsage';

export type UseChatComposerResult = {
  chatInput: string;
  setChatInput(value: string): void;
  webSearchOverride: WebSearchOverride;
  setWebSearchOverride(value: WebSearchOverride): void;
  sendMessage(): Promise<void>;
  sendPlan(): Promise<void>;
  sendRepoSearch(): Promise<void>;
};

export type DirectChatSendPlan = {
  useBuffered: boolean;
  payload: { content: string; webSearchOverride: WebSearchOverride };
};

export function resolveDirectChatSend(
  session: ChatSession,
  override: WebSearchOverride,
  content: string,
): DirectChatSendPlan {
  return {
    useBuffered: resolveEffectiveWebSearchEnabled(session.webSearchEnabled === true, override),
    payload: { content, webSearchOverride: override },
  };
}

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

export function describeStreamError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireSelectedSession(session: ChatSession | null): ChatSession {
  if (!session) {
    throw new Error('useChatComposer: selectedSession is required');
  }
  return session;
}

export function useChatComposer(deps: {
  selectedSession: ChatSession | null;
  selectedChatPreset: DashboardPreset | null;
  live: UseLiveMessagesResult;
  context: UseContextUsageResult;
  refreshSessions(): Promise<void>;
  applySessionResponse(response: { session: ChatSession; contextUsage: ContextUsage }): void;
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  isThinkingEnabledForCurrentSession: boolean;
  repoSearchAutoAppendSelection: RepoSearchAutoAppendSelection;
  onError(message: string): void;
  resetError(): void;
  setChatBusy(busy: boolean): void;
}): UseChatComposerResult {
  const [chatInput, setChatInput] = useState<string>('');
  const [webSearchOverride, setWebSearchOverride] = useState<WebSearchOverride>('default');

  function setChatBusy(busy: boolean): void {
    deps.setChatBusy(busy);
  }

  function setChatError(value: string | null): void {
    if (value === null) {
      deps.resetError();
    } else {
      deps.onError(value);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!deps.selectedSession || !chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    deps.live.resetLive();
    try {
      const sendPlan = resolveDirectChatSend(deps.selectedSession, webSearchOverride, chatInput.trim());
      const response = sendPlan.useBuffered
        ? await appendChatMessage(deps.selectedSession.id, sendPlan.payload)
        : await streamChatMessage(
          deps.selectedSession.id,
          sendPlan.payload,
          (thinkingText) => {
            if (deps.isThinkingEnabledForCurrentSession) {
              deps.live.appendLiveThinking(thinkingText);
            }
          },
          (answerText) => {
            deps.live.upsertLiveMessage({
              ...deps.live.createLiveMessage('live-answer', 'assistant_answer', 'assistant', answerText),
              outputTokensEstimate: Math.max(1, Math.ceil(String(answerText || '').length / 4)),
            });
          },
        );
      deps.applySessionResponse({ session: response.session, contextUsage: response.contextUsage });
      setChatInput('');
      setWebSearchOverride('default');
    } catch (error) {
      setChatError(describeStreamError(error));
    } finally {
      deps.live.resetLive();
      setChatBusy(false);
    }
  }

  async function sendPlan(): Promise<void> {
    const session = requireSelectedSession(deps.selectedSession);
    if (!chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    deps.live.resetLive();
    deps.context.setLiveToolPromptTokenCount(null);
    try {
      const repoRoot = resolveRepoRoot(deps.planRepoRootInput, session.planRepoRoot || '');
      const response = await streamPlanMessage(
        session.id,
        {
          content: chatInput.trim(),
          repoRoot,
          ...parsePlanMaxTurnsOverride(deps.planMaxTurnsInput),
          webSearchOverride,
        },
        (thinkingText) => {
          deps.live.appendLiveThinking(thinkingText);
        },
        (toolEvent: ChatStreamToolEvent) => {
          if (toolEvent.kind === 'tool_start') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              deps.context.setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            deps.live.appendLiveToolMessage(toolEvent);
          } else if (toolEvent.kind === 'tool_result') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              deps.context.setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            deps.live.completeLiveToolMessage(toolEvent);
          }
        },
        (answerText) => {
          deps.live.upsertLiveMessage({
            ...deps.live.createLiveMessage('live-answer', 'assistant_answer', 'assistant', answerText),
            outputTokensEstimate: Math.max(1, Math.ceil(String(answerText || '').length / 4)),
          });
        },
      );
      deps.applySessionResponse({ session: response.session, contextUsage: response.contextUsage });
      setChatInput('');
      setWebSearchOverride('default');
    } catch (error) {
      setChatError(describeStreamError(error));
    } finally {
      deps.live.resetLive();
      deps.context.setLiveToolPromptTokenCount(null);
      setChatBusy(false);
    }
  }

  async function sendRepoSearch(): Promise<void> {
    const session = requireSelectedSession(deps.selectedSession);
    if (!chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    deps.live.resetLive();
    deps.context.setLiveToolPromptTokenCount(null);
    try {
      const repoRoot = resolveRepoRoot(deps.planRepoRootInput, session.planRepoRoot || '');
      const response = await streamRepoSearchMessage(
        session.id,
        {
          content: chatInput.trim(),
          repoRoot,
          ...parsePlanMaxTurnsOverride(deps.planMaxTurnsInput),
          ...buildRepoSearchAutoAppendPayload(deps.repoSearchAutoAppendSelection),
          webSearchOverride,
        },
        (thinkingText) => {
          deps.live.appendLiveThinking(thinkingText);
        },
        (toolEvent: ChatStreamToolEvent) => {
          if (toolEvent.kind === 'tool_start') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              deps.context.setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            deps.live.appendLiveToolMessage(toolEvent);
          } else if (toolEvent.kind === 'tool_result') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              deps.context.setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            deps.live.completeLiveToolMessage(toolEvent);
          }
        },
        (answerText) => {
          deps.live.appendLiveThinking(answerText);
        },
      );
      deps.applySessionResponse({ session: response.session, contextUsage: response.contextUsage });
      setChatInput('');
      setWebSearchOverride('default');
    } catch (error) {
      setChatError(describeStreamError(error));
    } finally {
      deps.live.resetLive();
      deps.context.setLiveToolPromptTokenCount(null);
      setChatBusy(false);
    }
  }

  return {
    chatInput,
    setChatInput,
    webSearchOverride,
    setWebSearchOverride,
    sendMessage,
    sendPlan,
    sendRepoSearch,
  };
}
