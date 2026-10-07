import {
  UncancelledModelWaitError,
  acquireModelRequestWithWait,
  releaseModelRequest,
  renewModelRequestActivity,
} from './server-ops.ts';
import type { ModelQueueTimeout, ServerContext } from './server-types.ts';
import type { RepoAgentModelLockAdapter, RepoAgentModelLockHandle } from './repo-agent-sessions.ts';
import type { ModelRequestIntent } from '../lib/model-request-intent.ts';

/** Session-owned model lock: acquired without an HTTP request, released when the run settles. */
export class ServerModelLockAdapter implements RepoAgentModelLockAdapter {
  private readonly ctx: ServerContext;
  private readonly queueTimeout: ModelQueueTimeout | undefined;
  private readonly intent: ModelRequestIntent;

  constructor(
    ctx: ServerContext,
    queueTimeout: ModelQueueTimeout | undefined,
    intent: ModelRequestIntent,
  ) {
    this.ctx = ctx;
    this.queueTimeout = queueTimeout;
    this.intent = intent;
  }

  async acquire(runId: string, abortSignal: AbortSignal): Promise<RepoAgentModelLockHandle | null> {
    // Admission readies the model before granting; a refused target or failed load rejects here.
    const lock = await acquireModelRequestWithWait(this.ctx, 'repo_search', undefined, undefined, {
      ownerRunId: runId,
      abortSignal,
      queueTimeout: this.queueTimeout,
      intent: this.intent,
    });
    if (!lock) {
      if (this.queueTimeout === 'none' && !abortSignal.aborted) throw new UncancelledModelWaitError('repo_search');
      return null;
    }
    return {
      context: lock.context,
      release: () => {
        releaseModelRequest(this.ctx, lock.token);
      },
      renewActivity: () => {
        renewModelRequestActivity(this.ctx, lock.token);
      },
    };
  }

  queueLength(): number {
    return this.ctx.modelRequestQueue.length;
  }
}
