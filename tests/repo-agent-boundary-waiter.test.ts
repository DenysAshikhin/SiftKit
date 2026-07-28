import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  RepoAgentApprovalSchema,
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  RepoAgentWorkerRequestSchema,
  type RepoAgentApproval,
  type RepoAgentRunState,
  type RepoAgentWorkerRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { RepoAgentBoundaryWaiter } from '../src/repo-agent/boundary-waiter.js';
import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../src/lib/process-inspector.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-boundary-waiter-tests-${process.pid}`,
);

before(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeRunsRoot(): string {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  return runsRoot;
}

function makeRequest(runId = randomUUID()): RepoAgentWorkerRequest {
  return RepoAgentWorkerRequestSchema.parse({
    runId,
    task: 'implement the task',
    repoRoot: process.cwd(),
    approval: 'auto',
    progress: false,
  });
}

function makeApproval(): RepoAgentApproval {
  return RepoAgentApprovalSchema.parse({
    approvalId: randomUUID(),
    toolName: 'edit',
    command: 'edit path="src/example.ts" edits=1',
    reviewPayload: null,
  });
}

function moveToRunning(store: RepoAgentRunStore, request: RepoAgentWorkerRequest): void {
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });
}

// ---- Waits past starting and running ----

test('waits past starting state', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(0);

  // Transition to running
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });

  // Should still wait (running is not a boundary)
  // Now transition to completed
  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'done',
  });

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, request.runId);
  assert.equal(result.output, 'done');
});

test('waits past running state', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  // Transition to completed
  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'finished',
  });

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'finished');
});

// ---- Returns boundary states ----

test('returns approval_required boundary', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);

  const result = await pending;
  assert.equal(result.status, 'approval_required');
  assert.equal(result.runId, request.runId);
  assert.equal(result.approval.approvalId, approval.approvalId);
});

test('returns completed boundary', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'all done',
  });

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'all done');
});

test('returns failed boundary', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'failed',
    pid: process.pid,
    error: 'something broke',
  });

  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'something broke');
});

test('returns aborted boundary', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'aborted',
    pid: process.pid,
  });

  const result = await pending;
  assert.equal(result.status, 'aborted');
});

// ---- Public result schema ----

test('returns objects that parse as RepoAgentRunResultSchema', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  const pending = waiter.waitForBoundary(1);

  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'result',
  });

  const result = await pending;
  // Must parse through the public schema
  const parsed = RepoAgentRunResultSchema.parse(result);
  assert.equal(parsed.status, 'completed');
});

// ---- Dead worker detection ----

test('marks active state failed when worker PID is dead', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);

  // Use a fake PID that doesn't exist
  const fakePid = 99999999;
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: fakePid,
  });

  const inspector = new NodeProcessInspector();
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
    processInspector: inspector,
  });

  const pending = waiter.waitForBoundary(1);

  // The waiter should detect the dead PID and mark the state as failed
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('died') || result.error.includes('worker'), result.error);

  // Verify the store state was updated to failed
  const state = store.readState(request.runId);
  assert.equal(state.status, 'failed');
});

test('marks a settled approval wait failed when its worker PID is dead', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: 99_999_999,
  });
  const approvalState = store.publishApproval(
    request.runId,
    1,
    makeApproval(),
  );
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
    processInspector: new NodeProcessInspector(),
  });

  const result = await waiter.waitForBoundary(approvalState.revision);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /died unexpectedly/iu);
});

test('returns the winning failed boundary when dead-worker transition races', async () => {
  class RacingRunStore extends RepoAgentRunStore {
    private raced = false;

    override transition(
      runId: string,
      expectedRevision: number,
      next: RepoAgentRunState,
    ): RepoAgentRunState {
      if (!this.raced && next.status === 'failed') {
        this.raced = true;
        super.transition(runId, expectedRevision, next);
        throw new Error('Stale revision: another waiter won.');
      }
      return super.transition(runId, expectedRevision, next);
    }
  }

  const runsRoot = makeRunsRoot();
  const store = new RacingRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: 99_999_999,
  });
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
    processInspector: new NodeProcessInspector(),
  });
  const result = await waiter.waitForBoundary(1);
  assert.equal(result.status, 'failed');
});

test('waits for an active worker without a wall-clock deadline', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const running = store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });
  setTimeout(() => {
    store.transition(request.runId, running.revision, {
      runId: request.runId,
      revision: running.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'completed',
      pid: process.pid,
      output: 'completed after the former deadline',
    });
  }, 40);

  const result = await waiter.waitForBoundary(running.revision);
  assert.equal(result.status, 'completed');
});

test('rejects invalid polling configuration and revisions', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  assert.throws(
    () => new RepoAgentBoundaryWaiter({
      store,
      runId: request.runId,
      pollIntervalMs: -1,
    }),
    /poll/iu,
  );
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 1,
  });
  await assert.rejects(() => waiter.waitForBoundary(-1), /revision/iu);
});

// ---- Bounded polling ----

test('polling is bounded and does not busy-spin', async () => {
  class CountingRunStore extends RepoAgentRunStore {
    readCount = 0;

    override readState(runId: string): RepoAgentRunState {
      this.readCount += 1;
      return super.readState(runId);
    }
  }

  const runsRoot = makeRunsRoot();
  const store = new CountingRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 10,
  });
  setTimeout(() => {
    store.transition(request.runId, 0, {
      runId: request.runId,
      revision: 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'completed',
      pid: process.pid,
      output: 'done',
    });
  }, 60);
  await waiter.waitForBoundary(0);

  assert.ok(
    store.readCount < 50,
    `Expected bounded polling but got ${store.readCount} polls`,
  );
  assert.ok(
    store.readCount >= 5,
    `Expected some polling but got ${store.readCount} polls`,
  );
});

// ---- Strictly newer boundary revisions ----

test('requires strictly newer boundary revision', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId: request.runId,
    pollIntervalMs: 5,
  });

  // Start waiting from revision 1
  const pending = waiter.waitForBoundary(1);

  // Publish approval at revision 2
  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);

  const result = await pending;
  assert.equal(result.status, 'approval_required');

  // Now wait again from revision 2 - should get a NEWER boundary
  const pending2 = waiter.waitForBoundary(2);

  // Complete the run
  store.transition(request.runId, 2, {
    runId: request.runId,
    revision: 3,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'final',
  });

  const result2 = await pending2;
  assert.equal(result2.status, 'completed');
});

// ---- ProcessInspector interface ----

test('ProcessInspector interface is explicit', () => {
  const inspector: ProcessInspector = new NodeProcessInspector();
  assert.ok(typeof inspector.isAlive === 'function');
});

test('NodeProcessInspector reports current process as alive', () => {
  const inspector = new NodeProcessInspector();
  assert.equal(inspector.isAlive(process.pid), true);
});

test('NodeProcessInspector reports non-existent PID as dead', () => {
  const inspector = new NodeProcessInspector();
  assert.equal(inspector.isAlive(99999999), false);
});

// ---- Constructor ----

test('constructor accepts store, runId, and pollIntervalMs', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const runId = randomUUID();
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId,
    pollIntervalMs: 10,
  });
  assert.ok(waiter instanceof RepoAgentBoundaryWaiter);
});

test('constructor accepts optional processInspector', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const runId = randomUUID();
  const inspector = new NodeProcessInspector();
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId,
    pollIntervalMs: 10,
    processInspector: inspector,
  });
  assert.ok(waiter instanceof RepoAgentBoundaryWaiter);
});
