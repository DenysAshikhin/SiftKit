import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { buildMockScorecard } from './_test-helpers.js';
import { parseRepoSearchRequest } from '../src/status-server/route-request-normalizers.js';
import { createRepoSearchAdmissionRecord } from '../src/status-server/repo-search-admissions.js';
import {
  RepoAgentRunRequestSchema,
  type RepoAgentRunState,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentDecideRequestSchema } from '../src/repo-agent/api-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import {
  RepoAgentSessionManager,
  type RepoAgentEngine,
  type RepoAgentEngineRequest,
  type RepoAgentModelLockAdapter,
  type RepoAgentSession,
  type RepoAgentSessionSubscriber,
} from '../src/status-server/repo-agent-sessions.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { ApprovalGate, ApprovalMode } from '../src/repo-search/engine/approval-gate.js';

function makeEngineResult(finalOutput: string): RepoSearchExecutionResult {
  const scorecard = buildMockScorecard(finalOutput);
  const task = scorecard.tasks[0];
  if (!task) {
    throw new Error('Expected mock scorecard task.');
  }
  task.reason = 'finish';
  return {
    requestId: 'request-session-test',
    transcriptPath: 'db://repo-search/request_test.jsonl',
    artifactPath: 'db://repo-search/request_test.json',
    scorecard,
  };
}

class ImmediateLockAdapter implements RepoAgentModelLockAdapter {
  releases = 0;
  acquire(): Promise<{ release(): void } | null> {
    return Promise.resolve({ release: () => { this.releases += 1; } });
  }
  queueLength(): number { return 0; }
}

class CompletingEngine implements RepoAgentEngine {
  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    return makeEngineResult('done');
  }
}

class NonFinishEngine implements RepoAgentEngine {
  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const result = makeEngineResult('best-effort terminal synthesis');
    const task = result.scorecard.tasks[0];
    if (!task) {
      throw new Error('Expected mock scorecard task.');
    }
    task.reason = 'invalid_response_limit';
    result.scorecard.verdict = 'fail';
    return result;
  }
}

class FailingEngine implements RepoAgentEngine {
  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    throw new Error('engine exploded');
  }
}

class EmptyErrorEngine implements RepoAgentEngine {
  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    throw new Error('');
  }
}

class ParkingEngine implements RepoAgentEngine {
  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const gate = request.approvalGate;
    if (!gate) {
      throw new Error('ParkingEngine requires an approval gate.');
    }
    const decision = await gate.request({
      turn: 1, toolName: 'run', command: 'npm install left-pad', reviewPayload: null,
    });
    if (decision.kind === 'abort') {
      throw new Error(decision.reason);
    }
    if (decision.kind === 'deny') {
      return makeEngineResult(`denied: ${decision.reason}`);
    }
    return makeEngineResult('installed');
  }
}

class FailingFailureStore extends RepoAgentRunStore {
  override clearPendingApproval(
    _runId: string,
    _expectedRevision: number,
    _status: RepoAgentRunState['status'],
  ): RepoAgentRunState {
    throw new Error('durable decision transition failed');
  }

  override transition(
    runId: string,
    expectedRevision: number,
    next: RepoAgentRunState,
  ): RepoAgentRunState {
    if (next.status === 'failed') {
      throw new Error('durable failure transition failed');
    }
    return super.transition(runId, expectedRevision, next);
  }
}

