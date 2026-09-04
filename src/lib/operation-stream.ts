import { z } from './zod.js';
import { ServerErrorPayloadSchema, type ErrorDiagnostic } from './error-diagnostics.js';
import { parseJsonObjectText, parseJsonText } from './json.js';
import type { JsonObject } from './json-types.js';
import type { SseFrame } from './sse-frame-parser.js';

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

/** Idle ceiling for an operation stream: a model turn may be silent for a long time. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const OPERATION_STREAM_NO_RESULT_ERROR = 'Operation stream ended before a result frame.';

/** The server's terminal `error` frame, rehydrated on the client side with its diagnostics intact. */
export class StatusServerOperationError extends Error {
  public readonly diagnosticId: string;
  public readonly diagnostic: ErrorDiagnostic;
  public readonly modelRequests: ModelRequestQueueDiagnostics | undefined;

  constructor(payload: OperationStreamError) {
    super(payload.error);
    this.name = payload.errorName;
    this.diagnosticId = payload.diagnosticId;
    this.diagnostic = payload.diagnostic;
    this.modelRequests = payload.modelRequests;
  }
}

export type OperationStreamFrame<T> =
  | { kind: 'progress'; event: JsonObject }
  | { kind: 'result'; result: T }
  | { kind: 'ignored' };

/**
 * Sorts one SSE frame into the operation protocol's three outcomes. Consumers differ only in
 * what they do with progress frames, so the terminal semantics live here once: an `error` frame
 * always throws, and a `result` frame is always parsed against the caller's schema.
 */
export function classifyOperationStreamFrame<T>(
  frame: SseFrame,
  schema: z.ZodType<T>,
): OperationStreamFrame<T> {
  if (frame.event === OPERATION_STREAM_EVENTS.progress) {
    return { kind: 'progress', event: parseJsonObjectText(frame.data) };
  }
  if (frame.event === OPERATION_STREAM_EVENTS.error) {
    throw new StatusServerOperationError(OperationStreamErrorSchema.parse(parseJsonObjectText(frame.data)));
  }
  if (frame.event === OPERATION_STREAM_EVENTS.result) {
    return { kind: 'result', result: parseJsonText(frame.data, schema) };
  }
  return { kind: 'ignored' };
}
