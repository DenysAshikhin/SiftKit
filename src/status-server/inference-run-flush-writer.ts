import { EventEmitter } from 'node:events';

import { toError } from '../lib/errors.js';
import { appendInferenceRunLogChunks } from '../state/inference-runs.js';
import type { FlushWorkerRequest, FlushWorkerResponse } from './inference-run-flush-messages.js';

/** Whether a batch has anything to write; an empty one is answered without opening the database. */
export function hasFlushChunks(request: FlushWorkerRequest): boolean {
  return request.entries.some((entry) => entry.chunkText.length > 0);
}

/** Writes one batch's non-empty chunks and answers it; the worker thread and the in-process writer share this. */
export function answerFlushRequest(request: FlushWorkerRequest): FlushWorkerResponse {
  const entries = request.entries.filter((entry) => entry.chunkText.length > 0);
  if (entries.length === 0) return { id: request.id, ok: true };
  try {
    appendInferenceRunLogChunks({ runId: request.runId, entries, databasePath: request.databasePath });
    return { id: request.id, ok: true };
  } catch (error) {
    return { id: request.id, ok: false, errorMessage: toError(error).message };
  }
}

/** The part of a flush worker the queue talks to; a `Worker` thread satisfies it as is. */
export interface FlushWorkerPort {
  on(event: 'message', listener: (response: FlushWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: () => void): this;
  off(event: 'message', listener: (response: FlushWorkerResponse) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  postMessage(request: FlushWorkerRequest): void;
  unref(): void;
  terminate(): Promise<number>;
}

/**
 * In-memory runtime databases exist only on this thread, so the queue writes through this process's
 * own registry connection. Replies still arrive asynchronously, exactly as a worker's would.
 */
export class InProcessFlushWriter extends EventEmitter implements FlushWorkerPort {
  postMessage(request: FlushWorkerRequest): void {
    setImmediate(() => this.emit('message', answerFlushRequest(request)));
  }

  unref(): void {}

  terminate(): Promise<number> {
    this.emit('exit');
    return Promise.resolve(0);
  }
}
