import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { getAbortError } from '../src/lib/abort.js';
import type { ProgressWriter } from '../src/lib/progress-writer.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { OutputCapture } from './helpers/stdout-capture.js';
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
  readonly wantsLiveText: boolean;
  events: RepoSearchProgressEvent[] = [];
  constructor(wantsLiveText = false) {
    this.wantsLiveText = wantsLiveText;
  }
  writeProgress(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

class ScriptedProgressEngine implements RepoAgentEngine {
  /** Resolves with the writer the session hands the engine, so tests await instead of polling. */
  readonly writerReceived: Promise<ProgressWriter<RepoSearchProgressEvent>>;
  private announceWriter: ((writer: ProgressWriter<RepoSearchProgressEvent>) => void) | null = null;

  constructor(private readonly events: readonly RepoSearchProgressEvent[]) {
    this.writerReceived = new Promise((resolve) => {
      this.announceWriter = resolve;
    });
  }

  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const writer = request.progressWriter;
    if (!writer) {
      throw new Error('ScriptedProgressEngine requires a progress writer.');
    }
    const announceWriter = this.announceWriter;
    this.announceWriter = null;
    announceWriter?.(writer);
    for (const event of this.events) {
      writer.write(event);
    }
    return makeEngineResult('done');
  }
}

class TurnThinkingEngine implements RepoAgentEngine {
  readonly result: RepoSearchExecutionResult;

  constructor() {
    const result = makeEngineResult('done');
    const task = result.scorecard.tasks[0];
    if (!task) {
      throw new Error('Expected mock scorecard task.');
    }
    task.turnThinking = { 1: 'inspecting the cipher table' };
    task.commands = [{
      command: 'rg -n "cipher" src',
      activityKind: 'search',
      activitySubject: { kind: 'none' },
      turn: 1,
      safe: true,
      reason: null,
      exitCode: 0,
      output: 'src/cipher.ts:1:const TABLE = "x"',
    }];
    this.result = result;
  }

  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    return this.result;
  }
}

class AbortingEngine implements RepoAgentEngine {
  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const signal = request.abortSignal;
    if (!signal) {
      throw new Error('AbortingEngine requires an abort signal.');
    }
    return new Promise<RepoSearchExecutionResult>((_resolve, reject) => {
      const onAbort = (): void => reject(getAbortError(signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
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

async function waitWithTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 1_000): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs);
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
        wantsLiveText: false,
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

    const boundary = await waitWithTimeout(session.waitForBoundary(0), 'the first session boundary');
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(boundary.error.trim().length > 0);
    }
    await waitWithTimeout(session.settled, 'session settlement');
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

test('session progress writer reports wantsLiveText from the attached subscriber', async (t) => {
  const engine = new ScriptedProgressEngine([]);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();

  const writer = await waitWithTimeout(engine.writerReceived, 'the engine to receive the progress writer');
  assert.equal(writer.wantsLiveText, false, 'no subscriber attached');

  const detach = session.attach({ wantsLiveText: true, writeProgress: () => undefined });
  assert.equal(writer.wantsLiveText, true, 'live-text subscriber attached');

  detach();
  assert.equal(writer.wantsLiveText, false, 'subscriber detached');

  await session.settled;
});

function liveTextEvents() {
  const thinking: RepoSearchProgressEvent = { kind: 'thinking', turn: 1, maxTurns: 4, thinkingText: 'considering the cipher' };
  const narration: RepoSearchProgressEvent = { kind: 'narration', turn: 1, maxTurns: 4, narrationText: 'reading the cipher files' };
  const progressUpdate: RepoSearchProgressEvent = { kind: 'progress_update', turn: 1, maxTurns: 4, taskId: 'repo-search', elapsedMs: 12, progressText: 'halfway there' };
  const toolStart: RepoSearchProgressEvent = {
    kind: 'tool_start',
    toolCallId: 'tool-1',
    turn: 1,
    maxTurns: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg -n "cipher" src',
    promptTokenCount: 100,
    thinkingTokenCount: 5,
    elapsedMs: 12,
  };
  return { toolStart, all: [thinking, narration, progressUpdate, toolStart] };
}

test('live-text events reach only a live-text subscriber: a live-text subscriber receives all four in order', async (t) => {
  const events = liveTextEvents();
  const engine = new ScriptedProgressEngine(events.all);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber(true);
  session.attach(subscriber);

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'completed');
  await session.settled;

  assert.deepEqual(subscriber.events, events.all);
});

test('live-text events reach only a live-text subscriber: a non-live-text subscriber receives only tool_start', async (t) => {
  const events = liveTextEvents();
  const engine = new ScriptedProgressEngine(events.all);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber(false);
  session.attach(subscriber);

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'completed');
  await session.settled;

  assert.deepEqual(subscriber.events, [events.toolStart]);
});

