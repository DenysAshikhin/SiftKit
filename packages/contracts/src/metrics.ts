import { z } from 'zod';

export const TaskMetricKindSchema = z.enum(['summary', 'plan', 'repo-search', 'chat']);
export type TaskMetricKind = z.infer<typeof TaskMetricKindSchema>;

export const MetricDaySchema = z.object({
  date: z.string(), runs: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  thinkingTokens: z.number(), toolTokens: z.number(), promptCacheTokens: z.number(), promptEvalTokens: z.number(),
  cacheHitRate: z.number().nullable(), speculativeAcceptedTokens: z.number(), speculativeGeneratedTokens: z.number(),
  acceptanceRate: z.number().nullable(), successCount: z.number(), failureCount: z.number(), avgDurationMs: z.number(),
});
export type MetricDay = z.infer<typeof MetricDaySchema>;

export const TaskMetricDaySchema = z.object({
  date: z.string(), taskKind: TaskMetricKindSchema, runs: z.number(), inputTokens: z.number(),
  outputTokens: z.number(), thinkingTokens: z.number(), toolTokens: z.number(),
  promptCacheTokens: z.number(), promptEvalTokens: z.number(), avgDurationMs: z.number(),
});
export type TaskMetricDay = z.infer<typeof TaskMetricDaySchema>;

export const ToolTypeStatsSchema = z.object({
  calls: z.number(), outputCharsTotal: z.number(), outputTokensTotal: z.number(),
  outputTokensEstimatedCount: z.number(), lineReadCalls: z.number(), lineReadLinesTotal: z.number(),
  lineReadTokensTotal: z.number(), finishRejections: z.number(), semanticRepeatRejects: z.number(),
  stagnationWarnings: z.number(), forcedFinishFromStagnation: z.number(), promptInsertedTokens: z.number(),
  rawToolResultTokens: z.number(), newEvidenceCalls: z.number(), noNewEvidenceCalls: z.number(),
  lineReadRecommendedLines: z.number().optional(), lineReadAllowanceTokens: z.number().optional(),
});
export type ToolTypeStats = z.infer<typeof ToolTypeStatsSchema>;

export const ToolStatsByTaskSchema = z.object({
  summary: z.record(z.string(), ToolTypeStatsSchema),
  plan: z.record(z.string(), ToolTypeStatsSchema),
  'repo-search': z.record(z.string(), ToolTypeStatsSchema),
  chat: z.record(z.string(), ToolTypeStatsSchema),
});
export type ToolStatsByTask = z.infer<typeof ToolStatsByTaskSchema>;

// Per-task aggregate totals (src/status-server/metrics.ts MetricTotals). Reused by idle-summary.
export const MetricTotalsSchema = z.object({
  inputCharactersTotal: z.number(), outputCharactersTotal: z.number(), inputTokensTotal: z.number(),
  outputTokensTotal: z.number(), thinkingTokensTotal: z.number(), toolTokensTotal: z.number(),
  promptCacheTokensTotal: z.number(), promptEvalTokensTotal: z.number(),
  speculativeAcceptedTokensTotal: z.number(), speculativeGeneratedTokensTotal: z.number(),
  requestDurationMsTotal: z.number(), wallDurationMsTotal: z.number(), stdinWaitMsTotal: z.number(),
  serverPreflightMsTotal: z.number(), lockWaitMsTotal: z.number(), statusRunningMsTotal: z.number(),
  terminalStatusMsTotal: z.number(), completedRequestCount: z.number(),
});
export type MetricTotals = z.infer<typeof MetricTotalsSchema>;

export const WebSearchUsageSchema = z.object({
  currentMonth: z.string(), currentMonthCount: z.number(), allTimeCount: z.number(),
});
export type WebSearchUsage = z.infer<typeof WebSearchUsageSchema>;

export const MetricsResponseSchema = z.object({
  days: z.array(MetricDaySchema), taskDays: z.array(TaskMetricDaySchema),
  toolStats: ToolStatsByTaskSchema, webSearchUsage: WebSearchUsageSchema,
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
