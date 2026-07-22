import { ProgressWriter } from '../lib/progress-writer.js';
import type { SummaryProgressEvent } from '../summary/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { buildRepoSearchProgressLogBody } from './dashboard-runs.js';
import { serverLogger } from './server-logger.js';
import type { StreamedOperationContext } from './routes/streamed-operation-endpoint.js';

export class SummarySseProgressWriter extends ProgressWriter<SummaryProgressEvent> {
  constructor(private readonly stream: StreamedOperationContext) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: SummaryProgressEvent): void {
    this.stream.writeProgress(event);
  }
}

export class RepoSearchSseProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(protected readonly stream: StreamedOperationContext) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind !== 'thinking' && event.kind !== 'answer') {
      this.stream.writeProgress(event);
    }
  }
}

export class LoggedRepoSearchSseProgressWriter extends RepoSearchSseProgressWriter {
  constructor(
    stream: StreamedOperationContext,
    private readonly requestId: string,
  ) {
    super(stream);
  }

  override write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'tool_start') {
      const body = buildRepoSearchProgressLogBody(event);
      if (body) {
        serverLogger.emitBody('rs', this.requestId, body);
      }
    }
    super.write(event);
  }
}
