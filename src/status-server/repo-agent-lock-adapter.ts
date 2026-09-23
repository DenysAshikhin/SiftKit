import {
  UncancelledModelWaitError,
  acquireModelRequestWithWait,
  getModelRequestQueueDiagnostics,
  releaseModelRequest,
  renewModelRequestActivity,
} from './server-ops.js';
import type { ModelQueueTimeout, ServerContext } from './server-types.js';
import type { RepoAgentModelLockAdapter, RepoAgentModelLockHandle } from './repo-agent-sessions.js';

/** Session-owned model lock: acquired without an HTTP request, released when the run settles. */
export class ServerModelLockAdapter implements RepoAgentModelLockAdapter {
  constructor(
    private readonly ctx: ServerContext,
    private readonly queueTimeout: ModelQueueTimeout | undefined,
  ) {}

  async acquire(runId: string, abortSignal: AbortSignal): Promise<RepoAgentModelLockHandle | null> {
    // Admission readies the model before granting; a refused target or failed load rejects here.
    const lock = await acquireModelRequestWithWait(this.ctx, 'repo_search', undefined, undefined, {
      ownerRunId: runId,
      abortSignal,
      queueTimeout: this.queueTimeout,
    });
    if (!lock) {
      if (this.queueTimeout === 'none' && !abortSignal.aborted) throw new UncancelledModelWaitError('repo_search');
      return null;
    }
    return {
      release: () => {
        releaseModelRequest(this.ctx, lock.token);
      },
      renewActivity: () => {
        renewModelRequestActivity(this.ctx, lock.token);
      },
    };
  }

  queueLength(): number {
    return getModelRequestQueueDiagnostics(this.ctx).queueLength;
  }
}
