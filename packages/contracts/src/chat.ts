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

const ChatMessageBaseSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']),
  content: z.string(), inputTokensEstimate: z.number(), outputTokensEstimate: z.number(), thinkingTokens: z.number(),
  inputTokensEstimated: z.boolean().optional(), outputTokensEstimated: z.boolean().optional(), thinkingTokensEstimated: z.boolean().optional(),
  promptCacheTokens: z.number().nullable().optional(), promptEvalTokens: z.number().nullable().optional(),
  promptTokensPerSecond: z.number().nullable().optional(), generationTokensPerSecond: z.number().nullable().optional(),
  requestDurationMs: z.number().nullable().optional(), promptEvalDurationMs: z.number().nullable().optional(),
  generationDurationMs: z.number().nullable().optional(), requestStartedAtUtc: z.string().nullable().optional(),
  thinkingStartedAtUtc: z.string().nullable().optional(), thinkingEndedAtUtc: z.string().nullable().optional(),
  answerStartedAtUtc: z.string().nullable().optional(), answerEndedAtUtc: z.string().nullable().optional(),
  speculativeAcceptedTokens: z.number().nullable().optional(), speculativeGeneratedTokens: z.number().nullable().optional(),
  associatedToolTokens: z.number().nullable().optional(), thinkingContent: z.string().nullable().optional(),
  toolCallCommand: z.string().nullable().optional(), toolCallActivityKind: ToolActivityKindSchema.optional(), toolCallActivitySubject: ToolActivitySubjectSchema.optional(), toolCallTurn: z.number().nullable().optional(),
  toolCallMaxTurns: z.number().nullable().optional(), toolCallExitCode: z.number().nullable().optional(),
  toolCallPromptTokenCount: z.number().nullable().optional(), toolCallOutputSnippet: z.string().nullable().optional(),
  toolCallOutput: z.string().nullable().optional(), toolCallStatus: z.enum(['running', 'done']).optional(),
  groundingStatus: z.enum(['ungrounded', 'snippet_only', 'fetched']).nullable().optional(),
  createdAtUtc: z.string(), sourceRunId: z.string().nullable().optional(), compressedIntoSummary: z.boolean().optional(),
  images: z.array(ImageDataUrlSchema).optional(),
  imageMeta: z.array(ImageMetadataSchema).optional(),
  removedImageCount: z.number().int().nonnegative().optional(),
});

export const ChatToolCallMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('assistant'),
  kind: z.literal('assistant_tool_call'),
  toolCallCommand: z.string().trim().min(1),
  toolCallActivityKind: ToolActivityKindSchema,
  toolCallActivitySubject: ToolActivitySubjectSchema,
  toolCallTurn: z.number().int().positive(),
  toolCallMaxTurns: z.number().int().positive(),
  toolCallExitCode: z.number().int().nullable(),
  toolCallStatus: z.enum(['running', 'done']),
});
export type ChatToolCallMessage = z.infer<typeof ChatToolCallMessageSchema>;

export const ChatRepoAgentApprovalMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('user'),
  kind: z.literal('repo_agent_approval'),
  approvalDecision: z.enum(['approve', 'deny', 'abort']),
  approvalToolName: z.string().min(1),
  approvalCommand: z.string().min(1),
  approvalReason: z.string().nullable(),
});
export type ChatRepoAgentApprovalMessage = z.infer<typeof ChatRepoAgentApprovalMessageSchema>;

const PersistedChatNonToolMessageSchema = ChatMessageBaseSchema.extend({
  kind: z.enum([
    'user_text',
    'assistant_answer',
    'assistant_thinking',
    'tool_image',
    'compaction_summary',
  ]),
});

const LiveOnlyChatMessageSchema = ChatMessageBaseSchema.extend({
  role: z.literal('assistant'),
  kind: z.enum(['assistant_narration', 'assistant_progress']),
});

export const PersistedChatMessageSchema = z.discriminatedUnion('kind', [
  ChatToolCallMessageSchema,
  ChatRepoAgentApprovalMessageSchema,
  PersistedChatNonToolMessageSchema,
]);
export type PersistedChatMessage = z.infer<typeof PersistedChatMessageSchema>;

export const LiveChatMessageSchema = z.discriminatedUnion('kind', [
  ChatToolCallMessageSchema,
  ChatRepoAgentApprovalMessageSchema,
  PersistedChatNonToolMessageSchema,
  LiveOnlyChatMessageSchema,
]);
export type LiveChatMessage = z.infer<typeof LiveChatMessageSchema>;

export const ChatPromptContextSchema = z.object({
  id: z.string(), role: z.literal('system'), kind: z.literal('system_context'),
  label: z.string(), content: z.string(), createdAtUtc: z.string(), deletable: z.literal(false),
});
export type ChatPromptContext = z.infer<typeof ChatPromptContextSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(), title: z.string(), modelPresetId: z.string().trim().min(1),
  modelPreset: ModelRuntimePresetSchema.optional(),
  model: z.string().nullable(), contextWindowTokens: z.number(),
  thinkingEnabled: z.boolean().optional(), webSearchEnabled: z.boolean().optional(), presetId: z.string().optional(),
  mode: z.enum(['chat', 'plan', 'repo-search']).optional(), planRepoRoot: z.string().optional(),
  createdAtUtc: z.string(), updatedAtUtc: z.string(),
  messages: z.array(PersistedChatMessageSchema), promptContext: ChatPromptContextSchema.optional(),
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

export const ChatRepoAgentStreamRequestSchema = z.strictObject({
  content: z.string().trim().min(1),
  images: z.array(ImageDataUrlSchema).optional(),
  repoRoot: z.string().trim().min(1).optional(),
  approval: z.enum(['interactive', 'auto', 'off']).optional(),
  maxTurns: z.number().int().positive().optional(),
  operationId: z.string().uuid(),
});
export type ChatRepoAgentStreamRequest = z.infer<typeof ChatRepoAgentStreamRequestSchema>;

export const ChatOperationStatusResponseSchema = z.strictObject({
  operationKind: ChatSessionOperationKindSchema,
  startedAtUtc: z.string().datetime(),
});
export type ChatOperationStatusResponse = z.infer<typeof ChatOperationStatusResponseSchema>;

export const ChatOperationIdSchema = z.string().uuid();
export type ChatOperationId = z.infer<typeof ChatOperationIdSchema>;
export const StopChatOperationRequestSchema = z.strictObject({ operationId: ChatOperationIdSchema });
export type StopChatOperationRequest = z.infer<typeof StopChatOperationRequestSchema>;
export const StopChatOperationResponseSchema = z.strictObject({
  ok: z.literal(true),
  operationKind: ChatSessionOperationKindSchema,
});
export type StopChatOperationResponse = z.infer<typeof StopChatOperationResponseSchema>;

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

const ChatStreamApprovalWithoutRunIdSchema = ChatStreamApprovalSchema.omit({ runId: true });
export const ActiveChatRepoAgentResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ runId: z.string().uuid(), status: z.literal('running') }),
  z.strictObject({
    runId: z.string().uuid(),
    status: z.literal('approval_required'),
    approval: ChatStreamApprovalWithoutRunIdSchema,
  }),
]);
export type ActiveChatRepoAgentResponse = z.infer<typeof ActiveChatRepoAgentResponseSchema>;