test('answer events are never fanned out: a non-live-text subscriber receives nothing', async (t) => {
  const answer: RepoSearchProgressEvent = { kind: 'answer', turn: 1, maxTurns: 4, answerText: 'the cipher is solved' };
  const engine = new ScriptedProgressEngine([answer]);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber(false);
  session.attach(subscriber);

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'completed');
  await session.settled;

  assert.equal(subscriber.events.length, 0, 'non-live-text subscriber must not receive answer');
});

test('answer events are never fanned out: a live-text subscriber receives nothing', async (t) => {
  const answer: RepoSearchProgressEvent = { kind: 'answer', turn: 1, maxTurns: 4, answerText: 'the cipher is solved' };
  const engine = new ScriptedProgressEngine([answer]);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber(true);
  session.attach(subscriber);

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'completed');
  await session.settled;

  assert.equal(subscriber.events.length, 0, 'live-text subscriber must not receive answer');
});

test('live-text events are not server-logged', async (t) => {
  const progressUpdate: RepoSearchProgressEvent = {
    kind: 'progress_update',
    turn: 1,
    maxTurns: 4,
    taskId: 'repo-search',
    elapsedMs: 12,
    progressText: 'progress-live-text-marker',
  };
  const toolStart: RepoSearchProgressEvent = {
    kind: 'tool_start',
    toolCallId: 'tool-1',
    turn: 1,
    maxTurns: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg -n "tool-start-log-marker" src',
    promptTokenCount: 100,
    thinkingTokenCount: 5,
    elapsedMs: 12,
  };
  const engine = new ScriptedProgressEngine([progressUpdate, toolStart]);
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber(true);
  session.attach(subscriber);

  const previousLogLevel = process.env.SIFTKIT_LOG_LEVEL;
  process.env.SIFTKIT_LOG_LEVEL = 'normal';
  const capture = OutputCapture.start(process.stdout);
  try {
    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'completed');
    await session.settled;
  } finally {
    capture.restore();
    if (previousLogLevel === undefined) {
      delete process.env.SIFTKIT_LOG_LEVEL;
    } else {
      process.env.SIFTKIT_LOG_LEVEL = previousLogLevel;
    }
  }

  assert.ok(
    capture.lines.some((line) => line.includes('tool-start-log-marker')),
    `tool_start must still be server-logged; captured: ${capture.lines.join(' | ')}`,
  );
  assert.ok(
    !capture.lines.some((line) => line.includes('progress-live-text-marker')),
    `progress_update must not be server-logged; captured: ${capture.lines.join(' | ')}`,
  );
});

test('session exposes the engine execution result after a completed run', async (t) => {
  const engine = new TurnThinkingEngine();
  const harness = await SessionTestHarness.create({ engine, approvalMode: 'off' }, t);
  const session = harness.start();

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'completed');

  const exposed = session.getExecutionResult();
  assert.equal(exposed, engine.result, 'the session must expose the exact engine result');
  if (!exposed) {
    throw new Error('Expected the session to expose an execution result.');
  }
  const task = exposed.scorecard.tasks[0];
  if (!task) {
    throw new Error('Expected the exposed scorecard to carry a task.');
  }
  assert.equal(task.turnThinking[1], 'inspecting the cipher table');
  assert.equal(task.commands.length, 1);
  await session.settled;
});

test('session getExecutionResult returns null for an aborted run', async (t) => {
  const harness = await SessionTestHarness.create({ engine: new AbortingEngine(), approvalMode: 'off' }, t);
  const session = harness.start();

  session.abort();

  const boundary = await session.waitForBoundary(0);
  assert.equal(boundary.status, 'aborted');
  assert.equal(session.getExecutionResult(), null);
  await session.settled;
});
