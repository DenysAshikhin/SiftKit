import { z } from 'zod';
import { ModelRuntimePresetSchema } from './config.js';
import { ImageDataUrlSchema, ImageMetadataSchema } from './image.js';

export const ToolActivityKindSchema = z.enum([
  'read',
  'search',
  'edit',
  'validate',
  'web_search',
  'web_fetch',
  'command',
]);
export type ToolActivityKind = z.infer<typeof ToolActivityKindSchema>;

export const ToolActivitySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), value: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('host'), value: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type ToolActivitySubject = z.infer<typeof ToolActivitySubjectSchema>;

export const ToolActivitySchema = z.strictObject({
  activityKind: ToolActivityKindSchema,
  activitySubject: ToolActivitySubjectSchema,
});
export type ToolActivity = z.infer<typeof ToolActivitySchema>;

const ChatStreamToolCommonFields = {
  toolCallId: z.string().trim().min(1),
  turn: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  activityKind: ToolActivityKindSchema,
  activitySubject: ToolActivitySubjectSchema,
  command: z.string().trim().min(1),
  promptTokenCount: z.number().int().nonnegative(),
} as const;

export const ChatStreamToolEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...ChatStreamToolCommonFields,
    kind: z.literal('tool_start'),
  }),
  z.strictObject({
    ...ChatStreamToolCommonFields,
    kind: z.literal('tool_result'),
    exitCode: z.number().int(),
    outputSnippet: z.string(),
    outputTokens: z.number().int().nonnegative(),
    outputTokensEstimated: z.boolean(),
  }),
]);
export type ChatStreamToolEvent = z.infer<typeof ChatStreamToolEventSchema>;

export const ChatTurnTokenRecordSchema = z.object({
  turn: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  generatedChars: z.number().int().nonnegative(),
  thinkingTokensEstimated: z.boolean(),
  outputTokensEstimated: z.boolean(),
});
export type ChatTurnTokenRecord = z.infer<typeof ChatTurnTokenRecordSchema>;

export const ChatTurnTokenTotalsSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  thinkingTokensEstimatedCount: z.number().int().nonnegative(),
  outputTokensEstimatedCount: z.number().int().nonnegative(),
});
export type ChatTurnTokenTotals = z.infer<typeof ChatTurnTokenTotalsSchema>;

export const ChatStreamUsageEventSchema = z.object({
  turn: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  record: ChatTurnTokenRecordSchema,
  totals: ChatTurnTokenTotalsSchema,
  charsPerToken: z.number().positive(),
});
export type ChatStreamUsageEvent = z.infer<typeof ChatStreamUsageEventSchema>;

/**
 * Published before a turn generates anything: `promptTokens` is the context the turn is about
 * to run against, measured by the backend, and `charsPerToken` is the ratio that sizes the
 * text streamed after it. Together they let the bar move from the first streamed character
 * without ever estimating the base.
 */
export const ChatStreamPromptEventSchema = z.object({
  turn: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  charsPerToken: z.number().positive(),
});
export type ChatStreamPromptEvent = z.infer<typeof ChatStreamPromptEventSchema>;