class RecordingSubscriber implements RepoAgentSessionSubscriber {
  events: RepoSearchProgressEvent[] = [];
  writeProgress(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

function makeTestStore(tempRoot: string): RepoAgentRunStore {
  const runsRoot = path.join(tempRoot, '.siftkit', 'repo-agent', 'runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  return new RepoAgentRunStore(runsRoot);
}

function makeAdmission(tempRoot: string) {
  const routeRequest = parseRepoSearchRequest({
    prompt: 'test task',
    repoRoot: tempRoot,
    model: 'mock-model',
    maxTurns: '4',
  });
  if (!routeRequest) {
    throw new Error('parseRepoSearchRequest returned null');
  }
  return createRepoSearchAdmissionRecord(routeRequest, mockOfflineSiftConfig());
}

function makeEngineRequest(tempRoot: string): RepoAgentEngineRequest {
  return {
    presetId: 'repo-search',
    prompt: 'test task',
    repoRoot: tempRoot,
    taskKind: 'repo-agent',
    model: 'mock-model',
    maxTurns: 4,
  };
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timed out waiting for session settlement')), timeoutMs);
    timeoutHandle.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type SessionTestHarnessOptions = {
  engine: RepoAgentEngine;
  approvalMode: ApprovalMode;
  locks?: RepoAgentModelLockAdapter;
  decisionTimeoutMs?: number;
};

let cwdLeaseTail: Promise<void> = Promise.resolve();
let activeHarnessCount = 0;
let cwdLeaseOwnerCount = 0;
const originalCwd = process.cwd();

function errorFromThrown<T>(error: T): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwCleanupErrors(errors: readonly Error[], context: string): void {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new AggregateError(errors, context);
}

after(() => {
  assert.equal(activeHarnessCount, 0, 'all session harnesses must be finalized');
  assert.equal(cwdLeaseOwnerCount, 0, 'the CWD lease must have no owner');
  assert.equal(process.cwd(), originalCwd, 'the original CWD must be restored');
});

function isCleanupReadyStatus(status: RepoAgentRunState['status']): boolean {
  return status === 'approval_required'
    || status === 'completed'
    || status === 'failed'
    || status === 'aborted'
    || status === 'approval_timeout';
}

async function acquireCwdLease(): Promise<() => void> {
  const previousLease = cwdLeaseTail;
  let release: (() => void) | undefined;
  cwdLeaseTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousLease;
  if (!release) {
    throw new Error('CWD lease release was not initialized.');
  }
  const releaseLease = release;
  cwdLeaseOwnerCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    cwdLeaseOwnerCount -= 1;
    releaseLease();
  };
}

class SessionTestHarness {
  readonly tempRoot: string;
  readonly runId: string;
  readonly requestId: string;
  readonly approvalMode: ApprovalMode;
  readonly engine: RepoAgentEngine;
  readonly locks: RepoAgentModelLockAdapter;
  readonly approvalGates = new Map<string, ApprovalGate>();
  readonly admission: ReturnType<typeof makeAdmission>;
  readonly engineRequest: RepoAgentEngineRequest;

  private readonly previousCwd: string;
  private readonly releaseCwd: () => void;
  private currentStore: RepoAgentRunStore;
  private readonly decisionTimeoutMs: number | undefined;
  private managerValue: RepoAgentSessionManager | undefined;
  private sessionValue: RepoAgentSession | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private cleanupCompleted = false;
  private cleanupObserverAttached = false;
  private cleanupWaiterCancelled = false;

  private constructor(options: {
    tempRoot: string;
    previousCwd: string;
    releaseCwd: () => void;
    engine: RepoAgentEngine;
    approvalMode: ApprovalMode;
    locks: RepoAgentModelLockAdapter;
    decisionTimeoutMs?: number;
  }) {
    this.tempRoot = options.tempRoot;
    this.previousCwd = options.previousCwd;
    this.releaseCwd = options.releaseCwd;
    this.engine = options.engine;
    this.approvalMode = options.approvalMode;
    this.locks = options.locks;
    this.decisionTimeoutMs = options.decisionTimeoutMs;
    this.currentStore = makeTestStore(this.tempRoot);
    this.runId = randomUUID();
    this.requestId = randomUUID();
    this.admission = makeAdmission(this.tempRoot);
    this.engineRequest = makeEngineRequest(this.tempRoot);
  }

  static async create(
    options: SessionTestHarnessOptions,
    context: TestContext,
  ): Promise<SessionTestHarness> {
    const releaseCwd = await acquireCwdLease();
    let previousCwd: string | undefined;
    let tempRoot: string | undefined;
    let harness: SessionTestHarness | undefined;
    try {
      const capturedPreviousCwd = process.cwd();
      previousCwd = capturedPreviousCwd;
      tempRoot = createManagedTempDir('siftkit-session-test-');
      fs.writeFileSync(
        path.join(tempRoot, 'package.json'),
        JSON.stringify({ name: 'siftkit', version: '0.1.0' }),
        'utf8',
      );
      process.chdir(tempRoot);
      harness = new SessionTestHarness({
        tempRoot,
        previousCwd: capturedPreviousCwd,
        releaseCwd,
        engine: options.engine,
        approvalMode: options.approvalMode,
        locks: options.locks ?? new ImmediateLockAdapter(),
        ...(options.decisionTimeoutMs === undefined
          ? {}
          : { decisionTimeoutMs: options.decisionTimeoutMs }),
      });
    } catch (error) {
      const cleanupErrors: Error[] = [];
      try {
        closeRuntimeDatabase();
      } catch (cleanupError) {
        cleanupErrors.push(errorFromThrown(cleanupError));
      }
      if (previousCwd !== undefined) {
        try {
          process.chdir(previousCwd);
        } catch (cleanupError) {
          cleanupErrors.push(errorFromThrown(cleanupError));
        }
      }
      try {
        if (tempRoot) {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        cleanupErrors.push(errorFromThrown(cleanupError));
      }
      try {
        releaseCwd();
      } catch (cleanupError) {
        cleanupErrors.push(errorFromThrown(cleanupError));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [errorFromThrown(error), ...cleanupErrors],
          'Session harness creation and rollback failed.',
        );
      }
      throw error;
    }
    if (!harness) {
      throw new Error('Session harness creation did not produce a harness.');
    }
    const createdHarness = harness;
    activeHarnessCount += 1;
    try {
      context.after(() => createdHarness.cleanup());
    } catch (error) {
      const cleanupErrors: Error[] = [];
      try {
        await createdHarness.cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(errorFromThrown(cleanupError));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [errorFromThrown(error), ...cleanupErrors],
          'Session harness teardown registration failed.',
        );
      }
      throw error;
    }
    return createdHarness;
  }

  get store(): RepoAgentRunStore {
    return this.currentStore;
  }

  get manager(): RepoAgentSessionManager {
    if (!this.managerValue) {
      this.managerValue = new RepoAgentSessionManager({
        store: this.currentStore,
        engine: this.engine,
      });
    }
    return this.managerValue;
  }

  get lockReleaseCount(): number {
    return this.locks instanceof ImmediateLockAdapter ? this.locks.releases : 0;
  }

  get cleanupObserverWasDetached(): boolean {
    return !this.cleanupObserverAttached;
  }

  get cleanupWaiterWasCancelled(): boolean {
    return this.cleanupWaiterCancelled;
  }

  replaceStore(store: RepoAgentRunStore): void {
    if (this.managerValue || this.sessionValue) {
      throw new Error('The session test store must be replaced before starting the session.');
    }
    this.currentStore = store;
  }

  start(): RepoAgentSession {
    if (this.sessionValue) {
      throw new Error('The session test harness can start only one session.');
    }
    this.store.create(RepoAgentRunRequestSchema.parse({
      runId: this.runId,
      task: 'test task',
      repoRoot: this.tempRoot,
      approval: this.approvalMode,
    }));
    const session = this.manager.start({
      runId: this.runId,
      requestId: this.requestId,
      admission: this.admission,
      approvalMode: this.approvalMode,
      locks: this.locks,
      approvalGates: this.approvalGates,
      engineRequest: this.engineRequest,
      ...(this.decisionTimeoutMs === undefined
        ? {}
        : { decisionTimeoutMs: this.decisionTimeoutMs }),
    });
    this.sessionValue = session;
    return session;
  }

  async cleanup(): Promise<void> {
    if (this.cleanupCompleted && this.cleanupPromise) {
      return this.cleanupPromise;
    }
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.finalizeCleanup();
    }
    return this.cleanupPromise;
  }

  private async finalizeCleanup(): Promise<void> {
    const errors: Error[] = [];
    try {
      const session = this.sessionValue;
      if (session) {
        try {
          await this.waitForCleanupSignals(session);
        } catch (error) {
          errors.push(errorFromThrown(error));
        }
        try {
          if (session.getState().status === 'approval_required') {
            session.submitDecision({ runId: this.runId, decision: 'abort' });
          }
        } catch (error) {
          errors.push(errorFromThrown(error));
        }
        try {
          await session.settled;
        } catch (error) {
          errors.push(errorFromThrown(error));
        }
      }
    } finally {
      try {
        closeRuntimeDatabase();
      } catch (error) {
        errors.push(errorFromThrown(error));
      }
      try {
        process.chdir(this.previousCwd);
      } catch (error) {
        errors.push(errorFromThrown(error));
      }
      try {
        fs.rmSync(this.tempRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(errorFromThrown(error));
      }
      try {
        this.releaseCwd();
      } catch (error) {
        errors.push(errorFromThrown(error));
      }
      try {
        activeHarnessCount -= 1;
      } catch (error) {
        errors.push(errorFromThrown(error));
      }
      this.cleanupCompleted = true;
    }
    throwCleanupErrors(errors, 'Session harness cleanup failed.');
  }

  private async waitForCleanupSignals(session: RepoAgentSession): Promise<void> {
    if (isCleanupReadyStatus(session.getState().status)) {
      return;
    }
    const abortController = new AbortController();
    const boundaryObservation = session.waitForBoundary(
      session.currentRevision(),
      abortController.signal,
    ).then(
      () => undefined,
      () => undefined,
    );
    const settledObservation = session.settled.then(
      () => undefined,
      () => undefined,
    );
    let resolveApprovalRequest: () => void = () => undefined;
    const approvalObservation = new Promise<void>((resolve) => {
      resolveApprovalRequest = resolve;
    });
    let detach: (() => void) | undefined;
    try {
      detach = session.attach({
        writeProgress: (event: RepoSearchProgressEvent): void => {
          if (event.kind === 'approval_request') {
            resolveApprovalRequest();
          }
        },
      });
      this.cleanupObserverAttached = true;
      if (!isCleanupReadyStatus(session.getState().status)) {
        await Promise.race([
          boundaryObservation,
          approvalObservation,
          settledObservation,
        ]);
      }
    } finally {
      if (detach) {
        detach();
        this.cleanupObserverAttached = false;
      }
      abortController.abort();
      this.cleanupWaiterCancelled = true;
    }
  }
}

// ---- Tests ----

test('Decision contracts require a deny reason and preserve it after parsing', () => {
  assert.equal(
    RepoAgentDecideRequestSchema.safeParse({
      runId: randomUUID(),
      decision: 'deny',
    }).success,
    false,
  );
  const parsed = RepoAgentDecideRequestSchema.parse({
    runId: randomUUID(),
    decision: 'deny',
    reason: 'not now',
  });
  assert.equal(parsed.decision, 'deny');
  if (parsed.decision === 'deny') {
    assert.equal(parsed.reason, 'not now');
  }
});

test('Session decisions require the owning run ID', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();
    const parked = await session.waitForBoundary(0);
    assert.equal(parked.status, 'approval_required');

    const wrongRunDecision = RepoAgentDecideRequestSchema.parse({
      runId: randomUUID(),
      decision: 'deny',
      reason: 'wrong run',
    });
    assert.throws(
      () => session.submitDecision(wrongRunDecision),
      /run ID/u,
    );
});

test('Completion: engine returns immediately, boundary resolves completed, lock released', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new CompletingEngine(),
    approvalMode: 'off',
  }, t);
  const session = harness.start();

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'completed');
    if (boundary.status === 'completed') {
      assert.ok(boundary.output.includes('done'), `output should contain "done": ${boundary.output}`);
    }
    await session.settled;
    assert.equal(harness.lockReleaseCount, 1);
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'completed');
});

