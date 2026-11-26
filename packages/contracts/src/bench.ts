import { z } from 'zod';
import { ModelRuntimePresetSchema } from './config.ts';

/** Prefix of the benchmark route; requests there keep the caller's sampling and never change saved config. */
export const BENCH_ROUTE_PREFIX = '/bench/v1';
/** Response header: first 16 hex digits of the SHA-256 of the admitted preset's residency key. */
export const BENCH_RESIDENCY_HEADER = 'x-siftkit-bench-residency';
/** Response header: the runtime's state-change counter; a change between two responses means a reload. */
export const BENCH_GENERATION_HEADER = 'x-siftkit-bench-generation';

export const BenchIdentityRequestSchema = z.strictObject({ model: z.string().min(1) });
export type BenchIdentityRequest = z.infer<typeof BenchIdentityRequestSchema>;

export const BenchResidentCardSchema = z.strictObject({
  id: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  chunk_size: z.number(),
  cache_mode: z.string().nullable(),
});
export type BenchResidentCard = z.infer<typeof BenchResidentCardSchema>;

/** What the server can vouch for about one variant; null means it cannot confirm that fact. */
export const BenchIdentityResponseSchema = z.strictObject({
  requested: z.strictObject({ presetId: z.string(), settings: ModelRuntimePresetSchema }),
  resident: z.strictObject({ matches: z.boolean(), card: BenchResidentCardSchema.nullable() }),
  drafting: z.strictObject({ configured: z.boolean(), verified: z.boolean().nullable() }),
  engine: z.strictObject({
    managed: z.boolean(),
    pythonPath: z.string(),
    workingDirectory: z.string(),
    entrypoint: z.string(),
    environment: z.record(z.string(), z.string()),
  }),
  residency: z.strictObject({ keyHash: z.string(), generation: z.number().int().nonnegative() }),
});
export type BenchIdentityResponse = z.infer<typeof BenchIdentityResponseSchema>;

export const BenchTokenCountResponseSchema = z.strictObject({ length: z.number().int().nonnegative() });
export type BenchTokenCountResponse = z.infer<typeof BenchTokenCountResponseSchema>;