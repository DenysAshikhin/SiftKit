import { buildLiveToolMessageId } from './live-tool-message';
import { type ChatStreamToolEvent } from './chat-stream-parser';
import { ChatMessageSchema, type ChatMessage, type ChatToolCallMessage } from '../types';

type LiveMessageKind = Exclude<ChatMessage['kind'], 'assistant_tool_call'>;

export function createLiveMessage(
  id: string,
  kind: LiveMessageKind,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  const thinkingTokens = kind === 'assistant_thinking' ? Math.max(1, Math.ceil(String(content || '').length / 4)) : 0;
  return ChatMessageSchema.parse({
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
  });
}

export const LIVE_USER_MESSAGE_ID = 'live-user';

export function buildLiveUserMessage(content: string, imageDataUrls: string[]): ChatMessage {
  return {
    ...createLiveMessage(LIVE_USER_MESSAGE_ID, 'user_text', 'user', content),
    images: imageDataUrls,
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

export function buildAppendedLiveToolMessage(
  toolEvent: Extract<ChatStreamToolEvent, { kind: 'tool_start' }>,
): ChatToolCallMessage {
  const id = buildLiveToolMessageId(toolEvent.toolCallId);
  return {
    id,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: toolEvent.command,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    associatedToolTokens: 0,
    createdAtUtc: new Date().toISOString(),
    sourceRunId: null,
    toolCallCommand: toolEvent.command,
    toolCallActivityKind: toolEvent.activityKind,
    toolCallActivitySubject: toolEvent.activitySubject,
    toolCallTurn: toolEvent.turn,
    toolCallMaxTurns: toolEvent.maxTurns,
    toolCallExitCode: null,
    toolCallPromptTokenCount: toolEvent.promptTokenCount,
    toolCallStatus: 'running',
  };
}

export function buildCompletedLiveToolMessage(
  toolEvent: Extract<ChatStreamToolEvent, { kind: 'tool_result' }>,
): ChatToolCallMessage {
  const id = buildLiveToolMessageId(toolEvent.toolCallId);
  return {
    id,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: toolEvent.command,
    inputTokensEstimate: 0,
    outputTokensEstimate: toolEvent.outputTokens,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: toolEvent.outputTokensEstimated,
    thinkingTokensEstimated: false,
    associatedToolTokens: toolEvent.outputTokens,
    createdAtUtc: new Date().toISOString(),
    sourceRunId: null,
    toolCallCommand: toolEvent.command,
    toolCallActivityKind: toolEvent.activityKind,
    toolCallActivitySubject: toolEvent.activitySubject,
    toolCallTurn: toolEvent.turn,
    toolCallMaxTurns: toolEvent.maxTurns,
    toolCallExitCode: toolEvent.exitCode,
    toolCallPromptTokenCount: toolEvent.promptTokenCount,
    toolCallOutputSnippet: toolEvent.outputSnippet,
    toolCallStatus: 'done',
  };
}