test('Non-finish engine result resolves failed and preserves terminal synthesis', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new NonFinishEngine(),
    approvalMode: 'off',
  }, t);
  const session = harness.start();

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'failed');
  if (boundary.status === 'failed') {
    assert.match(boundary.error, /invalid_response_limit/u);
    assert.equal(boundary.output, 'best-effort terminal synthesis');
  }
  await session.settled;
  const state = harness.store.readState(harness.runId);
  assert.equal(state.status, 'failed');
  if (state.status === 'failed') {
    assert.equal(state.output, 'best-effort terminal synthesis');
  }
});

test('Park boundary: ParkingEngine parks at approval_required with populated decide commands', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

    const boundary = await session.waitForBoundary(0);

    assert.equal(boundary.status, 'approval_required');
    if (boundary.status === 'approval_required') {
      assert.equal(boundary.approval.toolName, 'run');
      assert.ok(boundary.decide.approve.includes('approve'));
      assert.ok(boundary.decide.deny.includes('deny'));
      assert.ok(boundary.decide.abort.includes('abort'));
    }
    const state = harness.store.readState(harness.runId);
    assert.equal(state.status, 'approval_required');
    if (state.status === 'approval_required') {
      assert.equal(state.pid, process.pid);
    }
});

test('Harness cleanup waits for an auto approval park and is idempotent', async (t) => {
  const timeoutCountBefore = process.getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

  await harness.cleanup();
  assert.equal(session.getState().status, 'aborted');
  assert.equal(harness.cleanupObserverWasDetached, true);
  assert.equal(harness.cleanupWaiterWasCancelled, true);
  assert.equal(harness.approvalGates.size, 0);
  assert.equal(
    process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length,
    timeoutCountBefore,
  );

  await harness.cleanup();
});

