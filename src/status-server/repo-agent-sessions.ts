import { toError } from '../lib/errors.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import { formatRepoTaskOutput } from '../repo-agent/run-output.js';
import {
  isTerminalStatus,
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
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../repo-search/types.js';
import { buildRepoSearchProgressLogBody } from './dashboard-runs.js';
import {
  markRepoSearchAdmissionFailed,
  type RepoSearchAdmissionRecord,
} from './repo-search-admissions.js';
import { serverLogger } from './server-logger.js';

const LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

export type RepoAgentSessionSubscriber = {
  writeProgress(event: RepoSearchProgressEvent): void;
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
    return false;
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
  private state: RepoAgentRunState;
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

  attach(subscriber: RepoAgentSessionSubscriber): () => void {
    this.subscriber = subscriber;
    return () => {
      if (this.subscriber === subscriber) {
        this.subscriber = null;
      }
    };
  }

  /** Resolves the parked approval via the shared gate. False when nothing is parked. */
  submitDecision(input: { decision: 'approve' | 'deny' | 'abort'; reason?: string }): boolean {
    if (!this.gate || this.state.status !== 'approval_required') {
      return false;
    }
    const decision: ApprovalDecision = input.decision === 'approve'
      ? { kind: 'approve' }
      : input.decision === 'deny'
        ? { kind: 'deny', reason: (input.reason ?? '').trim() }
        : { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
    return this.gate.submit(this.state.approval.approvalId, decision);
  }

  waitForBoundary(sinceRevision: number): Promise<RepoAgentRunResult> {
    const immediate = this.boundaryResultFor(sinceRevision);
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve) => {
      this.waiters.push({ sinceRevision, resolve });
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
    if (event.kind === 'tool_start' || event.kind === 'context_warning') {
      const body = buildRepoSearchProgressLogBody(event);
      if (body) {
        serverLogger.emitBody('rs', this.requestId, body);
      }
    }
    if (event.kind === 'thinking' || event.kind === 'answer') {
      return;
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
      if (!isTerminalStatus(this.state.status)) {
        this.applyState(this.store.transition(this.runId, this.state.revision, {
          runId: this.runId,
          revision: this.state.revision + 1,
          updatedAtUtc: new Date().toISOString(),
          status: 'completed',
          pid: process.pid,
          output: formatRepoTaskOutput(result),
        }));
      }
    } catch (error) {
      this.settleFailure(toError(error).message);
    } finally {
      lock?.release();
      if (this.gate) {
        this.approvalGates.delete(this.requestId);
      }
    }
  }

  private settleFailure(message: string): void {
    markRepoSearchAdmissionFailed(this.admission, message);
    if (isTerminalStatus(this.state.status)) {
      return;
    }
    const pid = this.state.status === 'starting' ? undefined : this.state.pid;
    this.applyState(this.store.transition(this.runId, this.state.revision, {
      runId: this.runId,
      revision: this.state.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed',
      ...(pid === undefined ? {} : { pid }),
      error: message,
    }));
  }

  private publishApproval(event: RepoSearchProgressEvent): void {
    const approvalId = event.approvalId;
    const toolName = event.toolName;
    const command = event.command;
    if (!approvalId || !toolName || !command) {
      throw new Error('approval_request progress event is missing approvalId, toolName, or command.');
    }
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
    const remaining: BoundaryWaiter[] = [];
    for (const waiter of this.waiters) {
      const result = this.boundaryResultFor(waiter.sinceRevision);
      if (result) {
        waiter.resolve(result);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters.splice(0, this.waiters.length, ...remaining);
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
    void session.settled.finally(() => {
      this.sessions.delete(options.runId);
    });
    return session;
  }

  get(runId: string): RepoAgentSession | undefined {
    return this.sessions.get(runId);
  }
}