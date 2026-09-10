import { z } from 'zod';
import { ImageDataUrlSchema } from './image.js';
import {
  ChatAnswerCompletionSchema,
  ChatStreamProgressSchema,
  ChatStreamQueuedUserMessageSchema,
  ChatStreamTextDeltaSchema,
  ChatStreamToolEventSchema,
  ChatStreamUsageEventSchema,
  ChatToolExecutionStateSchema,
  ChatTranscriptMessageSchema,
  PersistedChatTranscriptMessageSchema,
  toolCallStatusForExecutionState,
  type ChatStreamTextDelta,
  type ChatTranscriptMessage,
  type PersistedChatTranscriptMessage,
} from './chat.js';

/**
 * What the journal knows about a call's outcome, as opposed to the preview a live frame carries.
 * `output` is null while no result has been recorded, and the complete text once one has.
 */
/** A user message as a display row needs it: the run's own submission or a queued steering note. */
export const ChatSubmittedUserMessageSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
});
export type ChatSubmittedUserMessage = z.infer<typeof ChatSubmittedUserMessageSchema>;

export const ChatToolOutcomeSchema = z.strictObject({
  toolCallId: z.string().trim().min(1),
  executionState: ChatToolExecutionStateSchema,
  exitCode: z.number().int().nullable(),
  output: z.string().nullable(),
  outputTokens: z.number().int().nonnegative(),
  outputTokensEstimated: z.boolean(),
});
export type ChatToolOutcome = z.infer<typeof ChatToolOutcomeSchema>;

export const ChatTranscriptEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer_completed'), answer: ChatAnswerCompletionSchema }),
  z.strictObject({ kind: z.literal('thinking'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('narration'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('answer'), delta: ChatStreamTextDeltaSchema }),
  z.strictObject({ kind: z.literal('progress'), progress: ChatStreamProgressSchema }),
  z.strictObject({ kind: z.literal('tool'), tool: ChatStreamToolEventSchema }),
  z.strictObject({ kind: z.literal('usage'), usage: ChatStreamUsageEventSchema }),
  z.strictObject({ kind: z.literal('user_message'), message: ChatStreamQueuedUserMessageSchema }),
  z.strictObject({ kind: z.literal('tool_outcome'), outcome: ChatToolOutcomeSchema }),
  z.strictObject({ kind: z.literal('submission'), message: ChatSubmittedUserMessageSchema }),
]);
export type ChatTranscriptEvent = z.infer<typeof ChatTranscriptEventSchema>;

export const ChatTranscriptMetadataSchema = z.strictObject({
  messageIdPrefix: z.string().min(1),
  sourceRunId: z.string().nullable(),
  createdAtUtc: z.string().min(1),
});
export type ChatTranscriptMetadata = z.infer<typeof ChatTranscriptMetadataSchema>;

/**
 * Namespaces one engine request's transcript rows. The `stopped-` spelling is the format already
 * on disk; it names the writer, not the outcome, and completed runs share it so a row's identity
 * does not depend on how its run happened to end.
 */
export function buildChatRunMessageIdPrefix(requestId: string): string {
  return `stopped-${z.string().min(1).parse(requestId)}`;
}

/**
 * The one place a chat tool row's identity is constructed. Every writer and every reader builds
 * the same string from the same two parts, so a join is exact equality instead of parsing a
 * prefix back out of an id that another writer may have shaped differently.
 */
