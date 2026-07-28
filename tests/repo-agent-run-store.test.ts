import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  RepoAgentApprovalSchema,
  RepoAgentDecisionSchema,
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  RepoAgentWorkerRequestSchema,
  type RepoAgentApproval,
  type RepoAgentDecision,
  type RepoAgentWorkerRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-run-store-tests-${process.pid}`,
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
    reviewPayload: '{"action":"edit"}',
  });
}

function moveToRunning(
  store: RepoAgentRunStore,
  request: RepoAgentWorkerRequest,
): void {
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });
}

function publishBoundary(
  store: RepoAgentRunStore,
  request: RepoAgentWorkerRequest,
): RepoAgentApproval {
  moveToRunning(store, request);
  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);
  return approval;
}

function makeDecision(
  request: RepoAgentWorkerRequest,
  approval: RepoAgentApproval,
  decision: 'approve' | 'abort' = 'approve',
): RepoAgentDecision {
  return RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision,
  });
}

test('state schema accepts all six states with durable fields', () => {
  const runId = randomUUID();
  const updatedAtUtc = new Date().toISOString();
  const approval = makeApproval();
  const states = [
    { runId, revision: 0, updatedAtUtc, status: 'starting' },
    { runId, revision: 1, updatedAtUtc, status: 'running', pid: 123 },
    {
      runId,
      revision: 2,
      updatedAtUtc,
      status: 'approval_required',
      pid: 123,
      approval,
    },
    {
      runId,
      revision: 3,
      updatedAtUtc,
      status: 'completed',
      pid: 123,
      output: 'done',
    },
    { runId, revision: 3, updatedAtUtc, status: 'failed', pid: 123, error: 'failed' },
    { runId, revision: 3, updatedAtUtc, status: 'failed', error: 'launch failed' },
    { runId, revision: 3, updatedAtUtc, status: 'aborted', pid: 123 },
  ];
  for (const state of states) {
    assert.equal(RepoAgentRunStateSchema.safeParse(state).success, true);
  }
});

test('state schema rejects malformed shared and status-specific fields', () => {
  const base = {
    runId: randomUUID(),
    revision: 0,
    updatedAtUtc: new Date().toISOString(),
  };
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, status: 'invalid' }).success, false);
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, runId: '../escape', status: 'starting' }).success, false);
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, revision: -1, status: 'starting' }).success, false);
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, updatedAtUtc: 'today', status: 'starting' }).success, false);
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, status: 'running' }).success, false);
  assert.equal(
    RepoAgentRunStateSchema.safeParse({
      ...base,
      status: 'approval_required',
      pid: 123,
      approval: makeApproval(),
    }).success,
    true,
  );
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, status: 'completed', pid: 123 }).success, false);
});

test('worker request schema validates every option and rejects invalid input', () => {
  assert.equal(
    RepoAgentWorkerRequestSchema.safeParse({
      ...makeRequest(),
      model: 'model',
      logFile: 'run.log',
      approval: 'interactive',
      progress: true,
    }).success,
    true,
  );
  assert.equal(RepoAgentWorkerRequestSchema.safeParse({ ...makeRequest(), task: '' }).success, false);
  assert.equal(RepoAgentWorkerRequestSchema.safeParse({ ...makeRequest(), runId: 'bad' }).success, false);
  assert.equal(RepoAgentWorkerRequestSchema.safeParse({ ...makeRequest(), approval: 'unsafe' }).success, false);
});

test('approval schema requires complete visible review content', () => {
  assert.equal(RepoAgentApprovalSchema.safeParse(makeApproval()).success, true);
  assert.equal(
    RepoAgentApprovalSchema.safeParse({ ...makeApproval(), reviewPayload: null }).success,
    true,
  );
  assert.equal(
    RepoAgentApprovalSchema.safeParse({ ...makeApproval(), toolName: '' }).success,
    false,
  );
});

test('decision schema requires a reason only for deny', () => {
  const base = {
    runId: randomUUID(),
    approvalId: randomUUID(),
    observedRevision: 2,
  };
  assert.equal(
    RepoAgentDecisionSchema.safeParse({ ...base, decision: 'approve' }).success,
    true,
  );
  assert.equal(
    RepoAgentDecisionSchema.safeParse({ ...base, decision: 'deny' }).success,
    false,
  );
  assert.equal(
    RepoAgentDecisionSchema.safeParse({
      ...base,
      decision: 'deny',
      reason: 'unsafe path',
    }).success,
    true,
  );
  assert.equal(
    RepoAgentDecisionSchema.safeParse({
      ...base,
      decision: 'approve',
      reason: 'not applicable',
    }).success,
    false,
  );
  assert.equal(
    RepoAgentDecisionSchema.safeParse({
      ...base,
      decision: 'abort',
      reason: 'not applicable',
    }).success,
    false,
  );
});

test('public result schema matches the exact four stdout variants', () => {
  const runId = randomUUID();
  assert.equal(
    RepoAgentRunResultSchema.safeParse({
      status: 'completed',
      runId,
      output: 'complete',
    }).success,
    true,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({
      status: 'approval_required',
      runId,
      approval: makeApproval(),
    }).success,
    true,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({ status: 'failed', runId, error: 'failed' }).success,
    true,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({ status: 'aborted', runId }).success,
    true,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({ status: 'completed', runId }).success,
    false,
  );
});

test('create atomically stores a validated request and revision-zero state', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  const state = store.create(request);
  assert.deepEqual(store.readRequest(request.runId), request);
  assert.deepEqual(store.readState(request.runId), state);
  assert.equal(state.status, 'starting');
  assert.equal(state.revision, 0);
  assert.deepEqual(
    readdirSync(join(runsRoot, request.runId)).sort(),
    ['request.json', 'state.json'],
  );
});

test('create validates before writing and rejects duplicate run IDs', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const invalid = {
    ...makeRequest(),
    runId: '../escape',
  };
  assert.throws(() => store.create(invalid), /runId|uuid|invalid/iu);
  assert.equal(readdirSync(runsRoot).length, 0);

  const request = makeRequest();
  store.create(request);
  assert.throws(() => store.create(request), /already exists/iu);
});

test('unknown and malformed reads fail closed without creating paths', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const unknownRunId = randomUUID();
  assert.throws(() => store.readState(unknownRunId), /not found/iu);
  assert.throws(() => store.readRequest(unknownRunId), /not found/iu);
  assert.equal(existsSync(join(runsRoot, unknownRunId)), false);

  const request = makeRequest();
  store.create(request);
  writeFileSync(join(runsRoot, request.runId, 'state.json'), '{bad', 'utf8');
  assert.throws(() => store.readState(request.runId), /malformed/iu);
  writeFileSync(join(runsRoot, request.runId, 'request.json'), '{bad', 'utf8');
  assert.throws(() => store.readRequest(request.runId), /malformed/iu);
});

test('transition enforces the current revision, next revision, and run identity', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const updatedAtUtc = new Date().toISOString();

  assert.throws(
    () => store.transition(request.runId, 0, {
      runId: request.runId,
      revision: 2,
      updatedAtUtc,
      status: 'running',
      pid: process.pid,
    }),
    /next revision|exactly once/iu,
  );
  assert.throws(
    () => store.transition(request.runId, 0, {
      runId: randomUUID(),
      revision: 1,
      updatedAtUtc,
      status: 'running',
      pid: process.pid,
    }),
    /runId|identity/iu,
  );

  moveToRunning(store, request);
  assert.throws(
    () => store.transition(request.runId, 0, {
      runId: request.runId,
      revision: 1,
      updatedAtUtc,
      status: 'completed',
      pid: process.pid,
      output: 'done',
    }),
    /stale revision/iu,
  );
  assert.throws(
    () => store.transition(request.runId, 9, {
      runId: request.runId,
      revision: 10,
      updatedAtUtc,
      status: 'completed',
      pid: process.pid,
      output: 'done',
    }),
    /stale revision/iu,
  );
});

test('transition preserves a worker PID and rejects terminal rewrites', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  assert.throws(
    () => store.transition(request.runId, 1, {
      runId: request.runId,
      revision: 2,
      updatedAtUtc: new Date().toISOString(),
      status: 'completed',
      pid: process.pid + 1,
      output: 'done',
    }),
    /pid/iu,
  );
  store.transition(request.runId, 1, {
    runId: request.runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'completed',
    pid: process.pid,
    output: 'done',
  });
  assert.throws(
    () => store.transition(request.runId, 2, {
      runId: request.runId,
      revision: 3,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed',
      pid: process.pid,
      error: 'late failure',
    }),
    /terminal/iu,
  );
});

test('publishApproval preserves PID and does not create a decision', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const approval = makeApproval();
  const state = store.publishApproval(request.runId, 1, approval);
  assert.deepEqual(state, store.readState(request.runId));
  assert.equal(state.status, 'approval_required');
  if (state.status !== 'approval_required') {
    assert.fail('Expected approval_required state.');
  }
  assert.equal(state.pid, process.pid);
  assert.deepEqual(state.approval, approval);
  assert.equal(existsSync(join(runsRoot, request.runId, 'decision.json')), false);
});

test('submitDecision rejects unknown, stale, mismatched, and duplicate decisions', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const unknownRequest = makeRequest();
  const unknownApproval = makeApproval();
  assert.throws(
    () => store.submitDecision(makeDecision(unknownRequest, unknownApproval)),
    /not found|unknown/iu,
  );
  assert.equal(existsSync(join(runsRoot, unknownRequest.runId)), false);

  const request = makeRequest();
  store.create(request);
  const approval = publishBoundary(store, request);
  assert.throws(
    () => store.submitDecision({
      ...makeDecision(request, approval),
      observedRevision: 1,
    }),
    /stale|revision/iu,
  );
  assert.throws(
    () => store.submitDecision({
      ...makeDecision(request, approval),
      approvalId: randomUUID(),
    }),
    /approval/iu,
  );

  const decision = makeDecision(request, approval);
  store.submitDecision(decision);
  assert.throws(() => store.submitDecision(decision), /already|decision/iu);
  assert.deepEqual(
    RepoAgentDecisionSchema.parse(
      JSON.parse(readFileSync(join(runsRoot, request.runId, 'decision.json'), 'utf8')),
    ),
    decision,
  );
});

test('consumeDecision claims only an exact decision once', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const approval = publishBoundary(store, request);
  const decision = makeDecision(request, approval);
  store.submitDecision(decision);

  assert.equal(store.consumeDecision(request.runId, randomUUID(), 2), null);
  assert.equal(store.consumeDecision(request.runId, approval.approvalId, 1), null);
  assert.deepEqual(
    store.consumeDecision(request.runId, approval.approvalId, 2),
    decision,
  );
  assert.equal(
    store.consumeDecision(request.runId, approval.approvalId, 2),
    null,
  );
});

test('malformed decision files fail closed', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const approval = publishBoundary(store, request);
  writeFileSync(join(runsRoot, request.runId, 'decision.json'), '{bad', 'utf8');
  assert.throws(
    () => store.consumeDecision(request.runId, approval.approvalId, 2),
    /malformed decision/iu,
  );
});

test('clearPendingApproval removes payload and decision while preserving PID', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const approval = publishBoundary(store, request);
  store.submitDecision(makeDecision(request, approval));

  const cleared = store.clearPendingApproval(request.runId, 2, 'running');
  assert.equal(cleared.status, 'running');
  assert.equal(cleared.revision, 3);
  if (cleared.status !== 'running') {
    assert.fail('Expected running state.');
  }
  assert.equal(cleared.pid, process.pid);
  assert.equal('approval' in cleared, false);
  assert.equal(existsSync(join(runsRoot, request.runId, 'decision.json')), false);

  const nextApproval = store.publishApproval(request.runId, 3, makeApproval());
  assert.equal(nextApproval.revision, 4);
});

test('clearPendingApproval aborts and rejects stale or non-pending state', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  assert.throws(
    () => store.clearPendingApproval(request.runId, 0, 'running'),
    /approval_required|pending/iu,
  );
  const approval = publishBoundary(store, request);
  assert.throws(
    () => store.clearPendingApproval(request.runId, 1, 'aborted'),
    /stale revision/iu,
  );
  store.submitDecision(makeDecision(request, approval, 'abort'));
  const aborted = store.clearPendingApproval(request.runId, 2, 'aborted');
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.revision, 3);
  if (aborted.status !== 'aborted') {
    assert.fail('Expected aborted state.');
  }
  assert.equal(aborted.pid, process.pid);
});

test('pruneTerminalRuns deletes only old terminal runs', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const now = new Date('2026-07-28T12:00:00.000Z');

  const oldCompleted = makeRequest();
  store.create(oldCompleted);
  store.transition(oldCompleted.runId, 0, {
    runId: oldCompleted.runId,
    revision: 1,
    updatedAtUtc: '2026-07-01T00:00:00.000Z',
    status: 'completed',
    pid: process.pid,
    output: 'done',
  });

  const oldFailed = makeRequest();
  store.create(oldFailed);
  store.transition(oldFailed.runId, 0, {
    runId: oldFailed.runId,
    revision: 1,
    updatedAtUtc: '2026-07-01T00:00:00.000Z',
    status: 'failed',
    error: 'launch failed',
  });

  const recentCompleted = makeRequest();
  store.create(recentCompleted);
  store.transition(recentCompleted.runId, 0, {
    runId: recentCompleted.runId,
    revision: 1,
    updatedAtUtc: '2026-07-28T00:00:00.000Z',
    status: 'completed',
    pid: process.pid,
    output: 'done',
  });

  const active = makeRequest();
  store.create(active);
  moveToRunning(store, active);

  const pruned = store.pruneTerminalRuns(1, now).sort();
  assert.deepEqual(pruned, [oldCompleted.runId, oldFailed.runId].sort());
  assert.equal(existsSync(join(runsRoot, oldCompleted.runId)), false);
  assert.equal(existsSync(join(runsRoot, oldFailed.runId)), false);
  assert.equal(existsSync(join(runsRoot, recentCompleted.runId)), true);
  assert.equal(existsSync(join(runsRoot, active.runId)), true);
});

test('pruneTerminalRuns preserves malformed, active, recent, and non-run entries', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const malformedRunId = randomUUID();
  const malformedRoot = join(runsRoot, malformedRunId);
  mkdirSync(malformedRoot);
  writeFileSync(join(malformedRoot, 'state.json'), '{bad', 'utf8');
  mkdirSync(join(runsRoot, 'not-a-run'));
  writeFileSync(join(runsRoot, 'ordinary-file'), 'keep', 'utf8');

  const pending = makeRequest();
  store.create(pending);
  publishBoundary(store, pending);

  assert.deepEqual(
    store.pruneTerminalRuns(1, new Date('2026-07-28T12:00:00.000Z')),
    [],
  );
  assert.equal(existsSync(malformedRoot), true);
  assert.equal(existsSync(join(runsRoot, 'not-a-run')), true);
  assert.equal(existsSync(join(runsRoot, 'ordinary-file')), true);
  assert.equal(existsSync(join(runsRoot, pending.runId)), true);
});
