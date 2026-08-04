import { buildLiveToolMessageId } from './live-tool-message';
import { type ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage } from '../types';

type LiveMessageKind = NonNullable<ChatMessage['kind']>;

export function createLiveMessage(
  id: string,
  kind: LiveMessageKind,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  const thinkingTokens = kind === 'assistant_thinking' ? Math.max(1, Math.ceil(String(content || '').length / 4)) : 0;
  return {
    id,
    role,
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: thinkingTokens > 0,
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
  next[index] = { ...previous[index], ...message };
  return next;
}

export function buildAppendedLiveToolMessage(toolEvent: ChatStreamToolEvent): ChatMessage {
  const id = buildLiveToolMessageId(toolEvent.toolCallId);
  return {
    ...createLiveMessage(id, 'assistant_tool_call', 'assistant', toolEvent.command),
    outputTokensEstimate: 0,
    outputTokensEstimated: false,
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
    outputTokensEstimated: outputTokens > 0 ? toolEvent.outputTokensEstimated !== false : false,
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
