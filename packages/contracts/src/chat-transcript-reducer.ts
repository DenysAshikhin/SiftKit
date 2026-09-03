import { z } from 'zod';
import {
  ChatStreamProgressSchema,
  ChatStreamTextDeltaSchema,
  ChatStreamToolEventSchema,
  ChatTranscriptMessageSchema,
  PersistedChatTranscriptMessageSchema,
  type ChatStreamTextDelta,
  type ChatTranscriptMessage,
  type PersistedChatTranscriptMessage,
} from './chat.js';

export const ChatTranscriptEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thinking'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('narration'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('answer'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('progress'), progress: ChatStreamProgressSchema }),
  z.strictObject({ kind: z.literal('tool'), tool: ChatStreamToolEventSchema }),
]);
export type ChatTranscriptEvent = z.infer<typeof ChatTranscriptEventSchema>;

export const ChatTranscriptMetadataSchema = z.strictObject({
  messageIdPrefix: z.string().min(1),
  sourceRunId: z.string().nullable(),
  createdAtUtc: z.string().min(1),
});
export type ChatTranscriptMetadata = z.infer<typeof ChatTranscriptMetadataSchema>;

function estimateTokenCount(content: string): number {
  return content ? Math.max(1, Math.ceil(content.length / 4)) : 0;
}

export function applyChatStreamTextDelta(previous: string, delta: ChatStreamTextDelta): string {
  if (delta.offset === 0) return delta.text;
  if (delta.offset === previous.length) return previous + delta.text;
  if (delta.offset < previous.length) return previous.slice(0, delta.offset) + delta.text;
  return previous;
}

function upsertMessage(
  messages: readonly ChatTranscriptMessage[],
  message: ChatTranscriptMessage,
): ChatTranscriptMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.map((candidate, candidateIndex) => candidateIndex === index ? message : candidate);
}

function textMessage(
  id: string,
  kind: 'assistant_thinking' | 'assistant_narration' | 'assistant_progress' | 'assistant_answer',
  content: string,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage {
  const thinkingTokens = kind === 'assistant_thinking' ? estimateTokenCount(content) : 0;
  return ChatTranscriptMessageSchema.parse({
    id,
    role: 'assistant',
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: kind === 'assistant_thinking' ? 0 : estimateTokenCount(content),
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated: kind !== 'assistant_thinking',
    thinkingTokensEstimated: thinkingTokens > 0,
    associatedToolTokens: 0,
    createdAtUtc: metadata.createdAtUtc,
    sourceRunId: metadata.sourceRunId,
  });
}

function textMessageId(
  kind: 'thinking' | 'narration' | 'answer',
  turn: number,
  metadata: ChatTranscriptMetadata,
): string {
  return `${metadata.messageIdPrefix}-${kind}-${turn}`;
}

function reduceTextEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'thinking' | 'narration' | 'answer' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const narrationId = textMessageId('narration', event.delta.turn, metadata);
  const promotedNarration = event.kind === 'answer'
    ? messages.find((message) => (
      message.id === narrationId
      && (message.kind === 'assistant_narration' || message.kind === 'assistant_progress')
    ))
    : undefined;
  const id = promotedNarration?.id ?? textMessageId(event.kind, event.delta.turn, metadata);
  const existing = messages.find((message) => message.id === id);
  const content = applyChatStreamTextDelta(existing?.content ?? '', event.delta);
  if (!content && !existing && event.kind !== 'answer') return [...messages];

  const kind = event.kind === 'thinking'
    ? 'assistant_thinking'
    : event.kind === 'narration'
      ? 'assistant_narration'
      : 'assistant_answer';
  return upsertMessage(messages, textMessage(id, kind, content, metadata));
}

function reduceProgressEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'progress' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const message = textMessage(
    `${metadata.messageIdPrefix}-progress`,
    'assistant_progress',
    event.progress.text,
    metadata,
  );
  return upsertMessage(messages, message);
}

function reduceToolEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'tool' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const tool = event.tool;
  const beforeTool = tool.kind === 'tool_start'
    ? messages.map((message) => (
      message.id === textMessageId('narration', tool.turn, metadata)
      && message.kind === 'assistant_narration'
        ? ChatTranscriptMessageSchema.parse({ ...message, kind: 'assistant_progress' })
        : message
    ))
    : [...messages];
  const message = ChatTranscriptMessageSchema.parse({
    id: `${metadata.messageIdPrefix}-tool-${tool.toolCallId}`,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: tool.command,
    inputTokensEstimate: 0,
    outputTokensEstimate: tool.kind === 'tool_result' ? tool.outputTokens : 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: tool.kind === 'tool_result' ? tool.outputTokensEstimated : false,
    thinkingTokensEstimated: false,
    associatedToolTokens: tool.kind === 'tool_result' ? tool.outputTokens : 0,
    createdAtUtc: metadata.createdAtUtc,
    sourceRunId: metadata.sourceRunId,
    toolCallCommand: tool.command,
    toolCallActivityKind: tool.activityKind,
    toolCallActivitySubject: tool.activitySubject,
    toolCallTurn: tool.turn,
    toolCallMaxTurns: tool.maxTurns,
    toolCallExitCode: tool.kind === 'tool_result' ? tool.exitCode : null,
    toolCallPromptTokenCount: tool.promptTokenCount,
    toolCallOutputSnippet: tool.kind === 'tool_result' ? tool.outputSnippet : undefined,
    toolCallOutput: tool.kind === 'tool_result' ? tool.outputSnippet : undefined,
    toolCallStatus: tool.kind === 'tool_result' ? 'done' : 'running',
  });
  return upsertMessage(beforeTool, message);
}

export function reduceChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  event: ChatTranscriptEvent,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  if (event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'answer') {
    return reduceTextEvent(messages, event, metadata);
  }
  if (event.kind === 'progress') return reduceProgressEvent(messages, event, metadata);
  return reduceToolEvent(messages, event, metadata);
}

export function finalizeStoppedChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  marker: string,
  metadata: ChatTranscriptMetadata,
): PersistedChatTranscriptMessage[] {
  const parsedMarker = z.string().trim().min(1).parse(marker);
  const answerIndexes = messages
    .map((message, index) => message.kind === 'assistant_answer' ? index : -1)
    .filter((index) => index >= 0);
  if (answerIndexes.length > 1) {
    throw new Error('Stopped chat transcript contains multiple answer rows.');
  }

  const terminal = messages.map((message) => (
    message.kind === 'assistant_tool_call' && message.toolCallStatus === 'running'
      ? ChatTranscriptMessageSchema.parse({ ...message, toolCallStatus: 'stopped' })
      : message
  ));
  const answerIndex = answerIndexes[0];
  const finalized = answerIndex === undefined
    ? [
      ...terminal,
      textMessage(
        `${metadata.messageIdPrefix}-answer-stopped`,
        'assistant_answer',
        parsedMarker,
        metadata,
      ),
    ]
    : terminal.map((message, index) => index === answerIndex
      ? textMessage(
        message.id,
        'assistant_answer',
        message.content ? `${message.content}\n\n${parsedMarker}` : parsedMarker,
        metadata,
      )
      : message);

  return finalized.map((message) => PersistedChatTranscriptMessageSchema.parse(message));
}
