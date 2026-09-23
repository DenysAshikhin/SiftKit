import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { isOrchestratorTerminalPhase, type OrchestratorRunState } from '@siftkit/contracts';

import { getAbortError } from '../lib/abort.js';
import type { OrchestratorRunStore } from '../orchestrator/run-store.js';

export type RepositoryAccess = 'shared' | 'exclusive';

export type RepositoryLease = {
  readonly access: RepositoryAccess;
  /** Idempotent; the next compatible waiters are granted in queue order. */
  release(): void;
};

type RepositoryWaiter = { access: RepositoryAccess; grant(): void };
type RepositoryEntry = { holders: RepositoryAccess[]; waiters: RepositoryWaiter[] };

/** Canonical repository identity: real path, case-folded on Windows. Missing roots fail loudly. */
function canonicalRepositoryKey(repoRoot: string): string {
  const real = realpathSync.native(resolve(repoRoot));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Server-owned repository ownership: shared readers overlap, a writer is alone. Waiters are FIFO,
 * so once a writer queues no later reader starts ahead of it.
 */
export class RepositoryGate {
  private readonly entries = new Map<string, RepositoryEntry>();

  acquire(repoRoot: string, access: RepositoryAccess, abortSignal: AbortSignal): Promise<RepositoryLease> {
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
      const waiter: RepositoryWaiter = {
        access,
        grant: () => {
          abortSignal.removeEventListener('abort', onAbort);
          entry.holders.push(access);
          let released = false;
          resolveLease({ access, release: () => {
            if (released) return;
            released = true;
            entry.holders.splice(entry.holders.indexOf(access), 1);
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
      const compatible = entry.holders.length === 0
        || (next.access === 'shared' && !entry.holders.includes('exclusive'));
      if (!compatible) break;
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
};

type StateListener = (state: OrchestratorRunState) => void;

const RESTART_REASON = 'The server restarted while this run was active; uncertain work was not redispatched.';
const SHUTDOWN_REASON = 'The server is shutting down.';

/** Owns live parents, their state subscriptions, and the repository gate for one server. */
export class OrchestratorRunRegistry {
  readonly repositoryGate = new RepositoryGate();
  private readonly live = new Map<string, OrchestratorLiveRun>();
  private readonly listeners = new Map<string, Set<StateListener>>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly store: OrchestratorRunStore) {}

  /** A stored nonterminal parent has no owner after a restart; it is interrupted, never resumed. */
  reconcileOnStartup(): string[] {
    return this.store.listActive().map((state) => this.store.markInterrupted(state.runId, state.revision, RESTART_REASON).runId);
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
    const listeners = this.listeners.get(runId) ?? new Set<StateListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  /** Fans a committed state out to its subscribers. */
  publish(state: OrchestratorRunState): void {
    for (const listener of [...(this.listeners.get(state.runId) ?? [])]) listener(state);
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
