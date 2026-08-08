import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../lib/process-inspector.js';
import {
  isActiveStatus,
  isTerminalStatus,
  repoAgentStateToResult,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from './run-schemas.js';
import type { RepoAgentRunStore } from './run-store.js';

const DEFAULT_POLL_INTERVAL_MS = 250;

export { repoAgentStateToResult };

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

  /** Reads current state; if the recorded worker pid is dead on a non-terminal state, records the failure first. */
  reconcileOnce(): RepoAgentRunState {
    const state = this.store.readState(this.runId);
    if (isActiveStatus(state.status)) {
      const pid = 'pid' in state ? state.pid : undefined;
      if (pid !== undefined && !this.processInspector.isAlive(pid)) {
        try {
          this.store.transition(this.runId, state.revision, {
            runId: this.runId,
            revision: state.revision + 1,
            updatedAtUtc: new Date().toISOString(),
            status: 'failed',
            pid,
            error: `Worker process ${pid} died unexpectedly.`,
          });
        } catch {
          // Another writer advanced the state first; the fresh read below wins.
        }
        return this.store.readState(this.runId);
      }
    }
    return state;
  }

  async waitForBoundary(fromRevision: number): Promise<RepoAgentRunResult> {
    if (!Number.isInteger(fromRevision) || fromRevision < 0) {
      throw new Error('Boundary revision must be a non-negative integer.');
    }
    for (;;) {
      let state: RepoAgentRunState;
      try {
        state = this.reconcileOnce();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read state for run ${this.runId}: ${msg}`);
      }

      if (state.revision <= fromRevision) {
        await this.sleep();
        continue;
      }
      if (isTerminalStatus(state.status) || state.status === 'approval_required') {
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
