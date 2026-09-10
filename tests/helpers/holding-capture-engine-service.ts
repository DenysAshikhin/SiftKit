import { ProgressWriter } from '../../src/lib/progress-writer.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../../src/repo-search/types.js';
import { StatusEngineService } from '../../src/status-server/engine-service.js';

/**
 * Forwards every progress event to the real writer and reports the first tool start whose command
 * matches, so a test can stop a run at an exact point instead of racing a timer.
 */
class ObservingProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly inner: ProgressWriter<RepoSearchProgressEvent>,
    private readonly holdCommand: string,
    private readonly held: Deferred,
  ) {
    super();
  }

  get enabled(): boolean {
    return this.inner.enabled;
  }

  override get wantsLiveText(): boolean {
    return this.inner.wantsLiveText;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'tool_start' && event.command === this.holdCommand) this.held.notify();
    this.inner.write(event);
  }
}

class Deferred {
  readonly promise: Promise<void>;
  private settle: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.settle = resolve; });
  }

  notify(): void {
    const settle = this.settle;
    this.settle = null;
    settle?.();
  }
}

/**
 * The real engine, with two hooks: every request it receives is captured, and the run can be held
 * at the start of one named tool so a test stops it after an earlier tool has completed.
 */
export class HoldingCaptureEngineService extends StatusEngineService {
  readonly requests: RepoSearchExecutionRequest[] = [];
  private readonly held = new Deferred();
  private readonly unwound = new Deferred();
  private readonly released = new Deferred();

  constructor(
    private readonly holdCommand: string,
    private readonly pauseAfterAbort = false,
  ) {
    super();
  }

  waitUntilHoldingTool(): Promise<void> {
    return this.held.promise;
  }

  /** Resolves once the aborted run has unwound but before the chat turn is persisted. */
  waitUntilUnwound(): Promise<void> {
    return this.unwound.promise;
  }

  releaseAfterAbort(): void {
    this.released.notify();
  }

  /** The captured request whose prompt contains `needle`; plan wraps its prompt, so containment is the match. */
  requireRequest(needle: string): RepoSearchExecutionRequest {
    const request = this.requests.find((entry) => entry.prompt.includes(needle));
    if (!request) {
      throw new Error(`Expected a captured engine request containing ${JSON.stringify(needle)}.`);
    }
    return request;
  }

  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.requests.push(request);
    const inner = request.progressWriter;
    if (!inner) {
      return await super.executeRepoSearch(request);
    }
    const progressWriter = new ObservingProgressWriter(inner, this.holdCommand, this.held);
    try {
      return await super.executeRepoSearch({ ...request, progressWriter });
    } catch (error) {
      this.unwound.notify();
      if (this.pauseAfterAbort) {
        await this.released.promise;
      }
      throw error;
    }
  }
}
