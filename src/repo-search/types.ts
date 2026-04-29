export type JsonLogger = {
  path: string;
  write: (event: Record<string, unknown>) => void;
};

export type RepoSearchProgressEvent = {
  kind: string;
  turn?: number;
  maxTurns?: number;
  taskId?: string;
  thinkingText?: string;
  command?: string;
  outputSnippet?: string;
  exitCode?: number;
  promptTokenCount?: number;
  promptChars?: number;
  modelCount?: number;
  errorMessage?: string;
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
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  maxTurns?: number;
  promptTimeoutMs?: number;
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
