import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  getModelRequestQueueDiagnostics,
  releaseModelRequest,
} from './server-ops.js';
import type { ServerContext } from './server-types.js';
import type { RepoAgentModelLockAdapter } from './repo-agent-sessions.js';

/** Session-owned model lock: acquired without an HTTP request, released when the run settles. */
export class ServerModelLockAdapter implements RepoAgentModelLockAdapter {
  constructor(private readonly ctx: ServerContext) {}

  async acquire(runId: string): Promise<{ release(): void } | null> {
    const lock = await acquireModelRequestWithWait(this.ctx, 'repo_search', undefined, undefined, {
      ownerRunId: runId,
    });
    if (!lock) {
      return null;
    }
    try {
      await ensureActivePresetReadyForModelRequest(this.ctx);
    } catch (error) {
      releaseModelRequest(this.ctx, lock.token);
      throw error;
    }
    return {
      release: () => {
        releaseModelRequest(this.ctx, lock.token);
      },
    };
  }

  queueLength(): number {
    return getModelRequestQueueDiagnostics(this.ctx).queueLength;
  }
}