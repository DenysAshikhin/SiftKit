import { ProgressWriter } from '../lib/progress-writer.js';
import type { SummaryProgressEvent } from '../summary/progress-reporter.js';
import type { StreamedOperationStream } from './routes/streamed-operation-endpoint.js';

export class SummarySseProgressWriter extends ProgressWriter<SummaryProgressEvent> {
  constructor(private readonly stream: StreamedOperationStream) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: SummaryProgressEvent): void {
    this.stream.emitProgress(event);
  }
}
