import { z } from 'zod';
import { TaskMetricKindSchema, MetricTotalsSchema, ToolTypeStatsSchema } from './metrics.js';

const SnapshotTaskTotalsSchema = z.record(TaskMetricKindSchema, MetricTotalsSchema);
const SnapshotToolStatsSchema = z.record(TaskMetricKindSchema, z.record(z.string(), ToolTypeStatsSchema));

export const IdleSummarySnapshotRowSchema = z.object({
  emittedAtUtc: z.string(),
  inputTokensTotal: z.number(), outputTokensTotal: z.number(), inputOutputRatio: z.number().nullable(),
  thinkingTokensTotal: z.number(), toolTokensTotal: z.number(), promptCacheTokensTotal: z.number(),
  promptEvalTokensTotal: z.number(), speculativeAcceptedTokensTotal: z.number(), speculativeGeneratedTokensTotal: z.number(),
  inputCharactersTotal: z.number(), outputCharactersTotal: z.number(), requestDurationMsTotal: z.number(),
  wallDurationMsTotal: z.number(), stdinWaitMsTotal: z.number(), serverPreflightMsTotal: z.number(),
  lockWaitMsTotal: z.number(), statusRunningMsTotal: z.number(), terminalStatusMsTotal: z.number(),
  completedRequestCount: z.number(), savedTokens: z.number(), savedPercent: z.number().nullable(),
  compressionRatio: z.number().nullable(), avgOutputTokensPerRequest: z.number().nullable(), avgRequestMs: z.number().nullable(),
  avgTokensPerSecond: z.number().nullable(),
  inputCharactersPerContextToken: z.number().nullable(), chunkThresholdCharacters: z.number().nullable(),
  taskTotals: SnapshotTaskTotalsSchema, toolStats: SnapshotToolStatsSchema,
  summaryText: z.string(),
});
export type IdleSummarySnapshotRow = z.infer<typeof IdleSummarySnapshotRowSchema>;

export const IdleSummaryResponseSchema = z.object({
  latest: IdleSummarySnapshotRowSchema.nullable(),
  snapshots: z.array(IdleSummarySnapshotRowSchema),
});
export type IdleSummaryResponse = z.infer<typeof IdleSummaryResponseSchema>;
