import type {
  DashboardLlamaCppConfig,
  DashboardManagedLlamaPreset,
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  ManagedLlamaSpeculativeType,
  SiftConfig,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
} from '../../src/config/types.js';
import type {
  PresetExecutionFamily,
  PresetKind,
  PresetOperationMode,
  PresetSurface,
  PresetToolName,
} from '../../src/presets.js';
import type { ProviderQuota } from '../../src/web-search/types.js';
import type { JsonValue, JsonObject } from '../../src/lib/json-types.js';

export type {
  DashboardLlamaCppConfig,
  DashboardManagedLlamaPreset,
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  ProviderQuota,
  WebSearchConfig,
  WebSearchProviderId,
  WebSearchProviderSettings,
};

export type DashboardConfig = SiftConfig;
export type DashboardPresetKind = PresetKind;
export type DashboardPresetExecutionFamily = PresetExecutionFamily;
export type DashboardPresetOperationMode = PresetOperationMode;
export type DashboardPresetSurface = PresetSurface;
export type DashboardPresetToolName = PresetToolName;
export type DashboardManagedLlamaSpeculativeType = ManagedLlamaSpeculativeType;

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
  toolTokens?: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  durationMs: number | null;
  rawPaths: Record<string, string | null>;
};

export type RunEvent = {
  kind: string;
  at: string | null;
  payload: JsonValue;
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
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  acceptanceRate: number | null;
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
  webSearchUsage: WebSearchUsage;
};

export type WebSearchUsage = {
  currentMonth: string;
  currentMonthCount: number;
  allTimeCount: number;
};

export type IdleSummarySnapshot = {
  emittedAtUtc: string | null;
  completedRequestCount: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  inputOutputRatio: number | null;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  speculativeAcceptedTokensTotal?: number;
  speculativeGeneratedTokensTotal?: number;
  savedTokens: number;
  savedPercent: number | null;
  compressionRatio: number | null;
  requestDurationMsTotal: number;
  avgRequestMs: number | null;
  avgTokensPerSecond: number | null;
  taskTotals?: JsonObject;
  toolStats?: JsonObject;
  summaryText: string;
};

export type IdleSummaryResponse = {
  latest: IdleSummarySnapshot | null;
  snapshots: IdleSummarySnapshot[];
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  kind?: 'user_text' | 'assistant_answer' | 'assistant_thinking' | 'assistant_tool_call';
  content: string;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokens: number;
  inputTokensEstimated?: boolean;
  outputTokensEstimated?: boolean;
  thinkingTokensEstimated?: boolean;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  requestStartedAtUtc?: string | null;
  thinkingStartedAtUtc?: string | null;
  thinkingEndedAtUtc?: string | null;
  answerStartedAtUtc?: string | null;
  answerEndedAtUtc?: string | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  associatedToolTokens?: number;
  thinkingContent?: string;
  toolCallCommand?: string | null;
  toolCallTurn?: number | null;
  toolCallMaxTurns?: number | null;
  toolCallExitCode?: number | null;
  toolCallPromptTokenCount?: number | null;
  toolCallOutputSnippet?: string | null;
  toolCallOutput?: string | null;
  toolCallStatus?: 'running' | 'done';
  groundingStatus?: 'ungrounded' | 'snippet_only' | 'fetched' | null;
  createdAtUtc: string;
  sourceRunId: string | null;
  compressedIntoSummary?: boolean;
};

export type ChatPromptContext = {
  id: string;
  role: 'system';
  kind: 'system_context';
  label: string;
  content: string;
  createdAtUtc: string;
  deletable: false;
};

export type RepoSearchAutoAppendTokenSource = 'llama.cpp' | 'estimate';

export type RepoSearchAutoAppendPreviewItem = {
  key: 'agentsMd' | 'repoFileListing';
  label: string;
  enabledDefault: boolean;
  available: boolean;
  tokenCount: number;
  tokenSource: RepoSearchAutoAppendTokenSource;
};

export type RepoSearchAutoAppendPreview = {
  agentsMd: RepoSearchAutoAppendPreviewItem;
  repoFileListing: RepoSearchAutoAppendPreviewItem;
};

export type RepoSearchAutoAppendSelection = {
  includeAgentsMd: boolean;
  includeRepoFileListing: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  model: string | null;
  contextWindowTokens: number;
  thinkingEnabled?: boolean;
  webSearchEnabled?: boolean;
  presetId?: string;
  mode?: 'chat' | 'plan' | 'repo-search';
  planRepoRoot?: string;
  condensedSummary: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  messages: ChatMessage[];
  promptContext?: ChatPromptContext;
};

