import { toError } from '../lib/errors.js';
import { getAbortError } from '../lib/abort.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import { classifyRepoAgentExecutionResult } from '../repo-agent/run-output.js';
import type { RepoAgentDecideRequest } from '../repo-agent/api-schemas.js';
import {
  isTerminalStatus,
  RepoAgentRunStateSchema,
  repoAgentStateToResult,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../repo-agent/run-schemas.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import {
  ApprovalGate,
  CLIENT_ABORT_MESSAGE,
  type ApprovalDecision,
  type ApprovalGateObserver,
  type ApprovalMode,
} from '../repo-search/engine/approval-gate.js';
import { RepoSearchResponseSanityChecker } from '../repo-search/response-sanity.js';
import type {
  ApprovalRequestProgressEvent,
  OperationProgressEvent,
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../repo-search/types.js';
import {
  buildRepoSearchProgressLogBody,
  isLiveTextProgressEvent,
  isServerLoggedProgressEvent,
} from './dashboard-runs.js';
import {
  markRepoSearchAdmissionFailed,
  type RepoSearchAdmissionRecord,
} from './repo-search-admissions.js';
import { serverLogger } from './server-logger.js';

const LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

function normalizeFailureMessage(message: string): string {
  const normalized = message.trim();
  return normalized || 'Repo-agent execution failed without an error message.';
}

export type RepoAgentSessionSubscriber = {
  /** Whether this subscriber wants per-token live-text events fanned out to it. */
  readonly wantsLiveText: boolean;
  writeProgress(event: OperationProgressEvent): void;
};

export type RepoAgentEngine = {
  executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult>;
};

export type RepoAgentModelLockAdapter = {
  /** Resolves once the model lock is held and the preset is ready; null on queue timeout. */
  acquire(runId: string): Promise<{ release(): void } | null>;
  queueLength(): number;
};

export type RepoAgentEngineRequest = Omit<
  RepoSearchExecutionRequest,
  'progressWriter' | 'approvalGate' | 'approvalMode' | 'abortSignal'
>;

type BoundaryWaiter = {
  sinceRevision: number;
  resolve(result: RepoAgentRunResult): void;
  reject(error: Error): void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
};

/** Routes engine progress into the session: approval parks become store state, the rest fans out. */
class SessionProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(private readonly session: RepoAgentSession) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return this.session.subscriberWantsLiveText();
  }

  write(event: RepoSearchProgressEvent): void {
    this.session.handleProgressEvent(event);
  }
}

export type RepoAgentSessionOptions = {
  runId: string;
  requestId: string;
  admission: RepoSearchAdmissionRecord;
  approvalMode: ApprovalMode;
  store: RepoAgentRunStore;
  engine: RepoAgentEngine;
  locks: RepoAgentModelLockAdapter;
  approvalGates: Map<string, ApprovalGate>;
  engineRequest: RepoAgentEngineRequest;
  decisionTimeoutMs?: number;
};

/**
 * Owns one repo-agent run end to end: model lock, engine execution, approval parks,
 * and every run-store transition. Client connections only attach/detach; they never
 * affect the run's lifetime.
 */
export class RepoAgentSession implements ApprovalGateObserver {
  readonly runId: string;
  private readonly requestId: string;
  private readonly admission: RepoSearchAdmissionRecord;
  private readonly approvalMode: ApprovalMode;
  private readonly store: RepoAgentRunStore;
  private readonly engine: RepoAgentEngine;
  private readonly locks: RepoAgentModelLockAdapter;
  private readonly approvalGates: Map<string, ApprovalGate>;
  private readonly engineRequest: RepoAgentEngineRequest;
  private readonly abortController = new AbortController();
  private readonly progressWriter = new SessionProgressWriter(this);
  private readonly gate: ApprovalGate | undefined;
  private readonly waiters: BoundaryWaiter[] = [];
  private subscriber: RepoAgentSessionSubscriber | null = null;
  // In-memory only on purpose: large thinking text must never land in the persisted run state.
  private executionResult: RepoSearchExecutionResult | null = null;
  private state: RepoAgentRunState;
  private unpersistedTerminalState = false;
  private settledPromise: Promise<void> | null = null;

  constructor(options: RepoAgentSessionOptions) {
    this.runId = options.runId;
    this.requestId = options.requestId;
    this.admission = options.admission;
    this.approvalMode = options.approvalMode;
    this.store = options.store;
    this.engine = options.engine;
    this.locks = options.locks;
    this.approvalGates = options.approvalGates;
    this.engineRequest = options.engineRequest;
    this.state = this.store.readState(this.runId);
    this.gate = options.approvalMode === 'off'
      ? undefined
      : new ApprovalGate({
        requestId: options.requestId,
        progressWriter: this.progressWriter,
        abortSignal: this.abortController.signal,
        bypassReadOnlyTools: true,
        observer: this,
        ...(options.decisionTimeoutMs === undefined
          ? {}
          : { decisionTimeoutMs: options.decisionTimeoutMs }),
      });
  }

  get settled(): Promise<void> {
    if (!this.settledPromise) {
      throw new Error('Session has not been started.');
    }
    return this.settledPromise;
  }

