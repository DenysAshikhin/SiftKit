import { z } from 'zod';

export const EngineEventKindSchema = z.enum(['prompt_cache_break', 'engine_error', 'engine_exit']);
export type EngineEventKind = z.infer<typeof EngineEventKindSchema>;

/** One engine-level problem: a prompt-cache break in an agent run, or an engine error or exit. */
export const EngineEventSchema = z.object({
  id: z.string(),
  occurredAtUtc: z.string(),
  kind: EngineEventKindSchema,
  inferenceRunId: z.string().nullable(),
  runId: z.string().nullable(),
  turn: z.number().int().nullable(),
  summary: z.string(),
  detail: z.string(),
});
export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const EngineEventsResponseSchema = z.object({ events: z.array(EngineEventSchema) });
export type EngineEventsResponse = z.infer<typeof EngineEventsResponseSchema>;

/** A response whose prefill exceeded the prompt's growth since the previous response. */
export const PromptCacheBreakSchema = z.object({
  turn: z.number().int(),
  promptTokens: z.number(),
  previousPromptTokens: z.number(),
  promptEvalTokens: z.number(),
  promptCacheTokens: z.number().nullable(),
});
export type PromptCacheBreak = z.infer<typeof PromptCacheBreakSchema>;
