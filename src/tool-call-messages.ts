import type { JsonObject } from './lib/json-types.js';
import type { ChatMessage } from './repo-search/planner-chat-message.js';

export type ToolTranscriptAction = {
  toolName: string;
  args: JsonObject;
};

export type ToolBatchOutcome = {
  action: ToolTranscriptAction;
  toolCallId: string;
  toolContent: string;
};

/** The assistant message produced by a tool batch, shared by pending and appended transcripts. */
export function buildAssistantToolCallMessage(
  outcomes: readonly ToolBatchOutcome[],
  thinkingText = '',
  content = '',
): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: outcomes.map(({ action, toolCallId }) => ({
      id: toolCallId,
      type: 'function',
      function: {
        name: action.toolName,
        arguments: JSON.stringify(action.args),
      },
    })),
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}

export function buildToolResultMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

/**
 * The assistant call message plus its ordered results. Builders only: who splices these into a
 * transcript, and what records that splice, is the caller's business.
 */
export function buildToolBatchMessages(
  outcomes: readonly ToolBatchOutcome[],
  thinkingText = '',
  content = '',
): ChatMessage[] {
  if (outcomes.length === 0) {
    return [];
  }
  return [
    buildAssistantToolCallMessage(outcomes, thinkingText, content),
    ...outcomes.map(({ toolCallId, toolContent }) => buildToolResultMessage(toolCallId, toolContent)),
  ];
}

export function buildToolExchangeMessages(
  action: ToolTranscriptAction,
  toolCallId: string,
  toolContent: string,
  thinkingText = '',
): ChatMessage[] {
  return buildToolBatchMessages([{ action, toolCallId, toolContent }], thinkingText);
}

/**
 * Where a trailing single-slot user message belongs: over the one already written at
 * `existingIndex`, or appended when there is none. One definition, so an array owner and a
 * splice-recording transcript cannot disagree about which message the countdown replaced.
 */
export function resolveTrailingUserSlot(
  messageCount: number,
  existingIndex: number,
): { index: number; deleteCount: number } {
  return existingIndex >= 0 && existingIndex < messageCount
    ? { index: existingIndex, deleteCount: 1 }
    : { index: messageCount, deleteCount: 0 };
}

export function upsertTrailingUserMessage(
  messages: ChatMessage[],
  existingIndex: number,
  content: string,
): number {
  const slot = resolveTrailingUserSlot(messages.length, existingIndex);
  messages.splice(slot.index, slot.deleteCount, { role: 'user', content });
  return slot.index;
}
