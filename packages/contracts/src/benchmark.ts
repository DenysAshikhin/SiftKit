import { z } from 'zod';
import { JsonObjectSchema } from './primitives.js';

export const DashboardBenchmarkTaskKindSchema = z.enum(['repo-search', 'summary']);
export type DashboardBenchmarkTaskKind = z.infer<typeof DashboardBenchmarkTaskKindSchema>;
export const DashboardBenchmarkSortKeySchema = z.enum([
  'completionSpeed', 'generationTokensPerSecond', 'acceptanceRate', 'outputQualityScore',
  'toolUseQualityScore', 'failureCount', 'sampleCount',
]);
export type DashboardBenchmarkSortKey = z.infer<typeof DashboardBenchmarkSortKeySchema>;
export const DashboardBenchmarkLogStreamKindSchema = z.enum(['orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_llama']);
export type DashboardBenchmarkLogStreamKind = z.infer<typeof DashboardBenchmarkLogStreamKindSchema>;

export const DashboardBenchmarkQuestionPresetSchema = z.object({
  id: z.string(), title: z.string(), taskKind: DashboardBenchmarkTaskKindSchema, prompt: z.string(),
  enabled: z.boolean(), seededKey: z.string().nullable().optional(), createdAtUtc: z.string(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkQuestionPreset = z.infer<typeof DashboardBenchmarkQuestionPresetSchema>;

export const DashboardBenchmarkSessionSchema = z.object({
  id: z.string(), status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  questionPresetCount: z.number(), caseCount: z.number(), repetitions: z.number(),
  currentCaseIndex: z.number().nullable(), currentPromptIndex: z.number().nullable(), currentRepeatIndex: z.number().nullable(),
  restoreStatus: z.enum(['pending', 'completed', 'failed']), restoreError: z.string().nullable(),
  originalConfigJson: z.string(), startedAtUtc: z.string(), completedAtUtc: z.string().nullable(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkSession = z.infer<typeof DashboardBenchmarkSessionSchema>;

export const DashboardBenchmarkCaseSchema = z.object({
  id: z.string(), sessionId: z.string(), caseIndex: z.number(), label: z.string(),
  managedPresetId: z.string(), managedPresetLabel: z.string(), managedPreset: JsonObjectSchema,
  specOverride: JsonObjectSchema, createdAtUtc: z.string(),
});
export type DashboardBenchmarkCase = z.infer<typeof DashboardBenchmarkCaseSchema>;

export const DashboardBenchmarkAttemptSchema = z.object({
  id: z.string(), sessionId: z.string(), caseId: z.string(), questionPresetId: z.string(),
  taskKind: DashboardBenchmarkTaskKindSchema, promptTitle: z.string(), prompt: z.string(), caseLabel: z.string(),
  managedPresetId: z.string(), managedPresetLabel: z.string(), caseIndex: z.number(), promptIndex: z.number(), repeatIndex: z.number(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  outputText: z.string().nullable(), error: z.string().nullable(), runId: z.string().nullable(), managedRunId: z.string().nullable(),
  durationMs: z.number().nullable(), promptTokensPerSecond: z.number().nullable(), generationTokensPerSecond: z.number().nullable(),
  acceptanceRate: z.number().nullable(), outputTokens: z.number().nullable(), thinkingTokens: z.number().nullable(),
  speculativeAcceptedTokens: z.number().nullable(), speculativeGeneratedTokens: z.number().nullable(),
  outputQualityScore: z.number().nullable(), toolUseQualityScore: z.number().nullable(),
  reviewNotes: z.string().nullable(), reviewedBy: z.string().nullable(), reviewedAtUtc: z.string().nullable(),
  startedAtUtc: z.string().nullable(), completedAtUtc: z.string().nullable(), updatedAtUtc: z.string(),
});
export type DashboardBenchmarkAttempt = z.infer<typeof DashboardBenchmarkAttemptSchema>;

export const DashboardBenchmarkSessionDetailSchema = z.object({
  session: DashboardBenchmarkSessionSchema, cases: z.array(DashboardBenchmarkCaseSchema), attempts: z.array(DashboardBenchmarkAttemptSchema),
});
export type DashboardBenchmarkSessionDetail = z.infer<typeof DashboardBenchmarkSessionDetailSchema>;
export const DashboardBenchmarkQuestionPresetsResponseSchema = z.object({ presets: z.array(DashboardBenchmarkQuestionPresetSchema) });
export type DashboardBenchmarkQuestionPresetsResponse = z.infer<typeof DashboardBenchmarkQuestionPresetsResponseSchema>;
export const DashboardBenchmarkSessionsResponseSchema = z.object({ sessions: z.array(DashboardBenchmarkSessionSchema) });
export type DashboardBenchmarkSessionsResponse = z.infer<typeof DashboardBenchmarkSessionsResponseSchema>;
export const DashboardBenchmarkStartRequestSchema = z.object({
  questionPresetIds: z.array(z.string()), managedPresetIds: z.array(z.string()), repetitions: z.number(), specOverrides: z.array(JsonObjectSchema),
});
export type DashboardBenchmarkStartRequest = z.infer<typeof DashboardBenchmarkStartRequestSchema>;
export const DashboardBenchmarkGradeRequestSchema = z.object({
  outputQualityScore: z.number().nullable(), toolUseQualityScore: z.number().nullable(), reviewNotes: z.string().nullable(), reviewedBy: z.string(),
});
export type DashboardBenchmarkGradeRequest = z.infer<typeof DashboardBenchmarkGradeRequestSchema>;
