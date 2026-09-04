import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../../src/repo-search/types.js';
import { StatusEngineService } from '../../src/status-server/engine-service.js';

class DeferredNotification {
  readonly promise: Promise<void>;
  private settle: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.settle = resolve; });
  }

  notify(): void {
    const settle = this.settle;
    if (!settle) return;
    this.settle = null;
    settle();
  }
}

export type StoppedChatEngineScenario = {
  prompt: string;
  progressEvents: readonly RepoSearchProgressEvent[];
  pauseAfterAbort?: boolean;
};

export class StoppedChatEngineService extends StatusEngineService {
  private readonly entered = new DeferredNotification();
  private readonly aborted = new DeferredNotification();
  private readonly postAbortRelease = new DeferredNotification();

  constructor(private readonly scenario: StoppedChatEngineScenario) {
    super();
  }

  waitUntilEntered(): Promise<void> {
    return this.entered.promise;
  }

  waitUntilAborted(): Promise<void> {
    return this.aborted.promise;
  }

  releaseAfterAbort(): void {
    this.postAbortRelease.notify();
  }

  override async executeRepoSearch(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    if (request.prompt !== this.scenario.prompt) {
      return await super.executeRepoSearch(request);
    }
    const signal = request.abortSignal;
    if (!signal) {
      throw new Error('StoppedChatEngineService requires an abort signal.');
    }
    for (const event of this.scenario.progressEvents) {
      request.progressWriter?.write(event);
    }
    this.entered.notify();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    this.aborted.notify();
    if (this.scenario.pauseAfterAbort === true) {
      await this.postAbortRelease.promise;
    }
    throw new Error('Chat request aborted.');
  }
}
