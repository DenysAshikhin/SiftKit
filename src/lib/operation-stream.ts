import { z } from './zod.js';

export const OPERATION_STREAM_EVENTS = {
  progress: 'progress',
  result: 'result',
  error: 'error',
} as const;

export const OperationStreamErrorSchema = z.object({ message: z.string() });
export type OperationStreamError = z.infer<typeof OperationStreamErrorSchema>;

export const OPERATION_STREAM_HEARTBEAT_MS = 15_000;

export type LockWaitProgressEvent = {
  kind: 'lock_wait';
  queueLength: number;
  elapsedMs: number;
};
