export type RunStatus = 'completed' | 'failed' | 'running' | string;
export type RunGroupFilter = '' | 'summary' | 'repo_search' | 'planner' | 'chat' | 'other';
export type RunLogDeleteType = 'all' | Exclude<RunGroupFilter, ''>;
export type RunLogDeleteCriteria =
  | {
    mode: 'count';
    type: RunLogDeleteType;
    count: number;
  }
  | {
    mode: 'before_date';
    type: RunLogDeleteType;
    beforeDate: string;
  };
export type RunLogDeletePreviewResponse = {
  ok: boolean;
  matchCount: number;
};
export type RunLogDeleteResponse = {
  ok: boolean;
  deletedCount: number;
  deletedRunIds: string[];
};

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
  toolTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
};

export type TaskMetricDay = {
  date: string;
  taskKind: 'summary' | 'plan' | 'repo-search' | 'chat';
  runs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  avgDurationMs: number;
};

export type ToolTypeStats = {
  calls: number;
  outputCharsTotal: number;
  outputTokensTotal: number;
  outputTokensEstimatedCount: number;
  lineReadCalls: number;
  lineReadLinesTotal: number;
  lineReadTokensTotal: number;
  finishRejections: number;
  semanticRepeatRejects: number;
  stagnationWarnings: number;
  forcedFinishFromStagnation: number;
  promptInsertedTokens: number;
  rawToolResultTokens: number;
  newEvidenceCalls: number;
  noNewEvidenceCalls: number;
  lineReadRecommendedLines?: number;
  lineReadAllowanceTokens?: number;
};

export type ToolStatsByTask = Record<'summary' | 'plan' | 'repo-search' | 'chat', Record<string, ToolTypeStats>>;

export type MetricsResponse = {
  days: MetricDay[];
  taskDays: TaskMetricDay[];
  toolStats: ToolStatsByTask;
};

export type IdleSummarySnapshot = {
  emittedAtUtc: string | null;
  completedRequestCount: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  savedTokens: number;
  savedPercent: number | null;
  compressionRatio: number | null;
  requestDurationMsTotal: number;
  avgRequestMs: number | null;
  avgTokensPerSecond: number | null;
  taskTotals?: Record<string, unknown>;
  toolStats?: Record<string, unknown>;
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
  presetId?: string;
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

export type DashboardPresetKind = 'summary' | 'chat' | 'plan' | 'repo-search';
export type DashboardPresetExecutionFamily = DashboardPresetKind;
export type DashboardPresetOperationMode = 'summary' | 'read-only' | 'full';
export type DashboardPresetSurface = 'cli' | 'web';
export type DashboardPresetToolName =
  | 'find_text'
  | 'read_lines'
  | 'json_filter'
  | 'repo_rg'
  | 'repo_get_content'
  | 'repo_get_childitem'
  | 'repo_select_string'
  | 'repo_git'
  | 'repo_pwd'
  | 'repo_ls'
  | 'repo_select_object'
  | 'repo_where_object'
  | 'repo_sort_object'
  | 'repo_group_object'
  | 'repo_measure_object'
  | 'repo_foreach_object'
  | 'repo_format_table'
  | 'repo_format_list'
  | 'repo_out_string'
  | 'repo_convertto_json'
  | 'repo_convertfrom_json'
  | 'repo_get_unique'
  | 'repo_join_string';
export type DashboardOperationModeAllowedTools = Record<DashboardPresetOperationMode, DashboardPresetToolName[]>;

export type DashboardPreset = {
  id: string;
  label: string;
  description: string;
  presetKind: DashboardPresetKind;
  operationMode: DashboardPresetOperationMode;
  executionFamily: DashboardPresetExecutionFamily;
  promptPrefix: string;
  allowedTools: DashboardPresetToolName[];
  surfaces: DashboardPresetSurface[];
  useForSummary: boolean;
  builtin: boolean;
  deletable: boolean;
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
  repoRootRequired: boolean;
  maxTurns: number | null;
  thinkingInterval: number | null;
  thinkingEnabled: boolean | null;
};

export type DashboardLlamaCppConfig = {
  BaseUrl: string;
  NumCtx: number;
  ModelPath: string | null;
  Temperature: number;
  TopP: number;
  TopK: number;
  MinP: number;
  PresencePenalty: number;
  RepetitionPenalty: number;
  MaxTokens: number;
  GpuLayers: number;
  Threads: number;
  FlashAttention: boolean;
  ParallelSlots: number;
  Reasoning: 'on' | 'off' | 'auto';
};

export type DashboardConfig = {
  Version: string;
  Backend: string;
  PolicyMode: string;
  RawLogRetention: boolean;
  PromptPrefix: string;
  OperationModeAllowedTools: DashboardOperationModeAllowedTools;
  Presets: DashboardPreset[];
  Model?: string;
  LlamaCpp: DashboardLlamaCppConfig;
  Runtime: {
    Model: string;
    LlamaCpp: DashboardLlamaCppConfig;
  };
  Thresholds: {
    MinCharactersForSummary: number;
    MinLinesForSummary: number;
  };
  Interactive: {
    Enabled: boolean;
    WrappedCommands: string[];
    IdleTimeoutMs: number;
    MaxTranscriptCharacters: number;
    TranscriptRetention: boolean;
  };
  Server: {
    LlamaCpp: {
      ExecutablePath: string | null;
      BaseUrl: string;
      BindHost: string;
      Port: number;
      ModelPath: string | null;
      NumCtx: number;
      GpuLayers: number;
      Threads: number;
      FlashAttention: boolean;
      ParallelSlots: number;
      BatchSize: number;
      UBatchSize: number;
      CacheRam: number;
      MaxTokens: number;
      Temperature: number;
      TopP: number;
      TopK: number;
      MinP: number;
      PresencePenalty: number;
      RepetitionPenalty: number;
      Reasoning: 'on' | 'off' | 'auto';
      ReasoningBudget: number;
      StartupTimeoutMs: number;
      HealthcheckTimeoutMs: number;
      HealthcheckIntervalMs: number;
      VerboseLogging: boolean;
    };
  };
};

export type DashboardHealth = {
  ok: boolean;
  disableManagedLlamaStartup: boolean;
  statusPath: string;
  configPath: string;
  metricsPath: string;
  idleSummarySnapshotsPath: string;
  runtimeRoot: string;
};

export type ManagedFilePickerTarget = 'managed-llama-executable' | 'managed-llama-model';

export type ManagedFilePickerResponse = {
  ok: boolean;
  cancelled: boolean;
  path: string | null;
};
