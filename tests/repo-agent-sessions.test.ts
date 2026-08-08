import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { buildMockScorecard } from './_test-helpers.js';
import { parseRepoSearchRequest } from '../src/status-server/route-request-normalizers.js';
import { createRepoSearchAdmissionRecord } from '../src/status-server/repo-search-admissions.js';
import { RepoAgentRunRequestSchema } from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import {
  RepoAgentSessionManager,
  type RepoAgentEngine,
  type RepoAgentEngineRequest,
  type RepoAgentModelLockAdapter,
  type RepoAgentSessionSubscriber,
} from '../src/status-server/repo-agent-sessions.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';

function makeEngineResult(finalOutput: string): RepoSearchExecutionResult {
  return {
    requestId: 'request-session-test',
    transcriptPath: 'db://repo-search/request_test.jsonl',
    artifactPath: 'db://repo-search/request_test.json',
    scorecard: buildMockScorecard(finalOutput),
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

class FailingEngine implements RepoAgentEngine {
  async executeRepoSearch(_request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    throw new Error('engine exploded');
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

class RecordingSubscriber implements RepoAgentSessionSubscriber {
  events: RepoSearchProgressEvent[] = [];
  writeProgress(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

function setupTestEnv(): { tempRoot: string; previousCwd: string } {
  const tempRoot = createManagedTempDir('siftkit-session-test-');
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit', version: '0.1.0' }), 'utf8');
  process.chdir(tempRoot);
  return { tempRoot, previousCwd };
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

// ---- Tests ----

test('Completion: engine returns immediately, boundary resolves completed, lock released', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new CompletingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'off',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'off',
      locks,
      approvalGates,
      engineRequest,
    });

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'completed');
    if (boundary.status === 'completed') {
      assert.ok(boundary.output.includes('done'), `output should contain "done": ${boundary.output}`);
    }
    await session.settled;
    assert.equal(locks.releases, 1);
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'completed');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Park boundary: ParkingEngine parks at approval_required with populated decide commands', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
    });

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'approval_required');
    if (boundary.status === 'approval_required') {
      assert.equal(boundary.approval.toolName, 'run');
      assert.ok(boundary.decide.approve.includes('approve'));
      assert.ok(boundary.decide.deny.includes('deny'));
      assert.ok(boundary.decide.abort.includes('abort'));
    }
    const state = store.readState(runId);
    assert.equal(state.status, 'approval_required');
    if (state.status === 'approval_required') {
      assert.equal(state.pid, process.pid);
    }
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Approve resume: submitDecision approve resumes engine to completion', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
    });

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({ decision: 'approve' });
    assert.equal(accepted, true);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'completed');
    if (finalBoundary.status === 'completed') {
      assert.ok(finalBoundary.output.includes('installed'));
    }
    await session.settled;
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'completed');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Deny resume: submitDecision deny resumes engine with denied output', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
    });

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({ decision: 'deny', reason: 'not now' });
    assert.equal(accepted, true);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'completed');
    if (finalBoundary.status === 'completed') {
      assert.ok(finalBoundary.output.includes('denied: not now'));
    }
    await session.settled;
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Abort: submitDecision abort resolves to aborted boundary, settled resolves cleanly', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
    });

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const accepted = session.submitDecision({ decision: 'abort' });
    assert.equal(accepted, true);

    const finalBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(finalBoundary.status, 'aborted');

    await session.settled;
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'aborted');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Timeout: decisionTimeoutMs expires, boundary resolves approval_timeout, engine abort does not overwrite', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
      decisionTimeoutMs: 25,
    });

    const parkBoundary = await session.waitForBoundary(0);
    assert.equal(parkBoundary.status, 'approval_required');
    const parkRevision = session.currentRevision();

    const timeoutBoundary = await session.waitForBoundary(parkRevision);
    assert.equal(timeoutBoundary.status, 'approval_timeout');

    await session.settled;
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'approval_timeout');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Interactive park is not a boundary: subscriber receives approval_request, waitForBoundary stays pending', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'interactive',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'interactive',
      locks,
      approvalGates,
      engineRequest,
    });

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
    const gate = approvalGates.get(requestId);
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
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Suppression: approvalMode auto, subscriber never sees approval_request', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new ParkingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'auto',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'auto',
      locks,
      approvalGates,
      engineRequest,
    });

    const subscriber = new RecordingSubscriber();
    session.attach(subscriber);

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'approval_required');

    // Subscriber should NOT have received approval_request
    const approvalEvent = subscriber.events.find((e) => e.kind === 'approval_request');
    assert.equal(approvalEvent, undefined, 'subscriber must not receive approval_request in auto mode');

    // Clean up: abort the parked run
    session.submitDecision({ decision: 'abort' });
    await session.settled;
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Engine failure: engine rejects, boundary resolves failed, lock released', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks = new ImmediateLockAdapter();
    const engine = new FailingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'off',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'off',
      locks,
      approvalGates,
      engineRequest,
    });

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(boundary.error.includes('engine exploded'));
    }
    await session.settled;
    assert.equal(locks.releases, 1);
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'failed');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Lock timeout: adapter returns null, boundary resolves failed with queue message', async () => {
  const { tempRoot, previousCwd } = setupTestEnv();
  try {
    const store = makeTestStore(tempRoot);
    const admission = makeAdmission(tempRoot);
    const locks: RepoAgentModelLockAdapter = {
      acquire: async () => null,
      queueLength: () => 0,
    };
    const engine = new CompletingEngine();
    const approvalGates = new Map<string, ApprovalGate>();
    const runId = randomUUID();
    const requestId = randomUUID();
    const engineRequest = makeEngineRequest(tempRoot);

    store.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: 'test task',
      repoRoot: tempRoot,
      approval: 'off',
    }));

    const manager = new RepoAgentSessionManager({ store, engine });
    const session = manager.start({
      runId,
      requestId,
      admission,
      approvalMode: 'off',
      locks,
      approvalGates,
      engineRequest,
    });

    const boundary = await session.waitForBoundary(0);
    assert.equal(boundary.status, 'failed');
    if (boundary.status === 'failed') {
      assert.ok(
        boundary.error.toLowerCase().includes('model request queue'),
        `error should mention model request queue: ${boundary.error}`,
      );
    }
    await session.settled;
    const finalState = store.readState(runId);
    assert.equal(finalState.status, 'failed');
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});