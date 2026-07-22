import { z } from 'zod';

export const ChatMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']),
  kind: z.enum(['user_text', 'assistant_answer', 'assistant_thinking', 'assistant_tool_call']).optional(),
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
  toolCallCommand: z.string().nullable().optional(), toolCallTurn: z.number().nullable().optional(),
  toolCallMaxTurns: z.number().nullable().optional(), toolCallExitCode: z.number().nullable().optional(),
  toolCallPromptTokenCount: z.number().nullable().optional(), toolCallOutputSnippet: z.string().nullable().optional(),
  toolCallOutput: z.string().nullable().optional(), toolCallStatus: z.enum(['running', 'done']).optional(),
  groundingStatus: z.enum(['ungrounded', 'snippet_only', 'fetched']).nullable().optional(),
  createdAtUtc: z.string(), sourceRunId: z.string().nullable(), compressedIntoSummary: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatPromptContextSchema = z.object({
  id: z.string(), role: z.literal('system'), kind: z.literal('system_context'),
  label: z.string(), content: z.string(), createdAtUtc: z.string(), deletable: z.literal(false),
});
export type ChatPromptContext = z.infer<typeof ChatPromptContextSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(), title: z.string(), modelPresetId: z.string().trim().min(1),
  model: z.string().nullable(), contextWindowTokens: z.number(),
  thinkingEnabled: z.boolean().optional(), webSearchEnabled: z.boolean().optional(), presetId: z.string().optional(),
  mode: z.enum(['chat', 'plan', 'repo-search']).optional(), planRepoRoot: z.string().optional(),
  condensedSummary: z.string(), createdAtUtc: z.string(), updatedAtUtc: z.string(),
  messages: z.array(ChatMessageSchema), promptContext: ChatPromptContextSchema.optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ContextUsageSchema = z.object({
  contextWindowTokens: z.number(), usedTokens: z.number(), chatUsedTokens: z.number(), thinkingUsedTokens: z.number(),
  toolUsedTokens: z.number(), totalUsedTokens: z.number(), remainingTokens: z.number(), warnThresholdTokens: z.number(),
  shouldCondense: z.boolean(), estimatedTokenFallbackTokens: z.number(), providerOverheadTokens: z.number(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const ChatSessionResponseSchema = z.object({ session: ChatSessionSchema, contextUsage: ContextUsageSchema });
export type ChatSessionResponse = z.infer<typeof ChatSessionResponseSchema>;
export const ChatSessionsResponseSchema = z.object({ sessions: z.array(ChatSessionSchema) });
export type ChatSessionsResponse = z.infer<typeof ChatSessionsResponseSchema>;

const AutoAppendItemSchema = z.object({
  key: z.enum(['agentsMd', 'repoFileListing']), label: z.string(), enabledDefault: z.boolean(),
  available: z.boolean(), tokenCount: z.number(), tokenSource: z.enum(['llama.cpp', 'estimate']),
});
export const RepoSearchAutoAppendPreviewSchema = z.object({ agentsMd: AutoAppendItemSchema, repoFileListing: AutoAppendItemSchema });
export type RepoSearchAutoAppendPreview = z.infer<typeof RepoSearchAutoAppendPreviewSchema>;
