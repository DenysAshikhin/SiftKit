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

/** The queue length is unknown to a session that only waits on its own lock, so it is optional. */
export const LockWaitProgressEventSchema = z.object({
  kind: z.literal('lock_wait'),
  queueLength: z.number().optional(),
  elapsedMs: z.number(),
});
export type LockWaitProgressEvent = z.infer<typeof LockWaitProgressEventSchema>;

/**
 * Emitted by repo-search and by summary, and rendered by the one CLI renderer both
 * feed, so the shape is defined here rather than duplicated in each subsystem.
 */
export const ContextWarningProgressEventSchema = z.object({
  kind: z.literal('context_warning'),
  warningText: z.string(),
});
export type ContextWarningProgressEvent = z.infer<typeof ContextWarningProgressEventSchema>;

export function contextWarningEvent(warningText: string): ContextWarningProgressEvent {
  return { kind: 'context_warning', warningText };
}