test('Harness cleanup observes interactive approval before aborting', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'interactive',
  }, t);
  const session = harness.start();

  await harness.cleanup();
  assert.equal(session.getState().status, 'aborted');
  assert.equal(harness.cleanupObserverWasDetached, true);
  assert.equal(harness.cleanupWaiterWasCancelled, true);
  assert.equal(harness.approvalGates.size, 0);
});

test('Approve resume: submitDecision approve resumes engine to completion', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({ runId: harness.runId, decision: 'approve' });
    assert.equal(accepted, true);
    assert.equal(session.submitDecision({ runId: harness.runId, decision: 'approve' }), false);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'completed');
    if (finalBoundary.status === 'completed') {
      assert.ok(finalBoundary.output.includes('installed'));
    }
    await session.settled;
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'completed');
});

test('Deny resume: submitDecision deny resumes engine with denied output', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({
      runId: harness.runId,
      decision: 'deny',
      reason: 'not now',
    });
    assert.equal(accepted, true);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'completed');
    if (finalBoundary.status === 'completed') {
      assert.ok(finalBoundary.output.includes('denied: not now'));
    }
    await session.settled;
});

test('Abort: submitDecision abort resolves to aborted boundary, settled resolves cleanly', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({ runId: harness.runId, decision: 'abort' });
    assert.equal(accepted, true);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'aborted');

    await session.settled;
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'aborted');
});

