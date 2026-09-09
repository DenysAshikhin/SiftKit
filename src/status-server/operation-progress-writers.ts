import { ProgressWriter } from '../lib/progress-writer.js';
import type { SummaryProgressEvent } from '../summary/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { buildRepoSearchProgressLogBody, isServerLoggedProgressEvent } from './dashboard-runs.js';
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

  override get wantsLiveText(): boolean {
    return false;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind !== 'thinking' && event.kind !== 'answer') {
      this.stream.writeProgress(event);
    }
  }
}

/**
 * The single implementation of "an operation's progress reaches the server console". Exactly one
 * of these is composed at an operation's boundary; the writers that render to a client never log,
 * so the number of console lines follows the number of invocations, not the number of readers.
 */
export class RepoSearchToolLogProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return false;
  }

  write(event: RepoSearchProgressEvent): void {
    if (!isServerLoggedProgressEvent(event)) return;
    const body = buildRepoSearchProgressLogBody(event);
    if (body) {
      serverLogger.emitBody(this.scope, this.requestId, body);
    }
  }
}

export class LoggedRepoSearchSseProgressWriter extends RepoSearchSseProgressWriter {
  private readonly log: RepoSearchToolLogProgressWriter;

  constructor(stream: StreamedOperationContext, requestId: string) {
    super(stream);
    this.log = new RepoSearchToolLogProgressWriter('rs', requestId);
  }

  override write(event: RepoSearchProgressEvent): void {
    this.log.write(event);
    super.write(event);
  }
}

/**
 * Fans one operation's progress out to writers with different jobs — one renders, one logs. Every
 * writer sees every event, so composition order never decides what a reader or the console gets.
 */
export class CompositeRepoSearchProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly writers: readonly ProgressWriter<RepoSearchProgressEvent>[];

  constructor(...writers: readonly ProgressWriter<RepoSearchProgressEvent>[]) {
    super();
    this.writers = writers;
  }

  get enabled(): boolean {
    return this.writers.some((writer) => writer.enabled);
  }

  override get wantsLiveText(): boolean {
    return this.writers.some((writer) => writer.wantsLiveText);
  }

  write(event: RepoSearchProgressEvent): void {
    for (const writer of this.writers) {
      writer.write(event);
    }
  }
}
