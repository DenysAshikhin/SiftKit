import {
  ChatStreamToolEventSchema,
  ChatStreamUsageEventSchema,
  ChatStreamPromptEventSchema,
  type ChatStreamToolEvent,
  type ChatStreamUsageEvent,
} from '@siftkit/contracts';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';

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

export function toChatStreamPromptEvent(event: Extract<RepoSearchProgressEvent, { kind: 'prompt' }>) {
  return ChatStreamPromptEventSchema.parse({
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
