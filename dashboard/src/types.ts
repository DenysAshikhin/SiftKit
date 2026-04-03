export type RunStatus = 'completed' | 'failed' | 'running' | string;

export type RunRecord = {
  id: string;
  kind: string;
  status: RunStatus;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  durationMs: number | null;
  rawPaths: Record<string, string | null>;
};

export type RunEvent = {
  kind: string;
  at: string | null;
  payload: unknown;
};

export type RunDetailResponse = {
  run: RunRecord;
  events: RunEvent[];
};

export type RunsResponse = {
  runs: RunRecord[];
  total: number;
};

export type MetricDay = {
  date: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
};

export type MetricsResponse = {
  days: MetricDay[];
};

export type IdleSummarySnapshot = {
  emittedAtUtc: string | null;
  completedRequestCount: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  savedTokens: number;
  savedPercent: number | null;
  compressionRatio: number | null;
  requestDurationMsTotal: number;
  avgRequestMs: number | null;
  avgTokensPerSecond: number | null;
  summaryText: string;
};

export type IdleSummaryResponse = {
  latest: IdleSummarySnapshot | null;
  snapshots: IdleSummarySnapshot[];
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokens: number;
  inputTokensEstimated?: boolean;
  outputTokensEstimated?: boolean;
  thinkingTokensEstimated?: boolean;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  associatedToolTokens?: number;
  thinkingContent?: string;
  createdAtUtc: string;
  sourceRunId: string | null;
  compressedIntoSummary?: boolean;
};

export type HiddenToolContext = {
  id: string;
  content: string;
  tokenEstimate: number;
  sourceMessageId: string | null;
  createdAtUtc: string;
};

export type ChatSession = {
  id: string;
  title: string;
  model: string | null;
  contextWindowTokens: number;
  thinkingEnabled?: boolean;
  mode?: 'chat' | 'plan' | 'repo-search';
  planRepoRoot?: string;
  condensedSummary: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  messages: ChatMessage[];
  hiddenToolContexts?: HiddenToolContext[];
};

export type ContextUsage = {
  contextWindowTokens: number;
  usedTokens: number;
  chatUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  warnThresholdTokens: number;
  shouldCondense: boolean;
  estimatedTokenFallbackTokens?: number;
};

export type ChatSessionResponse = {
  session: ChatSession;
  contextUsage: ContextUsage;
};

export type ChatSessionsResponse = {
  sessions: ChatSession[];
};
