import { z } from 'zod';
import { ImageDataUrlSchema, ImageMetadataSchema } from './image.js';
import {
  ChatAnswerCompletionSchema,
  ChatRunTerminalCauseSchema,
  type ChatRunTerminalCause,
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
  imageMeta: z.array(ImageMetadataSchema),
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
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('user_usage'), messageId: z.string().min(1), inputTokens: z.number().int().nonnegative(), estimated: z.boolean() }),
  z.strictObject({ kind: z.literal('answer_completed'), answer: ChatAnswerCompletionSchema, messageId: z.string().min(1).optional() }),
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
const ChatMessageIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['thinking', 'narration', 'answer']), turn: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('tool'), toolCallId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('approval'), approvalId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('summary'), revision: z.number().int().positive() }),
  z.strictObject({ kind: z.enum(['user', 'progress', 'answer-final', 'answer-stopped']) }),
]);

export function buildChatMessageId(messageIdPrefix: string, input: z.infer<typeof ChatMessageIdentitySchema>): string {
  const prefix = z.string().min(1).parse(messageIdPrefix);
  const identity = ChatMessageIdentitySchema.parse(input);
  if ('turn' in identity) return `${prefix}-${identity.kind}-${identity.turn}`;
  if (identity.kind === 'tool') return `${prefix}-tool-${identity.toolCallId}`;
  if (identity.kind === 'approval') return `${prefix}-approval-${identity.approvalId}`;
  if (identity.kind === 'summary') return `${prefix}-summary-${identity.revision}`;
  return `${prefix}-${identity.kind}`;
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

function reduceTextEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'thinking' | 'narration' | 'answer' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const narrationId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'narration', turn: event.delta.turn });
  const promotedNarration = event.kind === 'answer'
    ? messages.find((message) => (
      message.id === narrationId
      && (message.kind === 'assistant_narration' || message.kind === 'assistant_progress' || message.kind === 'assistant_answer')
    ))
    : undefined;
  const id = promotedNarration?.id ?? buildChatMessageId(metadata.messageIdPrefix, { kind: event.kind, turn: event.delta.turn });
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
    buildChatMessageId(metadata.messageIdPrefix, { kind: 'progress' }),
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
  const toolMessageId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'tool', toolCallId: tool.toolCallId });
  const narrationId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'narration', turn: tool.turn });
  const existing = messages.find((message) => message.id === toolMessageId);
  if (existing && existing.kind !== 'assistant_tool_call') throw new Error('Tool progress conflicts with an existing message identity.');
  // A live frame only ever advances the state; a journal-derived outcome is what settles it.
  const hasFullResult = typeof existing?.toolCallOutput === 'string';
  const executionState = hasFullResult ? existing.toolCallExecutionState
    : tool.kind === 'tool_result' ? 'completed' : existing?.toolCallExecutionState ?? 'executing';
  const beforeTool = tool.kind === 'tool_start'
    ? messages.map((message) => (
      message.id === narrationId && message.kind === 'assistant_narration'
        ? ChatTranscriptMessageSchema.parse({ ...message, kind: 'assistant_progress' })
        : message
    ))
    : [...messages];
  const message = ChatTranscriptMessageSchema.parse({
    ...existing,
    id: toolMessageId,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: tool.command,
    inputTokensEstimate: 0,
    outputTokensEstimate: hasFullResult ? existing.outputTokensEstimate : tool.kind === 'tool_result' ? tool.outputTokens : 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: hasFullResult ? existing.outputTokensEstimated : tool.kind === 'tool_result' ? tool.outputTokensEstimated : false,
    thinkingTokensEstimated: false,
    createdAtUtc: metadata.createdAtUtc,
    sourceRunId: metadata.sourceRunId,
    toolCallCommand: tool.command,
    toolCallActivityKind: tool.activityKind,
    toolCallActivitySubject: tool.activitySubject,
    toolCallTurn: tool.turn,
    toolCallMaxTurns: tool.maxTurns,
    toolCallExitCode: hasFullResult ? existing.toolCallExitCode : tool.kind === 'tool_result' ? tool.exitCode : null,
    toolCallPromptTokenCount: tool.promptTokenCount,
    // Progress updates a preview; committed full results and finalized execution state survive it.
    toolCallOutputSnippet: tool.kind === 'tool_result' ? tool.outputSnippet : existing?.toolCallOutputSnippet,
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
  const thinkingId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'thinking', turn: event.usage.turn });
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
    imageMeta: message.imageMeta,
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
  const id = buildChatMessageId(metadata.messageIdPrefix, { kind: 'tool', toolCallId: event.outcome.toolCallId });
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
  if (event.kind === 'completed') return messages.filter(message => message.id !== buildChatMessageId(metadata.messageIdPrefix, { kind: 'progress' }));
  if (event.kind === 'user_usage') {
    const user = messages.find(message => message.id === event.messageId && message.role === 'user');
    if (!user) throw new Error('Input usage has no submitted user message.');
    return upsertMessage(messages, { ...user, inputTokensEstimate: event.inputTokens, inputTokensEstimated: event.estimated });
  }
  if (event.kind === 'answer_completed') {
    const answerIndex = findAnswerIndex(messages);
    const existing = answerIndex === null ? messages.find(message => message.id === event.messageId) : messages[answerIndex];
    return upsertMessage(messages, ChatTranscriptMessageSchema.parse({
      ...(existing ?? textMessage(event.messageId ?? buildChatMessageId(metadata.messageIdPrefix, { kind: 'answer-final' }), 'assistant_answer', '', metadata)),
      ...event.answer,
      kind: 'assistant_answer',
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

/** A terminal outcome is metadata; generated text and measured usage remain unchanged. */
export function finalizeChatRunTranscript(
  messages: readonly ChatTranscriptMessage[],
  terminalCause: ChatRunTerminalCause,
  metadata: ChatTranscriptMetadata,
  detail: string | null = null,
): PersistedChatTranscriptMessage[] {
  const cause = ChatRunTerminalCauseSchema.parse(terminalCause);
  findAnswerIndex(messages);
  const progressId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'progress' });
  let terminal = messages.filter(message => cause !== 'completed' || message.id !== progressId).map(message => {
    const { runTerminalCause: previousCause, runTerminalDetail: previousDetail, ...body } = message;
    const retained = previousCause === undefined && previousDetail === undefined ? message : body;
    if (retained.kind !== 'assistant_tool_call') return retained;
    const state = retained.toolCallExecutionState;
    const executionState = state === 'executing' ? 'uncertain'
      : state === 'proposed' || state === 'pending_approval' ? 'not_started' : state;
    return executionState === state ? retained : PersistedChatTranscriptMessageSchema.parse({ ...retained,
      toolCallExecutionState: executionState, toolCallStatus: toolCallStatusForExecutionState(executionState) });
  });
  if (cause === 'completed') return terminal;
  if (terminal.length === 0) terminal = [textMessage(progressId, 'assistant_progress', '', metadata)];
  return terminal.map((message, index) => index === terminal.length - 1 ? { ...message, runTerminalCause: cause, runTerminalDetail: detail } : message);
}
