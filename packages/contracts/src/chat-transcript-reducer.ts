import { z } from 'zod';
import {
  ChatStreamProgressSchema,
  ChatStreamTextDeltaSchema,
  ChatStreamToolEventSchema,
  ChatStreamUsageEventSchema,
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
  z.strictObject({ kind: z.literal('usage'), usage: ChatStreamUsageEventSchema }),
]);
export type ChatTranscriptEvent = z.infer<typeof ChatTranscriptEventSchema>;

export const ChatTranscriptMetadataSchema = z.strictObject({
  messageIdPrefix: z.string().min(1),
  sourceRunId: z.string().nullable(),
  createdAtUtc: z.string().min(1),
});
export type ChatTranscriptMetadata = z.infer<typeof ChatTranscriptMetadataSchema>;

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
  // The engine measures every generated token and publishes it on the usage frame. A row that
  // also derived a count from its own text would disagree with the settled transcript.
  return ChatTranscriptMessageSchema.parse({
    id,
    role: 'assistant',
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
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

/**
 * A transcript carries exactly one answer row: the loop finishes or terminal synthesis speaks,
 * never both. A second row means two emitters claimed the same run, and folding a run total onto
 * each of them would double-count it, so the ambiguity fails here instead of being averaged away.
 */
function findAnswerIndex(messages: readonly ChatTranscriptMessage[]): number | null {
  const indexes = messages
    .map((message, index) => message.kind === 'assistant_answer' ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) {
    throw new Error('Chat transcript contains multiple answer rows.');
  }
  return indexes[0] ?? null;
}

/**
 * The frame closes a turn: the estimate-free rows for that turn take the counts the engine
 * measured. `record` is that turn's thinking; `totals` is the run's generated output, which is
 * what the persisted answer row carries, so live and settled agree on the same number.
 */
function reduceUsageEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'usage' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const thinkingId = textMessageId('thinking', event.usage.turn, metadata);
  const answerIndex = findAnswerIndex(messages);
  return messages.map((message, index) => {
    if (message.id === thinkingId && message.kind === 'assistant_thinking') {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        thinkingTokens: event.usage.record.thinkingTokens,
      });
    }
    if (index === answerIndex) {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        outputTokensEstimate: event.usage.totals.outputTokens,
      });
    }
    return message;
  });
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
  if (event.kind === 'usage') return reduceUsageEvent(messages, event, metadata);
  return reduceToolEvent(messages, event, metadata);
}

export function finalizeStoppedChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  marker: string,
  metadata: ChatTranscriptMetadata,
): PersistedChatTranscriptMessage[] {
  const parsedMarker = z.string().trim().min(1).parse(marker);
  const answerIndex = findAnswerIndex(messages);

  const terminal = messages.map((message) => (
    message.kind === 'assistant_tool_call' && message.toolCallStatus === 'running'
      ? ChatTranscriptMessageSchema.parse({ ...message, toolCallStatus: 'stopped' })
      : message
  ));
  const finalized = answerIndex === null
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
