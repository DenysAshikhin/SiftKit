export type JsonLogger = {
  path: string;
  write: (event: Record<string, unknown>) => void;
};

export type RepoSearchProgressEvent = {
  kind: string;
  turn?: number;
  maxTurns?: number;
  thinkingText?: string;
  command?: string;
  outputSnippet?: string;
  exitCode?: number;
  promptTokenCount?: number;
  elapsedMs?: number;
};

export type RepoSearchMockCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
};

export type RepoSearchExecutionRequest = {
  prompt: string;
  repoRoot: string;
  taskKind?: 'plan' | 'repo-search';
  statusBackendUrl?: string;
  config?: Record<string, unknown>;
  model?: string;
  promptPrefix?: string;
  allowedTools?: string[];
  requestMaxTokens?: number;
  maxTurns?: number;
  thinkingInterval?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  onProgress?: (event: RepoSearchProgressEvent) => void;
};

export type RepoSearchExecutionResult = {
  requestId: string;
  transcriptPath: string;
  artifactPath: string;
  scorecard: Record<string, unknown>;
};