test('Timeout: decisionTimeoutMs expires, boundary resolves approval_timeout, engine abort does not overwrite', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
    decisionTimeoutMs: 25,
  }, t);
  const session = harness.start();

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const timeoutBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(timeoutBoundary.status, 'approval_timeout');

    await session.settled;
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'approval_timeout');
});

test('Interactive park is not a boundary: subscriber receives approval_request, waitForBoundary stays pending', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'interactive',
  }, t);
  const session = harness.start();

    const subscriber = new RecordingSubscriber();
    session.attach(subscriber);

    // Wait for the approval_request event to arrive at the subscriber
    const parkBoundary = session.waitForBoundary(0);
    // Race with a timeout: boundary should NOT resolve quickly for interactive mode
    const boundaryDidNotResolve = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 50);
      parkBoundary.then(() => resolve(false));
    });
    assert.equal(boundaryDidNotResolve, true, 'waitForBoundary should not resolve for interactive park');

    // Subscriber should have received the approval_request event
    const approvalEvent = subscriber.events.find((e) => e.kind === 'approval_request');
    assert.ok(approvalEvent, 'subscriber should receive approval_request event');

    // Submit approve via the gate in the approvalGates map
    const gate = harness.approvalGates.get(harness.requestId);
    assert.ok(gate, 'gate should be registered in approvalGates map');
    if (gate && approvalEvent) {
      const approvalId = approvalEvent.approvalId;
      assert.ok(approvalId);
      gate.submit(approvalId, { kind: 'approve' });
    }

    const finalBoundary = await parkBoundary;
    assert.equal(finalBoundary.status, 'completed');
    if (finalBoundary.status === 'completed') {
      assert.ok(finalBoundary.output.includes('installed'));
    }
    await session.settled;
});

test('Suppression: approvalMode auto, subscriber never sees approval_request', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();

    const subscriber = new RecordingSubscriber();
    session.attach(subscriber);

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'approval_required');

    // Subscriber should NOT have received approval_request
    const approvalEvent = subscriber.events.find((e) => e.kind === 'approval_request');
    assert.equal(approvalEvent, undefined, 'subscriber must not receive approval_request in auto mode');

    // Clean up: abort the parked run
    session.submitDecision({ runId: harness.runId, decision: 'abort' });
    await session.settled;
});