export const ToolCallStatusSchema = z.enum(['running', 'done', 'stopped']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/**
 * Where a tool call actually got to. `not_started` means the process died before the command ran;
 * `uncertain` means it may have run and its outcome was never recorded. They are deliberately
 * different, because only the second one requires verifying the world before retrying.
 */
export const ChatToolExecutionStateSchema = z.enum([
  'proposed',
  'pending_approval',
  'executing',
  'completed',
  'rejected',
  'not_started',
  'uncertain',
]);
export type ChatToolExecutionState = z.infer<typeof ChatToolExecutionStateSchema>;

/**
 * The display lifecycle is derived from execution state in one place, so a row can never claim a
 * status its evidence does not support.
 */
export function toolCallStatusForExecutionState(state: ChatToolExecutionState): ToolCallStatus {
  if (state === 'completed' || state === 'rejected') return 'done';
  if (state === 'not_started' || state === 'uncertain') return 'stopped';
  return 'running';
}
export const ChatTranscriptRoleSchema = z.enum(['user', 'assistant']);
export type ChatTranscriptRole = z.infer<typeof ChatTranscriptRoleSchema>;

export const ChatTranscriptMessageKindSchema = z.enum([
  'user_text',
  'assistant_answer',
  'assistant_thinking',
  'assistant_tool_call',
  'assistant_narration',
  'assistant_progress',
  'tool_image',
  'compaction_summary',
  'repo_agent_approval',
]);
export type ChatTranscriptMessageKind = z.infer<typeof ChatTranscriptMessageKindSchema>;

const ChatMessageBaseSchema = z.object({
  id: z.string(), role: ChatTranscriptRoleSchema,
  content: z.string(), inputTokensEstimate: z.number(), outputTokensEstimate: z.number(), thinkingTokens: z.number(),
  inputTokensEstimated: z.boolean().optional(), outputTokensEstimated: z.boolean().optional(), thinkingTokensEstimated: z.boolean().optional(),
  promptCacheTokens: z.number().nullable().optional(), promptEvalTokens: z.number().nullable().optional(),
  promptTokensPerSecond: z.number().nullable().optional(), generationTokensPerSecond: z.number().nullable().optional(),
  requestDurationMs: z.number().nullable().optional(), promptEvalDurationMs: z.number().nullable().optional(),
  generationDurationMs: z.number().nullable().optional(), requestStartedAtUtc: z.string().nullable().optional(),
  thinkingStartedAtUtc: z.string().nullable().optional(), thinkingEndedAtUtc: z.string().nullable().optional(),
  answerStartedAtUtc: z.string().nullable().optional(), answerEndedAtUtc: z.string().nullable().optional(),
  speculativeAcceptedTokens: z.number().nullable().optional(), speculativeGeneratedTokens: z.number().nullable().optional(),
  thinkingContent: z.string().nullable().optional(),
  toolCallCommand: z.string().nullable().optional(), toolCallActivityKind: ToolActivityKindSchema.optional(), toolCallActivitySubject: ToolActivitySubjectSchema.optional(), toolCallTurn: z.number().nullable().optional(),
  toolCallMaxTurns: z.number().nullable().optional(), toolCallExitCode: z.number().nullable().optional(),
  toolCallPromptTokenCount: z.number().nullable().optional(), toolCallOutputSnippet: z.string().nullable().optional(),
  toolCallOutput: z.string().nullable().optional(), toolCallStatus: ToolCallStatusSchema.optional(),
  toolCallExecutionState: ChatToolExecutionStateSchema.optional(),
  groundingStatus: z.enum(['ungrounded', 'snippet_only', 'fetched']).nullable().optional(),
  createdAtUtc: z.string(), sourceRunId: z.string().nullable().optional(), compressedIntoSummary: z.boolean().optional(),
  images: z.array(ImageDataUrlSchema).optional(),
  imageMeta: z.array(ImageMetadataSchema).optional(),
  removedImageCount: z.number().int().nonnegative().optional(),
});

const ChatToolCallFields = {
  role: z.literal('assistant'),
  kind: z.literal('assistant_tool_call'),
  toolCallCommand: z.string().trim().min(1),
  toolCallActivityKind: ToolActivityKindSchema,
  toolCallActivitySubject: ToolActivitySubjectSchema,
  toolCallTurn: z.number().int().positive(),
  toolCallMaxTurns: z.number().int().positive(),
  toolCallExitCode: z.number().int().nullable(),
} as const;

export const ChatTranscriptToolCallMessageSchema = ChatMessageBaseSchema.extend({
  ...ChatToolCallFields,
  toolCallStatus: ToolCallStatusSchema,
  toolCallExecutionState: ChatToolExecutionStateSchema,
});
export type ChatTranscriptToolCallMessage = z.infer<typeof ChatTranscriptToolCallMessageSchema>;

const ReplayableToolCallMessageSchema = ChatTranscriptToolCallMessageSchema.extend({
  toolCallStatus: z.literal('done'),
});

export const ChatRepoAgentApprovalMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('user'),
  kind: z.literal('repo_agent_approval'),
  approvalDecision: z.enum(['approve', 'deny', 'abort']),
  approvalToolName: z.string().min(1),
  approvalCommand: z.string().min(1),
  approvalReason: z.string().nullable(),
});
export type ChatRepoAgentApprovalMessage = z.infer<typeof ChatRepoAgentApprovalMessageSchema>;

