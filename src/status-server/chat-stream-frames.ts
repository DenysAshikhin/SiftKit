import {
  ChatStreamToolEventSchema,
  ChatStreamUsageEventSchema,
  type ChatStreamToolEvent,
  type ChatStreamUsageEvent,
} from '@siftkit/contracts';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import type { ChatOperationBroadcast } from './chat-operation-broadcast.js';

/** Anything that accepts a chat stream frame. Structural, so tests can pass a recording stub. */
export type ChatFrameWriter = Pick<ChatOperationBroadcast, 'writeEvent'>;

export function forwardRepoSearchToolEvent(
  writer: ChatFrameWriter,
  event: ChatStreamToolEvent,
): void {
  if (event.kind === 'tool_start') {
    writer.writeEvent('tool_start', {
      toolCallId: event.toolCallId,
      turn: event.turn,
      maxTurns: event.maxTurns,
      activityKind: event.activityKind,
      activitySubject: event.activitySubject,
      command: event.command,
      promptTokenCount: event.promptTokenCount,
    });
    return;
  }
  if (event.kind === 'tool_result') {
    writer.writeEvent('tool_result', {
      toolCallId: event.toolCallId,
      turn: event.turn,
      maxTurns: event.maxTurns,
      activityKind: event.activityKind,
      activitySubject: event.activitySubject,
      command: event.command,
      exitCode: event.exitCode,
      outputSnippet: event.outputSnippet,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
      promptTokenCount: event.promptTokenCount,
    });
  }
}

export function toChatStreamUsageEvent(
  event: Extract<RepoSearchProgressEvent, { kind: 'usage' }>,
): ChatStreamUsageEvent {
  return ChatStreamUsageEventSchema.parse({
    turn: event.turn,
    maxTurns: event.maxTurns,
    record: event.record,
    totals: event.totals,
    charsPerToken: event.charsPerToken,
  });
}

export function forwardRepoSearchUsageEvent(
  writer: ChatFrameWriter,
  event: Extract<RepoSearchProgressEvent, { kind: 'usage' }>,
): void {
  writer.writeEvent('usage', toChatStreamUsageEvent(event));
}

export function forwardRepoSearchPromptEvent(
  writer: ChatFrameWriter,
  event: Extract<RepoSearchProgressEvent, { kind: 'prompt' }>,
): void {
  writer.writeEvent('prompt', {
    turn: event.turn,
    maxTurns: event.maxTurns,
    promptTokens: event.promptTokens,
    charsPerToken: event.charsPerToken,
  });
}

export function toChatStreamToolEvent(
  event: Extract<RepoSearchProgressEvent, { kind: 'tool_start' | 'tool_result' }>,
): ChatStreamToolEvent {
  const common = {
    kind: event.kind,
    toolCallId: event.toolCallId,
    turn: event.turn,
    maxTurns: event.maxTurns,
    activityKind: event.activityKind,
    activitySubject: event.activitySubject,
    command: event.command,
    promptTokenCount: event.promptTokenCount,
  };
  return ChatStreamToolEventSchema.parse(event.kind === 'tool_start'
    ? common
    : {
      ...common,
      exitCode: event.exitCode,
      outputSnippet: event.outputSnippet,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
    });
}