test('Engine failure: engine rejects, boundary resolves failed, lock released', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new FailingEngine(),
    approvalMode: 'off',
  }, t);
  const session = harness.start();

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(boundary.error.includes('engine exploded'));
    }
    await session.settled;
    assert.equal(harness.lockReleaseCount, 1);
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'failed');
});

test('Empty engine failure still publishes a non-empty authoritative failed state', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new EmptyErrorEngine(),
    approvalMode: 'off',
  }, t);
  const session = harness.start();

    const boundary = await waitWithTimeout(session.waitForBoundary(0));
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(boundary.error.trim().length > 0);
    }
    await waitWithTimeout(session.settled);
    const state = harness.store.readState(harness.runId);
    assert.equal(state.status, 'failed');
    if (state.status === 'failed') {
      assert.ok(state.error.trim().length > 0);
    }
    assert.equal(session.hasUnpersistedTerminalState(), false);
});

test('Admission persistence failure does not block the durable engine failure transition', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new FailingEngine(),
    approvalMode: 'off',
  }, t);
  const runtimeDatabasePath = path.join(harness.tempRoot, '.siftkit', 'runtime.sqlite');
    fs.mkdirSync(runtimeDatabasePath, { recursive: true });
    const session = harness.start();

    const failed = await session.waitForBoundary(0);
    assert.equal(failed.status, 'failed');
    if (failed.status === 'failed') {
      assert.match(failed.error, /engine exploded/u);
    }
    await session.settled;
    const state = harness.store.readState(harness.runId);
    assert.equal(state.status, 'failed');
    if (state.status === 'failed') {
      assert.match(state.error, /engine exploded/u);
    }
});

test('Lock timeout: adapter returns null, boundary resolves failed with queue message', async (t) => {
  const locks: RepoAgentModelLockAdapter = {
    acquire: async () => null,
    queueLength: () => 0,
  };
  const harness = await SessionTestHarness.create({
    engine: new CompletingEngine(),
    approvalMode: 'off',
    locks,
  }, t);
  const session = harness.start();

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(
        boundary.error.toLowerCase().includes('model request queue'),
        `error should mention model request queue: ${boundary.error}`,
      );
    }
    await session.settled;
    const finalState = harness.store.readState(harness.runId);
    assert.equal(finalState.status, 'failed');
});

test('Boundary cancellation removes only the disconnected waiter and leaves the session resumable', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const session = harness.start();
    const parked = await session.waitForBoundary(0);
    assert.equal(parked.status, 'approval_required');
    const controller = new AbortController();
    const disconnected = session.waitForBoundary(session.currentRevision(), controller.signal);

    controller.abort(new Error('client disconnected'));

    await assert.rejects(disconnected, /client disconnected/u);
    assert.equal(session.submitDecision({ runId: harness.runId, decision: 'approve' }), true);
    assert.equal((await session.waitForBoundary(session.currentRevision())).status, 'completed');
    await session.settled;
});

test('Persistence failure while deciding retains the authoritative failed session state', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(),
    approvalMode: 'auto',
  }, t);
  const runsRoot = path.join(harness.tempRoot, '.siftkit', 'repo-agent', 'runs');
    fs.mkdirSync(runsRoot, { recursive: true });
    harness.replaceStore(new FailingFailureStore(runsRoot));
    const session = harness.start();
    const parked = await session.waitForBoundary(0);
    assert.equal(parked.status, 'approval_required');
    const finalBoundary = session.waitForBoundary(session.currentRevision());

    assert.equal(session.submitDecision({ runId: harness.runId, decision: 'approve' }), true);

    const failed = await finalBoundary;
    assert.equal(failed.status, 'failed');
    if (failed.status === 'failed') {
      assert.match(failed.error, /Approval observer failed/u);
    }
    assert.equal(session.getState().status, 'failed');
    assert.equal(session.hasUnpersistedTerminalState(), true);
    assert.equal(harness.manager.get(harness.runId), session);
    await session.settled;
});
