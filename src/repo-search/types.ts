export type JsonLogger = {
  path: string;
  write: (event: Record<string, unknown>) => void;
};

import type { RetainedWebToolCall } from '../web-search/web-tool-command.js';

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
  config?: Record<string, unknown>;
  model?: string;
  promptPrefix?: string;
  allowedTools?: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
};

export type RepoSearchExecutionResult = {
  requestId: string;
  transcriptPath: string;
  artifactPath: string;
  scorecard: Record<string, unknown>;
};
