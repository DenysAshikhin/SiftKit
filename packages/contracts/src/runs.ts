import { z } from 'zod';
import { JsonDataSchema, JsonObjectSchema } from './primitives.js';

export const RunGroupFilterSchema = z.enum(['', 'summary', 'repo_search', 'planner', 'chat', 'other']);
export type RunGroupFilter = z.infer<typeof RunGroupFilterSchema>;

export const RunLogDeleteTypeSchema = z.enum(['all', 'summary', 'repo_search', 'planner', 'chat', 'other']);
export type RunLogDeleteType = z.infer<typeof RunLogDeleteTypeSchema>;

export const RunLogDeleteCriteriaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('count'), type: RunLogDeleteTypeSchema, count: z.number() }),
  z.object({ mode: z.literal('before_date'), type: RunLogDeleteTypeSchema, beforeDate: z.string() }),
]);
export type RunLogDeleteCriteria = z.infer<typeof RunLogDeleteCriteriaSchema>;

export const RunLogDeletePreviewResponseSchema = z.object({ ok: z.boolean(), matchCount: z.number() });
export type RunLogDeletePreviewResponse = z.infer<typeof RunLogDeletePreviewResponseSchema>;

export const RunLogDeleteResponseSchema = z.object({
  ok: z.boolean(), deletedCount: z.number(), deletedRunIds: z.array(z.string()),
});
export type RunLogDeleteResponse = z.infer<typeof RunLogDeleteResponseSchema>;

export const RunRecordSchema = z.object({
  id: z.string(), kind: z.string(), status: z.string(),
  startedAtUtc: z.string().nullable(), finishedAtUtc: z.string().nullable(),
  title: z.string(), model: z.string().nullable(), backend: z.string().nullable(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), thinkingTokens: z.number().nullable(),
  toolTokens: z.number().nullable(), promptCacheTokens: z.number().nullable(), promptEvalTokens: z.number().nullable(),
  promptEvalDurationMs: z.number().nullable(), generationDurationMs: z.number().nullable(),
  speculativeAcceptedTokens: z.number().nullable(), speculativeGeneratedTokens: z.number().nullable(),
  durationMs: z.number().nullable(), providerDurationMs: z.number().nullable(), wallDurationMs: z.number().nullable(),
  rawPaths: JsonObjectSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunEventSchema = z.object({ kind: z.string(), at: z.string().nullable(), payload: JsonDataSchema });
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunDetailResponseSchema = z.object({ run: RunRecordSchema, events: z.array(RunEventSchema) });
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const RunsResponseSchema = z.object({ runs: z.array(RunRecordSchema), total: z.number() });
export type RunsResponse = z.infer<typeof RunsResponseSchema>;