const ChatTranscriptNonToolMessageSchema = ChatMessageBaseSchema.extend({
  kind: z.enum([
    'user_text',
    'assistant_answer',
    'assistant_thinking',
    'tool_image',
    'compaction_summary',
  ]),
});

const ChatTranscriptStreamTextMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('assistant'),
  kind: z.enum(['assistant_narration', 'assistant_progress']),
});

export const ChatTranscriptMessageSchema = z.discriminatedUnion('kind', [
  ChatTranscriptToolCallMessageSchema,
  ChatRepoAgentApprovalMessageSchema,
  ChatTranscriptNonToolMessageSchema,
  ChatTranscriptStreamTextMessageSchema,
]);
export type ChatTranscriptMessage = z.infer<typeof ChatTranscriptMessageSchema>;

export const PersistedChatTranscriptMessageSchema = z.discriminatedUnion('kind', [
  ChatTranscriptToolCallMessageSchema,
  ChatRepoAgentApprovalMessageSchema,
  ChatTranscriptNonToolMessageSchema,
  ChatTranscriptStreamTextMessageSchema,
]);
export type PersistedChatTranscriptMessage = z.infer<typeof PersistedChatTranscriptMessageSchema>;

export const ReplayableChatMessageSchema = z.discriminatedUnion('kind', [
  ReplayableToolCallMessageSchema,
  ChatRepoAgentApprovalMessageSchema,
  ChatTranscriptNonToolMessageSchema,
]);
export type ReplayableChatMessage = z.infer<typeof ReplayableChatMessageSchema>;

export function isReplayableChatMessage(
  message: ChatTranscriptMessage,
): message is ReplayableChatMessage {
  return ReplayableChatMessageSchema.safeParse(message).success;
}

export const ChatPromptContextSchema = z.object({
  id: z.string(), role: z.literal('system'), kind: z.literal('system_context'),
  label: z.string(), content: z.string(), createdAtUtc: z.string(), deletable: z.literal(false),
});
export type ChatPromptContext = z.infer<typeof ChatPromptContextSchema>;

