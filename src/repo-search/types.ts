import type { TokenCountSource } from './prompt-budget.js';
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
import type { ActivitySummaryEntry } from './engine/activity-summary-collector.js';

export type { ActivitySummaryCategory, ActivitySummaryEntry, ActivitySummaryProgressEvent } from './engine/activity-summary-collector.js';

export type { RetainedWebToolCall } from '../web-search/web-tool-command.js';

export type RepoSearchProgressEvent = {
  kind: string;
  toolCallId?: string;
  turn?: number;
  maxTurns?: number;
  taskId?: string;
  thinkingText?: string;
  answerText?: string;
  progressText?: string;
  command?: string;
  outputSnippet?: string;
  outputTokens?: number;
  outputTokensEstimated?: boolean;
  exitCode?: number;
  promptTokenCount?: number;
  promptChars?: number;
  modelCount?: number;
  errorMessage?: string;
  elapsedMs?: number;
  tokenCountSource?: TokenCountSource;
  tokenizeElapsedMs?: number;
  tokenizeRetryCount?: number;
  tokenizeTimeoutMs?: number;
  tokenizeRetryMaxWaitMs?: number;
  tokenizeStatus?: string;
  requestId?: string;
  approvalId?: string;
  toolName?: string;
  reviewPayload?: string;
  verdict?: string;
  reason?: string;
  warningText?: string;
  entries?: ActivitySummaryEntry[];
};

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
  taskKind?: 'plan' | 'repo-search' | 'chat' | 'repo-agent';
  statusBackendUrl?: string;
  config?: SiftConfig;
  model?: string;
  additionalPromptPrefix?: string;
  allowedTools?: string[];
  history?: ChatMessage[];
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  maxTurns?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: string[];
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
