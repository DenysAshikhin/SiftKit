import { TokenCountSourceSchema } from './prompt-budget.js';
import { z } from '../lib/zod.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { SiftConfig } from '../config/index.js';
import type { ProgressWriter } from '../lib/progress-writer.js';

export type JsonLogger = {
  path: string;
  write: (event: Record<string, JsonSerializable>) => void;
};
import type { RetainedWebToolCall } from '../web-search/web-tool-command.js';
import type { ApprovalGate, ApprovalMode } from './engine/approval-gate.js';
import type { ChatMessage } from './planner-protocol.js';
import { ScorecardSchema } from './engine.js';
import { ContextWarningProgressEventSchema, type LockWaitProgressEvent } from '../lib/operation-stream.js';
import { ActivitySummaryProgressEventSchema } from './engine/activity-summary-collector.js';
import type { RepoSearchTaskKind } from './task-kind.js';
import type { MockPlannerResponseInput } from '../planner-protocol/mock-response.js';

export type { ActivitySummaryCategory, ActivitySummaryEntry, ActivitySummaryProgressEvent } from './engine/activity-summary-collector.js';

export type { RetainedWebToolCall } from '../web-search/web-tool-command.js';

/**
 * Progress events are a wire contract: they cross stdout, SSE and the dashboard before
 * anything renders them. Each kind therefore carries exactly the fields its producer
 * sends, so the compiler can name every producer and consumer of a kind, and consumers
 * narrow instead of coercing whatever happens to be present.
 */
const turnScopedFields = {
  turn: z.number(),
  maxTurns: z.number(),
} as const;

const taskScopedFields = {
  ...turnScopedFields,
  taskId: z.string(),
  elapsedMs: z.number(),
} as const;

/** Crosses the SSE wire to the interactive CLI, which parses it back with this schema. */
export const ApprovalRequestProgressEventSchema = z.object({
  kind: z.literal('approval_request'),
  requestId: z.string(),
  approvalId: z.string(),
  turn: z.number(),
  toolName: z.string(),
  command: z.string(),
  reviewPayload: z.string().optional(),
});
export type ApprovalRequestProgressEvent = z.infer<typeof ApprovalRequestProgressEventSchema>;

/** The token-bearing turn events, named so renderers can parse them instead of reading raw fields. */
export const LlmStartProgressEventSchema = z.object({
  ...turnScopedFields,
  kind: z.literal('llm_start'),
  promptTokenCount: z.number(),
  thinkingTokenCount: z.number(),
  elapsedMs: z.number(),
});
export const LlmEndProgressEventSchema = LlmStartProgressEventSchema.extend({ kind: z.literal('llm_end') });
export const ToolResultProgressEventSchema = z.object({
  ...turnScopedFields,
  kind: z.literal('tool_result'),
  toolCallId: z.string(),
  command: z.string(),
  exitCode: z.number(),
  outputSnippet: z.string(),
  outputTokens: z.number(),
  outputTokensEstimated: z.boolean(),
  promptTokenCount: z.number(),
  thinkingTokenCount: z.number(),
  elapsedMs: z.number(),
});

export const RepoSearchProgressEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model_inventory_start'), elapsedMs: z.number() }),
  z.object({ kind: z.literal('model_inventory_done'), modelCount: z.number(), elapsedMs: z.number() }),
  // The shared warning shape plus the elapsed stamp every repo-search event carries.
  ContextWarningProgressEventSchema.extend({ elapsedMs: z.number() }),
  z.object({ ...taskScopedFields, kind: z.literal('preflight_start'), promptChars: z.number() }),
  z.object({
    ...taskScopedFields,
    kind: z.literal('preflight_tokenize_start'),
    promptChars: z.number(),
    tokenizeTimeoutMs: z.number(),
    tokenizeRetryMaxWaitMs: z.number(),
  }),
  z.object({
    ...taskScopedFields,
    kind: z.literal('preflight_tokenize_done'),
    promptChars: z.number(),
    promptTokenCount: z.number(),
    tokenCountSource: TokenCountSourceSchema.optional(),
    tokenizeElapsedMs: z.number().optional(),
    tokenizeRetryCount: z.number().optional(),
    tokenizeTimeoutMs: z.number().optional(),
    tokenizeRetryMaxWaitMs: z.number().optional(),
    tokenizeStatus: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({ ...taskScopedFields, kind: z.literal('preflight_done'), promptChars: z.number(), promptTokenCount: z.number() }),
  LlmStartProgressEventSchema,
  LlmEndProgressEventSchema,
  z.object({ ...turnScopedFields, kind: z.literal('thinking'), thinkingText: z.string() }),
  z.object({ ...turnScopedFields, kind: z.literal('answer'), answerText: z.string() }),
  z.object({ ...taskScopedFields, kind: z.literal('progress_update'), progressText: z.string() }),
  z.object({
    ...turnScopedFields,
    kind: z.literal('tool_start'),
    toolCallId: z.string(),
    command: z.string(),
    promptTokenCount: z.number(),
    thinkingTokenCount: z.number(),
    elapsedMs: z.number(),
  }),
  ToolResultProgressEventSchema,
  ApprovalRequestProgressEventSchema,
  z.object({
    kind: z.literal('approval_auto'),
    requestId: z.string(),
    turn: z.number(),
    toolName: z.string(),
    command: z.string(),
    verdict: z.string(),
    reason: z.string(),
  }),
  ActivitySummaryProgressEventSchema,
]);

export type RepoSearchProgressEvent = z.infer<typeof RepoSearchProgressEventSchema>;

export type RepoSearchProgressEventKind = RepoSearchProgressEvent['kind'];


/** What actually travels an operation's progress channel: engine events plus the transport's own lock-wait heartbeat. */
export type OperationProgressEvent = RepoSearchProgressEvent | LockWaitProgressEvent;

export const RepoSearchMockCommandResultSchema = z.strictObject({
  exitCode: z.number().int().finite().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  delayMs: z.number().nonnegative().finite().optional(),
});
export type RepoSearchMockCommandResult = z.infer<typeof RepoSearchMockCommandResultSchema>;

export type RepoSearchExecutionRequest = {
  presetId: string;
  requestId?: string;
  startedAtUtc?: string;
  prompt: string;
  repoRoot: string;
  taskKind?: RepoSearchTaskKind;
  statusBackendUrl?: string;
  config?: SiftConfig;
  model?: string;
  additionalPromptPrefix?: string;
  allowedTools?: string[];
  /**
   * Explicit per-run web-tool intent. Unset means "use `config.WebSearch.EnabledDefault`".
   * Chat sets it from the session toggle; repo-search and repo-agent leave it unset.
   */
  webToolsEnabled?: boolean;
  history?: ChatMessage[];
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  maxTurns?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  initialUserImages?: readonly string[];
  progressWriter?: ProgressWriter<RepoSearchProgressEvent>;
  approvalGate?: ApprovalGate;
  approvalMode?: ApprovalMode;
  abortSignal?: AbortSignal;
};

export const RepoSearchExecutionResultSchema = z.object({
  requestId: z.string(),
  transcriptPath: z.string(),
  artifactPath: z.string(),
  scorecard: ScorecardSchema,
});
export type RepoSearchExecutionResult = z.infer<typeof RepoSearchExecutionResultSchema>;