export const ChatSessionModeSchema = z.enum(['chat', 'plan', 'repo-search']);
export type ChatSessionMode = z.infer<typeof ChatSessionModeSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(), title: z.string(), modelPresetId: z.string().trim().min(1),
  modelPreset: ModelRuntimePresetSchema.optional(),
  model: z.string().nullable(), contextWindowTokens: z.number(),
  thinkingEnabled: z.boolean().optional(), webSearchEnabled: z.boolean().optional(), presetId: z.string().optional(),
  mode: ChatSessionModeSchema.optional(), planRepoRoot: z.string(),
  createdAtUtc: z.string(), updatedAtUtc: z.string(),
  messages: z.array(PersistedChatTranscriptMessageSchema), promptContext: ChatPromptContextSchema.optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ContextUsageSchema = z.object({
  contextWindowTokens: z.number(), usedTokens: z.number(), chatUsedTokens: z.number(), thinkingUsedTokens: z.number(),
  toolUsedTokens: z.number(), imageUsedTokens: z.number().int().nonnegative(),
  totalUsedTokens: z.number(), remainingTokens: z.number(), warnThresholdTokens: z.number(),
  shouldCondense: z.boolean(), estimatedTokenFallbackTokens: z.number(), providerOverheadTokens: z.number(),
  effectiveImagePixelCeiling: z.number().int().positive().optional(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const ChatSessionResponseSchema = z.object({ session: ChatSessionSchema, contextUsage: ContextUsageSchema });
export type ChatSessionResponse = z.infer<typeof ChatSessionResponseSchema>;
export const ChatSessionsResponseSchema = z.object({ sessions: z.array(ChatSessionSchema) });
export type ChatSessionsResponse = z.infer<typeof ChatSessionsResponseSchema>;

export const ChatSessionOperationKindSchema = z.enum(['message', 'plan', 'repo-search', 'repo-agent', 'condense']);
export type ChatSessionOperationKind = z.infer<typeof ChatSessionOperationKindSchema>;
export const ChatSessionBusyResponseSchema = z.object({
  error: z.literal('Chat session already has an active operation.'),
  sessionId: z.string().min(1),
  operationKind: ChatSessionOperationKindSchema,
});
export type ChatSessionBusyResponse = z.infer<typeof ChatSessionBusyResponseSchema>;

export const RepoAgentApproveDecisionSchema = z.strictObject({ decision: z.literal('approve') });
export const RepoAgentDenyDecisionSchema = z.strictObject({
  decision: z.literal('deny'),
  reason: z.string().trim().min(1),
});
export const RepoAgentAbortDecisionSchema = z.strictObject({ decision: z.literal('abort') });
export const RepoAgentDecisionSchema = z.discriminatedUnion('decision', [
  RepoAgentApproveDecisionSchema,
  RepoAgentDenyDecisionSchema,
  RepoAgentAbortDecisionSchema,
]);
export type RepoAgentDecision = z.infer<typeof RepoAgentDecisionSchema>;

export const ApprovalModeSchema = z.enum(['interactive', 'auto', 'off']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export const DEFAULT_APPROVAL_MODE = 'auto' satisfies ApprovalMode;
export const APPROVAL_MODE_ERROR = `approval must be one of: ${ApprovalModeSchema.options.join(', ')}.`;

export const ChatRepoAgentStreamRequestSchema = z.strictObject({
  content: z.string().trim().min(1),
  images: z.array(ImageDataUrlSchema).optional(),
  repoRoot: z.string().trim().min(1).optional(),
  approval: ApprovalModeSchema,
  maxTurns: z.number().int().positive().optional(),
  operationId: z.string().uuid(),
});
export type ChatRepoAgentStreamRequest = z.infer<typeof ChatRepoAgentStreamRequestSchema>;

export const ChatOperationIdSchema = z.string().uuid();
export type ChatOperationId = z.infer<typeof ChatOperationIdSchema>;
export const StopChatOperationRequestSchema = z.strictObject({ operationId: ChatOperationIdSchema });
export type StopChatOperationRequest = z.infer<typeof StopChatOperationRequestSchema>;
export const StopChatOperationResponseSchema = z.strictObject({
  ok: z.literal(true),
  operationKind: ChatSessionOperationKindSchema,
});
export type StopChatOperationResponse = z.infer<typeof StopChatOperationResponseSchema>;

/** The chat operations whose engine path consumes queued messages at safe boundaries. */
export const ChatQueueOperationKindSchema = z.enum(['message', 'plan', 'repo-search', 'repo-agent']);
export type ChatQueueOperationKind = z.infer<typeof ChatQueueOperationKindSchema>;

/** Queue limits. Full contents are bounded separately from the previews the listing carries. */
export const CHAT_QUEUE_MAX_PENDING = 50;
export const CHAT_QUEUE_MAX_DELIVERED_PREVIEWS = 50;
export const CHAT_QUEUE_MAX_CONTENT_CHARS = 200_000;
export const CHAT_QUEUE_MAX_IMAGES = 8;
export const CHAT_QUEUE_PREVIEW_CHARS = 200;

export const ChatQueuedMessageIdSchema = z.string().uuid();
export type ChatQueuedMessageId = z.infer<typeof ChatQueuedMessageIdSchema>;
export const ChatQueuedMessageStateSchema = z.enum(['pending', 'delivered']);
export type ChatQueuedMessageState = z.infer<typeof ChatQueuedMessageStateSchema>;

/**
 * Everything about a send except its text and images, captured at enqueue time so a queued
 * message later starts exactly the operation the user would have started by pressing Send.
 */
export const ChatQueueSendOptionsSchema = z.strictObject({
  operationKind: ChatQueueOperationKindSchema,
  approval: ApprovalModeSchema.optional(),
  repoRoot: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  webSearchOverride: z.enum(['on', 'off']).optional(),
  availableModels: z.array(z.string()).optional(),
  mockResponses: z.array(z.json()).optional(),
  mockCommandResults: z.record(z.string(), z.json()).optional(),
});
export type ChatQueueSendOptions = z.infer<typeof ChatQueueSendOptionsSchema>;

export const ChatQueueEnqueueRequestSchema = z.strictObject({
  /** Client-minted idempotency key: a retried enqueue with the same id and content is one entry. */
  id: ChatQueuedMessageIdSchema,
  /** A busy submission may continue this normally completed operation if it just settled. */
  afterOperationId: ChatOperationIdSchema.optional(),
  content: z.string().max(CHAT_QUEUE_MAX_CONTENT_CHARS),
  images: z.array(ImageDataUrlSchema).max(CHAT_QUEUE_MAX_IMAGES).default([]),
  options: ChatQueueSendOptionsSchema,
}).refine((request) => request.content.trim().length > 0 || request.images.length > 0, {
  message: 'Expected content or images.',
});
export type ChatQueueEnqueueRequest = z.infer<typeof ChatQueueEnqueueRequestSchema>;

/** Selected pending message only: full text for editing without enlarging status frames. */
export const ChatQueueMessageResponseSchema = z.strictObject({
  message: z.strictObject({
    id: ChatQueuedMessageIdSchema,
    content: z.string().max(CHAT_QUEUE_MAX_CONTENT_CHARS),
    revision: z.number().int().positive(),
    imageCount: z.number().int().nonnegative(),
  }),
});
export type ChatQueueMessageResponse = z.infer<typeof ChatQueueMessageResponseSchema>;

export const ChatQueueEditRequestSchema = z.strictObject({
  content: z.string().trim().min(1).max(CHAT_QUEUE_MAX_CONTENT_CHARS),
  /** The revision the editor saw; a row that moved on since is reported back, not overwritten. */
  revision: z.number().int().positive(),
});
export type ChatQueueEditRequest = z.infer<typeof ChatQueueEditRequestSchema>;

/** `operationId` names the run to stop first; null delivers the pending batch to an idle session. */
export const ChatQueueForceRequestSchema = z.strictObject({ id: z.string().uuid(), operationId: ChatOperationIdSchema.nullable() });
export type ChatQueueForceRequest = z.infer<typeof ChatQueueForceRequestSchema>;

export const ChatQueuedMessagePreviewSchema = z.strictObject({
  id: ChatQueuedMessageIdSchema,
  position: z.number().int().nonnegative(),
  preview: z.string().max(CHAT_QUEUE_PREVIEW_CHARS),
  contentChars: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  state: ChatQueuedMessageStateSchema,
  createdAtUtc: z.string().datetime(),
});
export type ChatQueuedMessagePreview = z.infer<typeof ChatQueuedMessagePreviewSchema>;

export const ChatMessageQueueForceStateSchema = z.strictObject({
  id: z.string().uuid(),
  operationId: ChatOperationIdSchema.nullable(),
  phase: z.enum(['stopping', 'sending', 'failed']),
  messageIds: z.array(ChatQueuedMessageIdSchema),
  successorOperationId: ChatOperationIdSchema,
  failureDetail: z.string().nullable(),
});
export type ChatMessageQueueForceState = z.infer<typeof ChatMessageQueueForceStateSchema>;

/** The queue as every client sees it: bounded previews, never full bodies or image data. */
export const ChatMessageQueueStateSchema = z.strictObject({
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  messages: z.array(ChatQueuedMessagePreviewSchema),
  /** Stop paused automatic delivery; pending messages wait for Force now or a new Send. */
  paused: z.boolean(),
  force: ChatMessageQueueForceStateSchema.nullable(),
  activeOperationId: ChatOperationIdSchema.nullable().optional(),
  activeOperationKind: ChatSessionOperationKindSchema.nullable().optional(),
});
export type ChatMessageQueueState = z.infer<typeof ChatMessageQueueStateSchema>;

export const ChatMessageQueueResponseSchema = z.strictObject({ queue: ChatMessageQueueStateSchema });
export type ChatMessageQueueResponse = z.infer<typeof ChatMessageQueueResponseSchema>;
export const ChatMessageQueueConflictResponseSchema = z.strictObject({
  error: z.string().min(1),
  queue: ChatMessageQueueStateSchema,
});
export type ChatMessageQueueConflictResponse = z.infer<typeof ChatMessageQueueConflictResponseSchema>;
export const ChatQueueForceResponseSchema = z.strictObject({
  ok: z.literal(true),
  successorOperationId: ChatOperationIdSchema,
  queue: ChatMessageQueueStateSchema,
});
export type ChatQueueForceResponse = z.infer<typeof ChatQueueForceResponseSchema>;

/** A queued message the engine appended to its transcript; the frame that puts its bubble in place. */
export const ChatStreamQueuedUserMessageSchema = z.strictObject({
  id: ChatQueuedMessageIdSchema,
  turn: z.number().int().nonnegative(),
  boundary: z.enum(['post_tool_batch', 'successor_start']),
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
});
export type ChatStreamQueuedUserMessage = z.infer<typeof ChatStreamQueuedUserMessageSchema>;

/** Every SSE frame name a chat stream can carry. The wire contract, so no caller spells one out. */
export const ChatStreamEventNameSchema = z.enum([
  'thinking',
  'narration',
  'answer',
  'warning',
  'tool_start',
  'tool_result',
  'progress',
  'usage',
  'prompt',
  'approval',
  'approval_state',
  'approval_resolved',
  'attached',
  'submitted',
  'queue',
  'queued_user_message',
  'done',
  'error',
  'ended',
]);
export type ChatStreamEventName = z.infer<typeof ChatStreamEventNameSchema>;

/**
 * Frames after which the server closes the stream. `done` carries the finished session, `error` a
 * failure, and `ended` says the operation finished without a stream payload (a condense, or a turn
 * that exited before it opened its stream) so the reader refetches instead of reporting a break.
 * A body that ends without one of these was cut off.
 */
export const CHAT_STREAM_TERMINAL_EVENT_NAMES = [
  'done',
  'error',
  'ended',
] as const satisfies readonly ChatStreamEventName[];

const TERMINAL_CHAT_STREAM_EVENT_NAMES: ReadonlySet<ChatStreamEventName> = new Set(
  CHAT_STREAM_TERMINAL_EVENT_NAMES,
);

export function isTerminalChatStreamEventName(name: string): boolean {
  const parsed = ChatStreamEventNameSchema.safeParse(name);
  return parsed.success && TERMINAL_CHAT_STREAM_EVENT_NAMES.has(parsed.data);
}

export const ChatStreamTextDeltaSchema = z.object({
  turn: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  text: z.string(),
});
export type ChatStreamTextDelta = z.infer<typeof ChatStreamTextDeltaSchema>;

export const ChatStreamProgressSchema = z.object({
  turn: z.number().int().nonnegative(),
  text: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
});
export type ChatStreamProgress = z.infer<typeof ChatStreamProgressSchema>;

export const ChatStreamApprovalSchema = z.object({
  runId: z.string().uuid(),
  approvalId: z.string().uuid(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});
export type ChatStreamApproval = z.infer<typeof ChatStreamApprovalSchema>;

/** The first frame an attaching client receives; identifies the run it just latched onto. */
export const ChatOperationAttachedEventSchema = z.strictObject({
  operationKind: ChatSessionOperationKindSchema,
  operationId: ChatOperationIdSchema,
  startedAtUtc: z.string().datetime(),
  /** True when the replay buffer dropped older frames, so the replayed transcript starts mid-run. */
  replayTruncated: z.boolean(),
});
export type ChatOperationAttachedEvent = z.infer<typeof ChatOperationAttachedEventSchema>;

/**
 * The prompt that started the run. Persisted only when the turn ends, so without this frame a
 * client that attaches mid-run would show assistant output with no user message above it.
 */
export const ChatStreamSubmittedSchema = z.strictObject({
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
});
export type ChatStreamSubmitted = z.infer<typeof ChatStreamSubmittedSchema>;

/**
 * The authoritative pending-approval state, sent once at the end of a replay. Replaying the raw
 * `approval` frames would resurrect an approval that has since been decided, so the attach path
 * sends live state instead.
 */
export const ChatStreamApprovalStateSchema = z.strictObject({
  approval: ChatStreamApprovalSchema.nullable(),
});
export type ChatStreamApprovalState = z.infer<typeof ChatStreamApprovalStateSchema>;

/** Broadcast when an approval is decided, so every attached client clears the same card. */
export const ChatStreamApprovalResolvedSchema = z.strictObject({
  approval: ChatStreamApprovalSchema,
  decision: RepoAgentDecisionSchema,
  decidedAtUtc: z.string().datetime(),
});
export type ChatStreamApprovalResolved = z.infer<typeof ChatStreamApprovalResolvedSchema>;

export const ActiveChatOperationSchema = z.strictObject({
  sessionId: z.string().min(1),
  operationKind: ChatSessionOperationKindSchema,
  operationId: ChatOperationIdSchema,
  startedAtUtc: z.string().datetime(),
});
export type ActiveChatOperation = z.infer<typeof ActiveChatOperationSchema>;

export const ActiveChatOperationsResponseSchema = z.strictObject({
  operations: z.array(ActiveChatOperationSchema),
});
export type ActiveChatOperationsResponse = z.infer<typeof ActiveChatOperationsResponseSchema>;

const ChatStreamApprovalWithoutRunIdSchema = ChatStreamApprovalSchema.omit({ runId: true });
export const ActiveChatRepoAgentResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ runId: z.string().uuid(), status: z.literal('running'), approvalMode: ApprovalModeSchema }),
  z.strictObject({
    runId: z.string().uuid(),
    status: z.literal('approval_required'),
    approvalMode: ApprovalModeSchema,
    approval: ChatStreamApprovalWithoutRunIdSchema,
  }),
]);
export type ActiveChatRepoAgentResponse = z.infer<typeof ActiveChatRepoAgentResponseSchema>;

export const ChatRepoAgentApprovalModeRequestSchema = z.strictObject({ approval: ApprovalModeSchema });
export type ChatRepoAgentApprovalModeRequest = z.infer<typeof ChatRepoAgentApprovalModeRequestSchema>;
export const ChatRepoAgentDecideResponseSchema = z.strictObject({
  ok: z.literal(true),
  runId: z.string().uuid(),
  decidedAtUtc: z.string().datetime(),
});
export type ChatRepoAgentDecideResponse = z.infer<typeof ChatRepoAgentDecideResponseSchema>;

export const ChatRepoAgentApprovalModeResponseSchema = z.strictObject({
  ok: z.literal(true),
  runId: z.string().uuid(),
  approval: ApprovalModeSchema,
  /** Set when switching to `off` released a parked approval; the client mirrors it as an approve decision. */
  released: z.strictObject({
    approvalId: z.string().uuid(),
    decidedAtUtc: z.string().datetime(),
  }).nullable(),
});
export type ChatRepoAgentApprovalModeResponse = z.infer<typeof ChatRepoAgentApprovalModeResponseSchema>;
