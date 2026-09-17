import { z } from '../lib/zod.js';
import { InferenceRunStreamKindSchema } from '../state/inference-runs.js';

/**
 * The inference-run flush protocol, declared once and parsed at both ends of the thread boundary.
 *
 * `id` is the queue's own message counter and the only thing that identifies a *batch*: two
 * successive batches of one run carry the same run id, so a reply can only be attributed to the
 * batch it answers by that id. Anything that stands between the queue and the flush worker — a
 * fixture that delays replies, for instance — speaks this protocol unchanged.
 */
export const FlushWorkerRequestSchema = z.object({
  id: z.number().int().positive(),
  runId: z.string().min(1),
  databasePath: z.string().min(1),
  entries: z.array(z.object({
    streamKind: InferenceRunStreamKindSchema,
    chunkText: z.string(),
  })),
});

export type FlushWorkerRequest = z.infer<typeof FlushWorkerRequestSchema>;

export const FlushWorkerResponseSchema = z.object({
  id: z.number().int().positive(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
});

export type FlushWorkerResponse = z.infer<typeof FlushWorkerResponseSchema>;