export type SummaryProgressEvent = {
  kind: 'start' | 'config_start' | 'config_done' | 'host_sync' | 'decision_done'
    | 'core_start' | 'core_done' | 'tokenize_start' | 'tokenize_done'
    | 'completed' | 'failed';
  requestId: string;
  inputChars?: number;
  source?: string;
  backend?: string;
  model?: string;
  numCtxLocal?: number;
  numCtxHost?: number;
  rawReviewRequired?: boolean;
  chars?: number;
  phase?: string;
  chunk?: string;
  promptChars?: number;
  promptTokens?: number | null;
  tokenSource?: string;
  classification?: string;
  errorMessage?: string;
};

/** Emits typed lifecycle events for one summary request. */
export class SummaryProgressReporter {
  private readonly progressWriter: ProgressWriter<SummaryProgressEvent>;
  private readonly requestId: string;

  constructor(options: {
    requestId: string;
    progressWriter: ProgressWriter<SummaryProgressEvent>;
  }) {
    this.requestId = options.requestId;
    this.progressWriter = options.progressWriter;
  }

  get enabled(): boolean {
    return this.progressWriter.enabled;
  }

  start(inputChars: number): void {
    this.emit({ kind: 'start', requestId: this.requestId, inputChars });
  }

  configStart(source: string): void {
    this.emit({ kind: 'config_start', requestId: this.requestId, source });
  }

  configDone(backend: string, model: string): void {
    this.emit({ kind: 'config_done', requestId: this.requestId, backend, model });
  }

  hostSync(numCtxLocal: number, numCtxHost: number): void {
    this.emit({ kind: 'host_sync', requestId: this.requestId, numCtxLocal, numCtxHost });
  }

  decisionDone(backend: string, rawReviewRequired: boolean, chars: number): void {
    this.emit({ kind: 'decision_done', requestId: this.requestId, backend, rawReviewRequired, chars });
  }

  coreStart(backend: string): void {
    this.emit({ kind: 'core_start', requestId: this.requestId, backend });
  }

  coreDone(backend: string): void {
    this.emit({ kind: 'core_done', requestId: this.requestId, backend });
  }

  tokenizeStart(phase: string, chunk: string, promptChars: number): void {
    this.emit({ kind: 'tokenize_start', requestId: this.requestId, phase, chunk, promptChars });
  }

  tokenizeDone(
    phase: string,
    chunk: string,
    promptTokens: number | null,
    tokenSource: string,
  ): void {
    this.emit({ kind: 'tokenize_done', requestId: this.requestId, phase, chunk, promptTokens, tokenSource });
  }

  completed(classification: string): void {
    this.emit({ kind: 'completed', requestId: this.requestId, classification });
  }

  failed(errorMessage: string): void {
    this.emit({ kind: 'failed', requestId: this.requestId, errorMessage });
  }

  private emit(event: SummaryProgressEvent): void {
    this.progressWriter.write(event);
  }
}
import type { ProgressWriter } from '../lib/progress-writer.js';
