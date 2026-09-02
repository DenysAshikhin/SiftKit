import { InferenceRunFlushQueue } from './inference-run-flush-queue.js';
import type { InferenceBackendId } from '../config/types.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  flushInferenceRunLogChunks,
  updateInferenceRun,
  type InferenceRunStatus,
  type InferenceRunStreamKind,
} from '../state/inference-runs.js';

export type InferenceRunRecorderOptions = {
  backend: InferenceBackendId;
  purpose: string;
  entrypointPath: string | null;
  baseUrl: string | null;
  flushQueue: InferenceRunFlushQueue;
};

/** Raw character counts per stream, read by startup stall detection. */
export type InferenceRunStreamProgress = {
  stdoutChars: number;
  stderrChars: number;
};

export class InferenceRunRecorder {
  readonly runId: string;
  readonly backend: InferenceBackendId;
  readonly purpose: string;
  readonly baseUrl: string | null;
  readonly progress: InferenceRunStreamProgress = { stdoutChars: 0, stderrChars: 0 };
  private readonly flushQueue: InferenceRunFlushQueue;
  private flushEnabled = false;

  constructor(options: InferenceRunRecorderOptions) {
    this.backend = options.backend;
    this.purpose = options.purpose;
    this.baseUrl = options.baseUrl;
    this.flushQueue = options.flushQueue;
    this.runId = createInferenceRun({
      backend: options.backend,
      purpose: options.purpose,
      entrypointPath: options.entrypointPath,
      baseUrl: options.baseUrl,
      status: 'running',
    }).id;
  }

  /** Chunk flushes are queued only once the server is ready to drain them. */
  enableFlushQueue(): void {
    this.flushEnabled = true;
  }

  attachEngineStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stdout');
  }

  attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stderr');
  }

  attachLauncherStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stdout');
  }

  attachLauncherStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stderr');
  }

  /** Sees every raw chunk before storage; the base recorder has nothing to scrape. */
  protected observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    void streamKind;
    void chunkText;
  }

  appendLine(streamKind: InferenceRunStreamKind, text: string): void {
    this.observeRawChunk(streamKind, text);
    bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText: text });
    this.enqueueFlush();
  }

  flush(): void {
    flushInferenceRunLogChunks(this.runId);
  }

  /**
   * Terminal bookkeeping for a child that exited or failed to spawn. Callers run inside
   * EventEmitter handlers, where a throw is an unhandled exception that kills the process, and
   * the runtime DB may already be gone during test/process teardown.
   */
  finalize(options: {
    status: InferenceRunStatus;
    exitCode?: number | null;
    errorMessage?: string | null;
    baseUrl?: string | null;
  }): void {
    try {
      this.flush();
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    try {
      this.finish(options);
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
  }

  finish(options: {
    status: InferenceRunStatus;
    exitCode?: number | null;
    errorMessage?: string | null;
    baseUrl?: string | null;
  }): void {
    updateInferenceRun({
      id: this.runId,
      status: options.status,
      exitCode: options.exitCode ?? null,
      errorMessage: options.errorMessage ?? null,
      finishedAtUtc: new Date().toISOString(),
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  private enqueueFlush(): void {
    if (!this.flushEnabled) {
      return;
    }
    this.flushQueue.enqueue(this.runId, this.backend);
  }

  private countProgress(streamKind: InferenceRunStreamKind, characters: number): void {
    if (streamKind === 'engine_stdout' || streamKind === 'launcher_stdout') {
      this.progress.stdoutChars += characters;
      return;
    }
    this.progress.stderrChars += characters;
  }

  private attach(stream: NodeJS.ReadableStream | null, streamKind: InferenceRunStreamKind): void {
    if (!stream) {
      return;
    }
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      try {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.countProgress(streamKind, chunkText.length);
        this.observeRawChunk(streamKind, chunkText);
        if (chunkText) {
          bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText });
          this.enqueueFlush();
        }
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
    stream.on('error', (error: Error) => {
      try {
        this.appendLine(streamKind, `\n[stream-error] ${error.message}\n`);
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
  }
}