export function buildChatToolMessageId(messageIdPrefix: string, toolCallId: string): string {
  const prefix = z.string().min(1).parse(messageIdPrefix);
  const callId = z.string().min(1).parse(toolCallId);
  return `${prefix}-tool-${callId}`;
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

export function buildChatTextMessageId(
  kind: 'thinking' | 'narration' | 'answer',
  turn: number,
  metadata: Pick<ChatTranscriptMetadata, 'messageIdPrefix'>,
): string {
  return `${metadata.messageIdPrefix}-${kind}-${turn}`;
}

function reduceTextEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'thinking' | 'narration' | 'answer' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const narrationId = buildChatTextMessageId('narration', event.delta.turn, metadata);
  const promotedNarration = event.kind === 'answer'
    ? messages.find((message) => (
      message.id === narrationId
      && (message.kind === 'assistant_narration' || message.kind === 'assistant_progress' || message.kind === 'assistant_answer')
    ))
    : undefined;
  const id = promotedNarration?.id ?? buildChatTextMessageId(event.kind, event.delta.turn, metadata);
  const existing = messages.find((message) => message.id === id);
  const content = applyChatStreamTextDelta(existing?.content ?? '', event.delta);
  if (!content && !existing && event.kind !== 'answer') return [...messages];

  const kind = event.kind === 'thinking'
    ? 'assistant_thinking'
    : event.kind === 'narration'
      ? 'assistant_narration'
      : 'assistant_answer';
  return upsertMessage(messages, existing
    ? ChatTranscriptMessageSchema.parse({ ...existing, kind, content })
    : textMessage(id, kind, content, metadata));
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
  const existing = messages.find(
    (message) => message.id === buildChatToolMessageId(metadata.messageIdPrefix, tool.toolCallId),
  );
  // A live frame only ever advances the state; a journal-derived outcome is what settles it.
  const executionState = tool.kind === 'tool_result'
    ? 'completed'
    : existing?.toolCallExecutionState ?? 'executing';
  const beforeTool = tool.kind === 'tool_start'
    ? messages.map((message) => (
      message.id === buildChatTextMessageId('narration', tool.turn, metadata)
      && message.kind === 'assistant_narration'
        ? ChatTranscriptMessageSchema.parse({ ...message, kind: 'assistant_progress' })
        : message
    ))
    : [...messages];
  const message = ChatTranscriptMessageSchema.parse({
    id: buildChatToolMessageId(metadata.messageIdPrefix, tool.toolCallId),
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
    // A live frame carries a preview, never the model-visible result. Leaving `toolCallOutput`
    // absent here is what stops a 200-character preview from being replayed later as if it were
    // the whole thing; durable history is hydrated from the run transcript before it is saved.
    toolCallOutputSnippet: tool.kind === 'tool_result' ? tool.outputSnippet : undefined,
    toolCallExecutionState: executionState,
    toolCallStatus: toolCallStatusForExecutionState(executionState),
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
  const thinkingId = buildChatTextMessageId('thinking', event.usage.turn, metadata);
  const answerIndex = findAnswerIndex(messages);
  return messages.map((message, index) => {
    if (message.id === thinkingId && message.kind === 'assistant_thinking') {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        thinkingTokens: event.usage.record.thinkingTokens,
        thinkingTokensEstimated: event.usage.record.thinkingTokensEstimated,
      });
    }
    if (index === answerIndex) {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        outputTokensEstimate: event.usage.totals.outputTokens,
        outputTokensEstimated: event.usage.totals.outputTokensEstimatedCount > 0,
      });
    }
    return message;
  });
}

/**
 * A queued message the engine appended mid-run. Its row keeps the queue id, so the bubble a client
 * shows live, the row the stopped or completed turn persists, and the ledger entry the server
 * cleans up are all the same identity; a later delivery never overwrites an earlier one.
 */
function reduceUserMessageEvent(
  messages: readonly ChatTranscriptMessage[],
  message: ChatSubmittedUserMessage,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  return upsertMessage(messages, ChatTranscriptMessageSchema.parse({
    id: message.id,
    role: 'user',
    kind: 'user_text',
    content: message.content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc: metadata.createdAtUtc,
    sourceRunId: metadata.sourceRunId,
    images: message.images,
  }));
}

/**
 * Settles a tool row from durable evidence: the complete result replaces the live preview and the
 * execution state decides the display status. A call with no projected row yet is left alone.
 */
function reduceToolOutcomeEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'tool_outcome' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const id = buildChatToolMessageId(metadata.messageIdPrefix, event.outcome.toolCallId);
  const existing = messages.find((message) => message.id === id);
  if (existing === undefined || existing.kind !== 'assistant_tool_call') return [...messages];
  return upsertMessage(messages, ChatTranscriptMessageSchema.parse({
    ...existing,
    toolCallExitCode: event.outcome.exitCode,
    ...(event.outcome.output === null ? {} : { toolCallOutput: event.outcome.output }),
    outputTokensEstimate: event.outcome.outputTokens,
    outputTokensEstimated: event.outcome.outputTokensEstimated,
    toolCallExecutionState: event.outcome.executionState,
    toolCallStatus: toolCallStatusForExecutionState(event.outcome.executionState),
  }));
}

export function reduceChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  event: ChatTranscriptEvent,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  if (event.kind === 'answer_completed') {
    const answerIndex = findAnswerIndex(messages);
    const existing = answerIndex === null ? undefined : messages[answerIndex];
    return upsertMessage(messages, ChatTranscriptMessageSchema.parse({
      ...(existing ?? textMessage(`${metadata.messageIdPrefix}-answer-final`, 'assistant_answer', '', metadata)),
      ...event.answer,
    }));
  }
  if (event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'answer') {
    return reduceTextEvent(messages, event, metadata);
  }
  if (event.kind === 'progress') return reduceProgressEvent(messages, event, metadata);
  if (event.kind === 'usage') return reduceUsageEvent(messages, event, metadata);
  if (event.kind === 'user_message') return reduceUserMessageEvent(messages, event.message, metadata);
  if (event.kind === 'submission') return reduceUserMessageEvent(messages, event.message, metadata);
  if (event.kind === 'tool_outcome') return reduceToolOutcomeEvent(messages, event, metadata);
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
      ? ChatTranscriptMessageSchema.parse({
        ...message,
        content: message.content ? `${message.content}\n\n${parsedMarker}` : parsedMarker,
      })
      : message);

  return finalized.map((message) => PersistedChatTranscriptMessageSchema.parse(message));
}
