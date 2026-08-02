import { z } from './zod.js';
import { ServerErrorPayloadSchema } from './error-diagnostics.js';

export const OPERATION_STREAM_EVENTS = {
  progress: 'progress',
  result: 'result',
  error: 'error',
} as const;

export const ModelRequestQueueDiagnosticsSchema = z.object({
  activeCount: z.number(),
  activeRequests: z.array(z.object({
    kind: z.string(),
    startedAtUtc: z.string(),
    heldMs: z.number(),
    ownerRunId: z.string().nullable(),
  })),
  queueLength: z.number(),
  queuedRequests: z.array(z.object({
    kind: z.string(),
    enqueuedAtUtc: z.string(),
    waitMs: z.number(),
  })),
});
export type ModelRequestQueueDiagnostics = z.infer<typeof ModelRequestQueueDiagnosticsSchema>;

export const OperationStreamErrorSchema = ServerErrorPayloadSchema.extend({
  modelRequests: ModelRequestQueueDiagnosticsSchema.optional(),
});
export type OperationStreamError = z.infer<typeof OperationStreamErrorSchema>;

export const OPERATION_STREAM_HEARTBEAT_MS = 15_000;

export type LockWaitProgressEvent = {
  kind: 'lock_wait';
  queueLength: number;
  elapsedMs: number;
};
