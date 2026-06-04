import { useState } from 'react';

import { buildLiveToolMessageId } from '../lib/live-tool-message';
import { type ChatStreamToolEvent } from '../lib/chat-stream-parser';
import type { ChatMessage } from '../types';

type LiveMessageKind = NonNullable<ChatMessage['kind']>;

export function createLiveMessage(
  id: string,
  kind: LiveMessageKind,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  return {
    id,
    role,
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: kind === 'assistant_thinking' ? Math.max(1, Math.ceil(String(content || '').length / 4)) : 0,
    associatedToolTokens: 0,
    createdAtUtc: new Date().toISOString(),
    sourceRunId: null,
  };
}

export function upsertLiveMessageInto(previous: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = previous.findIndex((entry) => entry.id === message.id);
  if (index < 0) {
    return [...previous, message];
  }
  const next = previous.slice();
  next[index] = { ...next[index], ...message } as ChatMessage;
  return next;
}

export function buildAppendedLiveToolMessage(toolEvent: ChatStreamToolEvent): ChatMessage {
  const id = buildLiveToolMessageId(toolEvent.toolCallId);
  return {
    ...createLiveMessage(id, 'assistant_tool_call', 'assistant', toolEvent.command),
    outputTokensEstimate: 0,
    toolCallCommand: toolEvent.command,
    toolCallTurn: toolEvent.turn,
    toolCallMaxTurns: toolEvent.maxTurns,
    toolCallPromptTokenCount: typeof toolEvent.promptTokenCount === 'number' ? toolEvent.promptTokenCount : null,
    toolCallStatus: 'running',
  };
}

export function buildCompletedLiveToolMessage(toolEvent: ChatStreamToolEvent): ChatMessage {
  const id = buildLiveToolMessageId(toolEvent.toolCallId);
  const outputSnippet = typeof toolEvent.outputSnippet === 'string' ? toolEvent.outputSnippet : '';
  const outputTokens = typeof toolEvent.outputTokens === 'number' ? Math.max(0, toolEvent.outputTokens) : 0;
  return {
    ...createLiveMessage(id, 'assistant_tool_call', 'assistant', toolEvent.command),
    outputTokensEstimate: outputTokens,
    associatedToolTokens: outputTokens,
    toolCallCommand: toolEvent.command,
    toolCallTurn: toolEvent.turn,
    toolCallMaxTurns: toolEvent.maxTurns,
    toolCallExitCode: typeof toolEvent.exitCode === 'number' ? toolEvent.exitCode : null,
    toolCallPromptTokenCount: typeof toolEvent.promptTokenCount === 'number' ? toolEvent.promptTokenCount : null,
    toolCallOutputSnippet: outputSnippet,
    toolCallStatus: 'done',
  };
}

export type UseLiveMessagesResult = {
  liveMessages: ChatMessage[];
  setLiveMessages(value: ChatMessage[]): void;
  resetLive(): void;
  createLiveMessage(id: string, kind: LiveMessageKind, role: ChatMessage['role'], content: string): ChatMessage;
  upsertLiveMessage(message: ChatMessage): void;
  appendLiveToolMessage(toolEvent: ChatStreamToolEvent): void;
  completeLiveToolMessage(toolEvent: ChatStreamToolEvent): void;
};

export function useLiveMessages(): UseLiveMessagesResult {
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);
  return {
    liveMessages,
    setLiveMessages,
    resetLive(): void {
      setLiveMessages([]);
    },
    createLiveMessage,
    upsertLiveMessage(message: ChatMessage): void {
      setLiveMessages((previous) => upsertLiveMessageInto(previous, message));
    },
    appendLiveToolMessage(toolEvent: ChatStreamToolEvent): void {
      const built = buildAppendedLiveToolMessage(toolEvent);
      setLiveMessages((previous) => upsertLiveMessageInto(previous, built));
    },
    completeLiveToolMessage(toolEvent: ChatStreamToolEvent): void {
      const built = buildCompletedLiveToolMessage(toolEvent);
      setLiveMessages((previous) => upsertLiveMessageInto(previous, built));
    },
  };
}
