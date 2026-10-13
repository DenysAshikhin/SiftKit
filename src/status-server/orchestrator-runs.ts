import { isOrchestratorTerminalPhase, type OrchestratorActivity, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';

import { getAbortError } from '../lib/abort.ts';
import { canonicalRepositoryKey } from '../lib/repository-key.ts';
import type { OrchestratorRunStore } from '../orchestrator/run-store.ts';

/** An `exclusive` holder overlaps only shared readers with the same owner. */
export type RepositoryAccess = 'shared' | 'exclusive';

/** The child run store's part in a restart: a running child of an interrupted parent never resumes. */
export type InterruptedChildRuns = { markNotResumable(runId: string): void };

export type RepositoryLease = {
  readonly access: RepositoryAccess;
  /** Idempotent; the next compatible waiters are granted in queue order. */
  release(): void;
};

/** One held or requested access; `owner` (an orchestrator run ID, or null) scopes exclusive overlap. */
type RepositoryClaim = { access: RepositoryAccess; owner: string | null };
type RepositoryWaiter = RepositoryClaim & { grant(): void };
type RepositoryEntry = { holders: RepositoryClaim[]; waiters: RepositoryWaiter[] };

function sameOwner(left: RepositoryClaim, right: RepositoryClaim): boolean {
  return left.owner !== null && left.owner === right.owner;
}

function isCompatible(next: RepositoryClaim, holders: readonly RepositoryClaim[]): boolean {
  if (holders.length === 0) return true;
  if (next.access === 'shared') return holders.every((holder) => holder.access === 'shared' || sameOwner(holder, next));
  return holders.every((holder) => holder.access === 'shared' && sameOwner(holder, next));
}

/**
 * Server-owned repository ownership: shared readers overlap, and one exclusive holder overlaps only its
 * own run's readers. Waiters are FIFO, so no later request starts ahead of one queued.
 */
export class RepositoryGate {
  private readonly entries = new Map<string, RepositoryEntry>();

  acquire(repoRoot: string, access: RepositoryAccess, owner: string | null, abortSignal: AbortSignal): Promise<RepositoryLease> {
    let key: string;
    try {
      key = canonicalRepositoryKey(repoRoot);
    } catch (error) {
      return Promise.reject(error);
    }
    if (abortSignal.aborted) return Promise.reject(getAbortError(abortSignal));
    const entry = this.entries.get(key) ?? { holders: [], waiters: [] };
    this.entries.set(key, entry);
    return new Promise((resolveLease, rejectLease) => {
      const onAbort = (): void => {
        entry.waiters.splice(entry.waiters.indexOf(waiter), 1);
        this.drain(key, entry);
        rejectLease(getAbortError(abortSignal));
      };
      const claim: RepositoryClaim = { access, owner };
      const waiter: RepositoryWaiter = {
        ...claim,
        grant: () => {
          abortSignal.removeEventListener('abort', onAbort);
          entry.holders.push(claim);
          let released = false;
          resolveLease({ access, release: () => {
            if (released) return;
            released = true;
            entry.holders.splice(entry.holders.indexOf(claim), 1);
            this.drain(key, entry);
          } });
        },
      };
      entry.waiters.push(waiter);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      this.drain(key, entry);
    });
  }

  private drain(key: string, entry: RepositoryEntry): void {
    for (let next = entry.waiters[0]; next; next = entry.waiters[0]) {
      if (!isCompatible(next, entry.holders)) break;
      entry.waiters.shift();
      next.grant();
    }
    if (entry.holders.length === 0 && entry.waiters.length === 0) this.entries.delete(key);
  }
}

/** A running parent the registry can stop; `settled` resolves once it has recorded its outcome. */
export type OrchestratorLiveRun = {
  readonly runId: string;
  readonly settled: Promise<void>;
  abort(reason: string): void;
  /** Answers the pending user approval; false when that approval is not the one waiting. */
  decide(approvalId: string, decision: RepoAgentDecision): boolean;
  /** The current live view, for a client that connects mid-run. */
  activitySnapshot(): OrchestratorActivity;
};

type StateListener = (state: OrchestratorRunState) => void;
type ActivityListener = (activity: OrchestratorActivity) => void;

function addListener<T>(listeners: Map<string, Set<(value: T) => void>>, runId: string, listener: (value: T) => void): () => void {
  const forRun = listeners.get(runId) ?? new Set<(value: T) => void>();
  forRun.add(listener);
  listeners.set(runId, forRun);
  return () => {
    forRun.delete(listener);
    if (forRun.size === 0) listeners.delete(runId);
  };
}

const RESTART_REASON = 'The server restarted while this run was active; uncertain work was not redispatched.';
const SHUTDOWN_REASON = 'The server is shutting down.';

/** Owns live parents, their state subscriptions, and the repository gate for one server. */
export class OrchestratorRunRegistry {
  readonly repositoryGate = new RepositoryGate();
  private readonly live = new Map<string, OrchestratorLiveRun>();
  private readonly listeners = new Map<string, Set<StateListener>>();
  private readonly activityListeners = new Map<string, Set<ActivityListener>>();
  private shutdownPromise: Promise<void> | null = null;

  private readonly store: OrchestratorRunStore;

  constructor(store: OrchestratorRunStore) {
    this.store = store;
  }

  /** A stored nonterminal parent has no owner after a restart: it is interrupted and its running children are not resumable. */
  reconcileOnStartup(children: InterruptedChildRuns): string[] {
    return this.store.listActive().map((state) => {
      for (const attempt of state.attempts) {
        if (attempt.status === 'running') children.markNotResumable(attempt.childRunId);
      }
      return this.store.markInterrupted(state.runId, state.revision, RESTART_REASON).runId;
    });
  }

  register(run: OrchestratorLiveRun): void {
    if (this.shutdownPromise) throw new Error(`Cannot start orchestrator run ${run.runId}: the server is shutting down.`);
    if (this.live.has(run.runId)) throw new Error(`Orchestrator run ${run.runId} is already live.`);
    this.live.set(run.runId, run);
    void run.settled.finally(() => {
      if (this.live.get(run.runId) === run) this.live.delete(run.runId);
    });
  }

  get(runId: string): OrchestratorLiveRun | undefined {
    return this.live.get(runId);
  }

  subscribe(runId: string, listener: StateListener): () => void {
    return addListener(this.listeners, runId, listener);
  }

  /** Fans a committed state out to its subscribers. */
  publish(state: OrchestratorRunState): void {
    for (const listener of [...(this.listeners.get(state.runId) ?? [])]) listener(state);
  }

  subscribeActivity(runId: string, listener: ActivityListener): () => void {
    return addListener(this.activityListeners, runId, listener);
  }

  /** Fans the live view out to its subscribers; nothing is stored. */
  publishActivity(activity: OrchestratorActivity): void {
    for (const listener of [...(this.activityListeners.get(activity.runId) ?? [])]) listener(activity);
  }

  /** Idempotent: stop accepting parents, abort the live ones, await them, interrupt the unsettled. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.stopAll();
    return this.shutdownPromise;
  }

  private async stopAll(): Promise<void> {
    const runs = [...this.live.values()];
    for (const run of runs) run.abort(SHUTDOWN_REASON);
    await Promise.allSettled(runs.map((run) => run.settled));
    for (const run of runs) {
      const state = this.store.read(run.runId);
      if (!isOrchestratorTerminalPhase(state.phase)) this.publish(this.store.markInterrupted(run.runId, state.revision, SHUTDOWN_REASON));
    }
  }
}
