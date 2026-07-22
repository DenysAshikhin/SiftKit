import { z } from '../lib/zod.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { SiftConfig } from '../config/index.js';

export type JsonLogger = {
  path: string;
  write: (event: Record<string, JsonSerializable>) => void;
};
import type { RetainedWebToolCall } from '../web-search/web-tool-command.js';
import type { ChatMessage } from './planner-protocol.js';
import { ScorecardSchema } from './engine.js';

export type { RetainedWebToolCall } from '../web-search/web-tool-command.js';

export type RepoSearchProgressEvent = {
  kind: string;
  toolCallId?: string;
  turn?: number;
  maxTurns?: number;
  taskId?: string;
  thinkingText?: string;
  answerText?: string;
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
  tokenCountSource?: string;
  tokenizeElapsedMs?: number;
  tokenizeRetryCount?: number;
  tokenizeTimeoutMs?: number;
  tokenizeRetryMaxWaitMs?: number;
  tokenizeStatus?: string;
};

export type RepoSearchMockCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
};

export type RepoSearchExecutionRequest = {
  requestId?: string;
  startedAtUtc?: string;
  prompt: string;
  repoRoot: string;
  taskKind?: 'plan' | 'repo-search' | 'chat';
  statusBackendUrl?: string;
  config?: SiftConfig;
  model?: string;
  promptPrefix?: string;
  allowedTools?: string[];
  history?: ChatMessage[];
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  maxTurns?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  onProgress?: (event: RepoSearchProgressEvent) => void;
  abortSignal?: AbortSignal;
};

export const RepoSearchExecutionResultSchema = z.object({
  requestId: z.string(),
  transcriptPath: z.string(),
  artifactPath: z.string(),
  scorecard: ScorecardSchema,
});
export type RepoSearchExecutionResult = z.infer<typeof RepoSearchExecutionResultSchema>;