  start(): void {
    if (this.settledPromise) {
      throw new Error('Session already started.');
    }
    this.settledPromise = this.run();
  }

  currentRevision(): number {
    return this.state.revision;
  }

  getState(): RepoAgentRunState {
    return this.state;
  }

  getExecutionResult(): RepoSearchExecutionResult | null {
    return this.executionResult;
  }

  hasUnpersistedTerminalState(): boolean {
    return this.unpersistedTerminalState;
  }

  attach(subscriber: RepoAgentSessionSubscriber): () => void {
    this.subscriber = subscriber;
    return () => {
      if (this.subscriber === subscriber) {
        this.subscriber = null;
      }
    };
  }

  subscriberWantsLiveText(): boolean {
    return this.subscriber?.wantsLiveText === true;
  }

  /** Resolves the parked approval via the shared gate. False when nothing is parked. */
  submitDecision(input: RepoAgentDecideRequest): boolean {
    if (input.runId !== this.runId) {
      throw new Error(`Decision run ID ${input.runId} does not match session run ID ${this.runId}.`);
    }
    if (!this.gate || this.state.status !== 'approval_required') {
      return false;
    }
    const decision: ApprovalDecision = input.decision === 'approve'
      ? { kind: 'approve' }
      : input.decision === 'deny'
        ? { kind: 'deny', reason: input.reason }
        : { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
    return this.gate.submit(this.state.approval.approvalId, decision);
  }

  abort(): void {
    if (isTerminalStatus(this.state.status)) {
      return;
    }
    this.abortController.abort(new Error('Stopped by user.'));
  }

  waitForBoundary(
    sinceRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<RepoAgentRunResult> {
    const immediate = this.boundaryResultFor(sinceRevision);
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve, reject) => {
      const waiter: BoundaryWaiter = { sinceRevision, resolve, reject };
      if (abortSignal) {
        const abortListener = () => {
          this.removeWaiter(waiter);
          reject(getAbortError(abortSignal));
        };
        waiter.abortSignal = abortSignal;
        waiter.abortListener = abortListener;
        if (abortSignal.aborted) {
          abortListener();
          return;
        }
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  // ---- ApprovalGateObserver ----

  onDecision(decision: ApprovalDecision): void {
    if (this.state.status !== 'approval_required') {
      return;
    }
    this.applyState(this.store.clearPendingApproval(
      this.runId,
      this.state.revision,
      decision.kind === 'abort' ? 'aborted' : 'running',
    ));
  }

  onTimeout(): void {
    if (this.state.status !== 'approval_required') {
      return;
    }
    this.applyState(this.store.clearPendingApproval(
      this.runId,
      this.state.revision,
      'approval_timeout',
    ));
  }

  // ---- progress routing ----

  handleProgressEvent(event: RepoSearchProgressEvent): void {
    if (event.kind === 'approval_request') {
      this.publishApproval(event);
      if (this.approvalMode !== 'interactive') {
        return;
      }
    }
    if (event.kind === 'answer') {
      if (this.subscriber?.wantsLiveText) {
        this.subscriber.writeProgress(event);
      }
      return;
    }
    if (isLiveTextProgressEvent(event)) {
      if (this.subscriber?.wantsLiveText) {
        this.subscriber.writeProgress(event);
      }
      return;
    }
    if (isServerLoggedProgressEvent(event)) {
      const body = buildRepoSearchProgressLogBody(event);
      if (body) {
        serverLogger.emitBody('rs', this.requestId, body);
      }
    }
    this.subscriber?.writeProgress(event);
  }

  // ---- internals ----

  private async run(): Promise<void> {
    if (this.gate) {
      this.approvalGates.set(this.requestId, this.gate);
    }
    let lock: { release(): void } | null = null;
    const lockWaitStartedAt = Date.now();
    const lockWaitTimer = setInterval(() => {
      this.subscriber?.writeProgress({
        kind: 'lock_wait',
        elapsedMs: Date.now() - lockWaitStartedAt,
      });
    }, LOCK_WAIT_EMIT_INTERVAL_MS);
    lockWaitTimer.unref();
    try {
      try {
        lock = await this.locks.acquire(this.runId);
      } finally {
        clearInterval(lockWaitTimer);
      }
      if (!lock) {
        this.settleFailure('Timed out waiting for model request queue.');
        return;
      }
      this.applyState(this.store.transition(this.runId, this.state.revision, {
        runId: this.runId,
        revision: this.state.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'running',
        pid: process.pid,
      }));
      const result = await this.engine.executeRepoSearch({
        ...this.engineRequest,
        abortSignal: this.abortController.signal,
        progressWriter: this.progressWriter,
        ...(this.gate ? { approvalGate: this.gate } : {}),
        approvalMode: this.approvalMode,
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      this.executionResult = result;
      if (!isTerminalStatus(this.state.status)) {
        const outcome = classifyRepoAgentExecutionResult(result);
        this.applyState(this.store.transition(this.runId, this.state.revision, {
          runId: this.runId,
          revision: this.state.revision + 1,
          updatedAtUtc: new Date().toISOString(),
          pid: process.pid,
          ...outcome,
        }));
      }
    } catch (error) {
      if (this.abortController.signal.aborted && !isTerminalStatus(this.state.status)) {
        this.settleAborted();
      } else {
        this.settleFailure(toError(error).message);
      }
    } finally {
      lock?.release();
      if (this.gate) {
        this.approvalGates.delete(this.requestId);
      }
    }
  }

  private settleFailure(message: string): void {
    const failureMessage = normalizeFailureMessage(message);
    try {
      markRepoSearchAdmissionFailed(this.admission, failureMessage);
    } catch (error) {
      serverLogger.error({
        scope: 'rs',
        id: this.requestId,
        event: 'admission_failure_persistence_failed',
        fields: toError(error).message,
      });
    }
    if (isTerminalStatus(this.state.status)) {
      return;
    }
    const pid = this.state.pid;
    const failedState = {
      runId: this.runId,
      revision: this.state.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed' as const,
      ...(pid === undefined ? {} : { pid }),
      error: failureMessage,
    };
    try {
      this.applyState(this.store.transition(this.runId, this.state.revision, failedState));
    } catch (error) {
      const persistenceError = toError(error);
      const fallbackState = RepoAgentRunStateSchema.parse(failedState);
      serverLogger.error({
        scope: 'rs',
        id: this.requestId,
        event: 'session_failure_persistence_failed',
        fields: `Failed to persist repo-agent failure: ${persistenceError.message}. Original failure: ${failureMessage}`,
      });
      this.unpersistedTerminalState = true;
      this.applyState(fallbackState);
    }
  }

  private settleAborted(): void {
    if (isTerminalStatus(this.state.status)) {
      return;
    }
    const abortedState = {
      runId: this.runId,
      revision: this.state.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'aborted' as const,
      pid: process.pid,
    };
    try {
      this.applyState(this.store.transition(this.runId, this.state.revision, abortedState));
    } catch (error) {
      const persistenceError = toError(error);
      const fallbackState = RepoAgentRunStateSchema.parse(abortedState);
      serverLogger.error({
        scope: 'rs',
        id: this.requestId,
        event: 'session_abort_persistence_failed',
        fields: `Failed to persist repo-agent abort: ${persistenceError.message}`,
      });
      this.unpersistedTerminalState = true;
      this.applyState(fallbackState);
    }
  }

  private publishApproval(event: ApprovalRequestProgressEvent): void {
    const { approvalId, toolName, command } = event;
    if (this.state.status !== 'running') {
      throw new Error(`Approval requested while run ${this.runId} is ${this.state.status}.`);
    }
    this.applyState(this.store.publishApproval(this.runId, this.state.revision, {
      approvalId,
      toolName,
      command,
      reviewPayload: event.reviewPayload ?? null,
    }));
  }

  private boundaryResultFor(sinceRevision: number): RepoAgentRunResult | null {
    if (this.state.revision <= sinceRevision) {
      return null;
    }
    if (isTerminalStatus(this.state.status)) {
      return repoAgentStateToResult(this.state);
    }
    if (this.state.status === 'approval_required' && this.approvalMode !== 'interactive') {
      return repoAgentStateToResult(this.state);
    }
    return null;
  }

  private applyState(next: RepoAgentRunState): void {
    this.state = next;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const remaining: BoundaryWaiter[] = [];
    for (const waiter of this.waiters) {
      const result = this.boundaryResultFor(waiter.sinceRevision);
      if (result) {
        this.removeWaiterAbortListener(waiter);
        waiter.resolve(result);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters.splice(0, this.waiters.length, ...remaining);
  }

  private removeWaiter(waiter: BoundaryWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
    this.removeWaiterAbortListener(waiter);
  }

  private removeWaiterAbortListener(waiter: BoundaryWaiter): void {
    if (waiter.abortSignal && waiter.abortListener) {
      waiter.abortSignal.removeEventListener('abort', waiter.abortListener);
    }
  }
}

export class RepoAgentSessionManager {
  private readonly sessions = new Map<string, RepoAgentSession>();
  private readonly store: RepoAgentRunStore;
  private readonly engine: RepoAgentEngine;

  constructor(deps: { store: RepoAgentRunStore; engine: RepoAgentEngine }) {
    this.store = deps.store;
    this.engine = deps.engine;
  }

  start(options: Omit<RepoAgentSessionOptions, 'store' | 'engine'>): RepoAgentSession {
    const session = new RepoAgentSession({
      ...options,
      store: this.store,
      engine: this.engine,
    });
    this.sessions.set(options.runId, session);
    session.start();
    void session.settled.then(
      () => {
        if (!session.hasUnpersistedTerminalState()) {
          this.sessions.delete(options.runId);
        }
      },
      (error) => {
        this.sessions.delete(options.runId);
        serverLogger.error({
          scope: 'rs',
          id: options.requestId,
          event: 'session_rejected',
          fields: toError(error).message,
        });
      },
    );
    return session;
  }

  get(runId: string): RepoAgentSession | undefined {
    return this.sessions.get(runId);
  }
}
