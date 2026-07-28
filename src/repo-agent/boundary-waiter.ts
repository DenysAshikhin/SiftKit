import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../lib/process-inspector.js';
import {
  RepoAgentRunResultSchema,
  isActiveStatus,
  isTerminalStatus,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from './run-schemas.js';
import type { RepoAgentRunStore } from './run-store.js';

const DEFAULT_POLL_INTERVAL_MS = 250;

function isBoundaryStatus(status: RepoAgentRunState['status']): boolean {
  return (
    status === 'approval_required'
    || status === 'completed'
    || status === 'failed'
    || status === 'aborted'
  );
}

export function repoAgentStateToResult(
  state: RepoAgentRunState,
): RepoAgentRunResult {
  switch (state.status) {
    case 'completed':
      return RepoAgentRunResultSchema.parse({
        status: 'completed',
        runId: state.runId,
        output: state.output,
      });
    case 'approval_required':
      return RepoAgentRunResultSchema.parse({
        status: 'approval_required',
        runId: state.runId,
        approval: state.approval,
      });
    case 'failed':
      return RepoAgentRunResultSchema.parse({
        status: 'failed',
        runId: state.runId,
        error: state.error,
      });
    case 'aborted':
      return RepoAgentRunResultSchema.parse({
        status: 'aborted',
        runId: state.runId,
      });
    default:
      throw new Error(`Cannot convert ${state.status} to a public result.`);
  }
}

export class RepoAgentBoundaryWaiter {
  private readonly store: RepoAgentRunStore;
  private readonly runId: string;
  private readonly pollIntervalMs: number;
  private readonly processInspector: ProcessInspector;

  constructor(options: {
    store: RepoAgentRunStore;
    runId: string;
    pollIntervalMs?: number;
    processInspector?: ProcessInspector;
  }) {
    this.store = options.store;
    this.runId = options.runId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error('Boundary poll interval must be a positive number.');
    }
    this.processInspector = options.processInspector ?? new NodeProcessInspector();
  }

  async waitForBoundary(fromRevision: number): Promise<RepoAgentRunResult> {
    if (!Number.isInteger(fromRevision) || fromRevision < 0) {
      throw new Error('Boundary revision must be a non-negative integer.');
    }
    for (;;) {
      let state: RepoAgentRunState;
      try {
        state = this.store.readState(this.runId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read state for run ${this.runId}: ${msg}`);
      }

      if (isActiveStatus(state.status)) {
        const pid = 'pid' in state ? state.pid : undefined;
        if (pid !== undefined && !this.processInspector.isAlive(pid)) {
          const errorMsg = `Worker process ${pid} died unexpectedly.`;
          try {
            this.store.transition(this.runId, state.revision, {
              runId: this.runId,
              revision: state.revision + 1,
              updatedAtUtc: new Date().toISOString(),
              status: 'failed',
              pid,
              error: errorMsg,
            });
          } catch (error) {
            const latest = this.store.readState(this.runId);
            if (latest.revision <= state.revision) {
              throw error;
            }
            if (isBoundaryStatus(latest.status)) {
              return repoAgentStateToResult(latest);
            }
            continue;
          }
          return repoAgentStateToResult(this.store.readState(this.runId));
        }
      }

      if (state.revision <= fromRevision) {
        await this.sleep();
        continue;
      }

      if (isTerminalStatus(state.status)) {
        return repoAgentStateToResult(state);
      }

      if (state.status === 'approval_required') {
        return repoAgentStateToResult(state);
      }

      await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.pollIntervalMs);
    });
  }
}