export type ContextUsage = {
  contextWindowTokens: number;
  usedTokens: number;
  chatUsedTokens: number;
  thinkingUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  warnThresholdTokens: number;
  shouldCondense: boolean;
  estimatedTokenFallbackTokens?: number;
  providerOverheadTokens: number;
};

export type ChatSessionResponse = {
  session: ChatSession;
  contextUsage: ContextUsage;
};

export type ChatSessionsResponse = {
  sessions: ChatSession[];
};

export type WebSearchQuotaResponse = {
  quotas: ProviderQuota[];
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

export type DashboardBenchmarkTaskKind = 'repo-search' | 'summary';
export type DashboardBenchmarkSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type DashboardBenchmarkRestoreStatus = 'pending' | 'completed' | 'failed';
export type DashboardBenchmarkAttemptStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type DashboardBenchmarkLogStreamKind = 'orchestrator' | 'attempt_stdout' | 'attempt_stderr' | 'managed_llama';
export type DashboardBenchmarkSortKey =
  | 'completionSpeed'
  | 'generationTokensPerSecond'
  | 'acceptanceRate'
  | 'outputQualityScore'
  | 'toolUseQualityScore'
  | 'failureCount'
  | 'sampleCount';

export type DashboardBenchmarkQuestionPreset = {
  id: string;
  title: string;
  taskKind: DashboardBenchmarkTaskKind;
  prompt: string;
  enabled: boolean;
  seededKey?: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type DashboardBenchmarkSession = {
  id: string;
  status: DashboardBenchmarkSessionStatus;
  questionPresetCount: number;
  caseCount: number;
  repetitions: number;
  currentCaseIndex: number | null;
  currentPromptIndex: number | null;
  currentRepeatIndex: number | null;
  restoreStatus: DashboardBenchmarkRestoreStatus;
  restoreError: string | null;
  originalConfigJson: string;
  startedAtUtc: string;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

export type DashboardBenchmarkCase = {
  id: string;
  sessionId: string;
  caseIndex: number;
  label: string;
  managedPresetId: string;
  managedPresetLabel: string;
  managedPreset: JsonObject;
  specOverride: JsonObject;
  createdAtUtc: string;
};

export type DashboardBenchmarkAttempt = {
  id: string;
  sessionId: string;
  caseId: string;
  questionPresetId: string;
  taskKind: DashboardBenchmarkTaskKind;
  promptTitle: string;
  prompt: string;
  caseLabel: string;
  managedPresetId: string;
  managedPresetLabel: string;
  caseIndex: number;
  promptIndex: number;
  repeatIndex: number;
  status: DashboardBenchmarkAttemptStatus;
  outputText: string | null;
  error: string | null;
  runId: string | null;
  managedRunId: string | null;
  durationMs: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  acceptanceRate: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  outputQualityScore: number | null;
  toolUseQualityScore: number | null;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAtUtc: string | null;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  updatedAtUtc: string;
};

export type DashboardBenchmarkSessionDetail = {
  session: DashboardBenchmarkSession;
  cases: DashboardBenchmarkCase[];
  attempts: DashboardBenchmarkAttempt[];
};

export type DashboardBenchmarkQuestionPresetsResponse = {
  presets: DashboardBenchmarkQuestionPreset[];
};

export type DashboardBenchmarkSessionsResponse = {
  sessions: DashboardBenchmarkSession[];
};

export type DashboardBenchmarkStartRequest = {
  questionPresetIds: string[];
  managedPresetIds: string[];
  repetitions: number;
  specOverrides: Array<JsonObject>;
};

export type DashboardBenchmarkGradeRequest = {
  outputQualityScore: number | null;
  toolUseQualityScore: number | null;
  reviewNotes: string | null;
  reviewedBy: string;
};

export type ManagedFilePickerTarget = 'managed-llama-executable' | 'managed-llama-model';

export type ManagedFilePickerResponse = {
  ok: boolean;
  cancelled: boolean;
  path: string | null;
};

export type ManagedLlamaStartupFailure = {
  kind: 'gpu_memory_oom';
  requiredMiB: number;
  availableMiB: number;
};

export type RestartBackendResponse = {
  ok: boolean;
  restarted: boolean;
  error?: string;
  config?: DashboardConfig;
  startupFailure?: ManagedLlamaStartupFailure | null;
};

export type LlamaCppConnectionTestResponse = {
  ok: boolean;
  statusCode: number;
  baseUrl?: string;
  error?: string;
};
