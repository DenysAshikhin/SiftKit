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
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  RepoAgentRunRequestSchema,
  type RepoAgentApproval,
  type RepoAgentRunRequest,
  type RepoAgentRunState,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStateLease } from '../src/repo-agent/run-state-lease.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { classifyRepoAgentExecutionResult } from '../src/repo-agent/run-output.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { buildMockScorecard } from './_test-helpers.js';

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

function buildExecutionResult(
  reason: string,
  passed: boolean,
  verdict: 'pass' | 'fail',
): RepoSearchExecutionResult {
  const scorecard = buildMockScorecard('Terminal synthesis output');
  const task = scorecard.tasks[0];
  if (!task) {
    throw new Error('Expected mock scorecard task.');
  }
  task.reason = reason;
  task.passed = passed;
  scorecard.verdict = verdict;
  return {
    requestId: 'request-id',
    transcriptPath: 'transcript.jsonl',
    artifactPath: 'artifact.json',
    scorecard,
  };
}

test('repo-agent execution outcome requires a genuine passing finish', () => {
  const cases = [
    { reason: 'finish', passed: true, verdict: 'pass' as const, expected: 'completed' },
    { reason: 'invalid_response_limit', passed: false, verdict: 'fail' as const, expected: 'failed' },
    { reason: 'max_turns', passed: false, verdict: 'fail' as const, expected: 'failed' },
    { reason: 'finish', passed: false, verdict: 'fail' as const, expected: 'failed' },
  ];

  for (const fixture of cases) {
    const outcome = classifyRepoAgentExecutionResult(
      buildExecutionResult(fixture.reason, fixture.passed, fixture.verdict),
    );
    assert.equal(outcome.status, fixture.expected);
    assert.equal(outcome.output, 'Terminal synthesis output');
    if (outcome.status === 'failed') {
      assert.match(outcome.error, new RegExp(fixture.reason, 'u'));
    }
  }
});

function makeRunsRoot(): string {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  return runsRoot;
}

function makeStore(): RepoAgentRunStore {
  return new RepoAgentRunStore(makeRunsRoot());
}

function makeRequest(runId = randomUUID()): RepoAgentRunRequest {
  return RepoAgentRunRequestSchema.parse({
    runId,
    task: 'implement the task',
    repoRoot: process.cwd(),
    approval: 'auto',
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
  request: RepoAgentRunRequest,
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
  request: RepoAgentRunRequest,
): RepoAgentApproval {
  moveToRunning(store, request);
  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);
  return approval;
}

class TransitionFailureStore extends RepoAgentRunStore {
  constructor(
    runsRoot: string,
    private readonly advanceBeforeFailure: boolean,
  ) {
    super(runsRoot);
  }

  override transition(
    runId: string,
    expectedRevision: number,
    next: RepoAgentRunState,
  ): RepoAgentRunState {
    if (this.advanceBeforeFailure) {
      super.transition(runId, expectedRevision, next);
    }
    throw new Error('injected transition failure');
  }
}

test('state schema accepts all six states with durable fields', () => {
  const runId = randomUUID();
  const updatedAtUtc = new Date().toISOString();
  const approval = makeApproval();
  const states = [
    { runId, revision: 0, updatedAtUtc, status: 'starting', pid: 123 },
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
    { runId, revision: 3, updatedAtUtc, status: 'failed', pid: 123, error: 'failed', output: 'terminal output' },
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
  assert.equal(RepoAgentRunStateSchema.safeParse({ ...base, status: 'starting' }).success, false);
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

test('run request schema validates every option and rejects invalid input', () => {
  assert.equal(
    RepoAgentRunRequestSchema.safeParse({
      ...makeRequest(),
      model: 'model',
      logFile: 'run.log',
      approval: 'interactive',
    }).success,
    true,
  );
  assert.equal(RepoAgentRunRequestSchema.safeParse({ ...makeRequest(), task: '' }).success, false);
  assert.equal(RepoAgentRunRequestSchema.safeParse({ ...makeRequest(), runId: 'bad' }).success, false);
  assert.equal(RepoAgentRunRequestSchema.safeParse({ ...makeRequest(), approval: 'unsafe' }).success, false);
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
      decide: {
        approve: `siftkit repo-agent decide ${runId} approve`,
        deny: `siftkit repo-agent decide ${runId} deny --reason "<why>"`,
        abort: `siftkit repo-agent decide ${runId} abort`,
      },
    }).success,
    true,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({
      status: 'approval_required',
      runId,
      approval: makeApproval(),
    }).success,
    false,
  );
  assert.equal(
    RepoAgentRunResultSchema.safeParse({ status: 'failed', runId, error: 'failed', output: 'terminal output' }).success,
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

test('starting state owns the server PID and reconcile handles dead or live owners', () => {
  const liveStore = makeStore();
  const liveRequest = makeRequest();
  const liveState = liveStore.create(liveRequest);
  assert.equal(liveState.status, 'starting');
  assert.match(
    readFileSync(join(liveStore.getRunsRoot(), liveRequest.runId, 'state.json'), 'utf8'),
    new RegExp(`"pid": ${process.pid}`, 'u'),
  );
  assert.equal(liveStore.reconcile(liveRequest.runId, { isAlive: () => true }).status, 'starting');

  const deadStore = makeStore();
  const deadRequest = makeRequest();
  deadStore.create(deadRequest);
  const reconciled = deadStore.reconcile(deadRequest.runId, { isAlive: () => false });
  assert.equal(reconciled.status, 'failed');
  if (reconciled.status === 'failed') {
    assert.equal(reconciled.pid, process.pid);
  }
});

test('hasRun distinguishes an existing run directory from an absent run', () => {
  const store = makeStore();
  const request = makeRequest();

  assert.equal(store.hasRun(request.runId), false);
  store.create(request);
  assert.equal(store.hasRun(request.runId), true);
  assert.equal(store.hasRun(randomUUID()), false);
});

test('hasRun propagates non-absence filesystem failures', () => {
  const store = new RepoAgentRunStore(`${TEMP_ROOT}${String.fromCharCode(0)}invalid`);

  assert.throws(
    () => store.hasRun(randomUUID()),
    (error) => error instanceof TypeError && /null bytes|path/u.test(error.message),
  );
});

test('hasRun rejects a run path that exists as a non-directory', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const runId = randomUUID();
  writeFileSync(join(runsRoot, runId), 'not a run directory', 'utf8');

  assert.throws(
    () => store.hasRun(runId),
    /not a directory/iu,
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

test('transition preserves the owning server PID and rejects terminal rewrites', () => {
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

test('transition cannot overwrite state while another owner holds the state lease', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const lease = new RepoAgentRunStateLease(
    join(runsRoot, request.runId, 'state.lock'),
  );
  lease.acquire();

  assert.throws(
    () => moveToRunning(store, request),
    /state transition is already active/iu,
  );
  assert.equal(store.readState(request.runId).revision, 0);
  lease.release();
});

test('publishApproval preserves PID and records the pending approval', () => {
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
});

test('publishApproval cannot overwrite state while another owner holds the state lease', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const lease = new RepoAgentRunStateLease(
    join(runsRoot, request.runId, 'state.lock'),
  );
  lease.acquire();

  assert.throws(
    () => store.publishApproval(request.runId, 1, makeApproval()),
    /state transition is already active/iu,
  );
  assert.equal(store.readState(request.runId).revision, 1);
  lease.release();
});

test('clearPendingApproval removes the payload while preserving PID', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  publishBoundary(store, request);

  const cleared = store.clearPendingApproval(request.runId, 2, 'running');
  assert.equal(cleared.status, 'running');
  assert.equal(cleared.revision, 3);
  if (cleared.status !== 'running') {
    assert.fail('Expected running state.');
  }
  assert.equal(cleared.pid, process.pid);
  assert.equal('approval' in cleared, false);

  const nextApproval = store.publishApproval(request.runId, 3, makeApproval());
  assert.equal(nextApproval.revision, 4);
});

test('clearPendingApproval cannot overwrite state while another owner holds the state lease', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  publishBoundary(store, request);
  const lease = new RepoAgentRunStateLease(
    join(runsRoot, request.runId, 'state.lock'),
  );
  lease.acquire();

  assert.throws(
    () => store.clearPendingApproval(request.runId, 2, 'running'),
    /state transition is already active/iu,
  );
  assert.equal(store.readState(request.runId).status, 'approval_required');
  lease.release();
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
  publishBoundary(store, request);
  assert.throws(
    () => store.clearPendingApproval(request.runId, 1, 'aborted'),
    /stale revision/iu,
  );
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
    pid: process.pid,
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

test('markNotResumable fails an active run with a restart message and is a no-op on terminal runs', () => {
  const store = makeStore();
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId, revision: 1, updatedAtUtc: new Date().toISOString(),
    status: 'running', pid: process.pid,
  });
  const failed = store.markNotResumable(request.runId);
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed') {
    assert.match(failed.error, /not resumable/u);
    assert.match(failed.error, /restarted/u);
  }
  const again = store.markNotResumable(request.runId);
  assert.deepEqual(again, failed);
});

test('reconcile marks an active run with a dead pid as failed and leaves live/terminal runs alone', () => {
  const store = makeStore();
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId, revision: 1, updatedAtUtc: new Date().toISOString(),
    status: 'running', pid: process.pid,
  });
  const deadInspector = { isAlive: () => false };
  const liveInspector = { isAlive: () => true };
  assert.equal(store.reconcile(request.runId, liveInspector).status, 'running');
  const reconciled = store.reconcile(request.runId, deadInspector);
  assert.equal(reconciled.status, 'failed');
  assert.equal(store.reconcile(request.runId, deadInspector).status, 'failed');
});

test('reconcile propagates a transition failure when the revision did not advance', () => {
  const runsRoot = makeRunsRoot();
  const request = makeRequest();
  const baseStore = new RepoAgentRunStore(runsRoot);
  baseStore.create(request);
  moveToRunning(baseStore, request);
  const store = new TransitionFailureStore(runsRoot, false);

  assert.throws(
    () => store.reconcile(request.runId, { isAlive: () => false }),
    /injected transition failure/iu,
  );
  assert.equal(store.readState(request.runId).revision, 1);
});

test('reconcile returns a state advanced by a concurrent transition failure', () => {
  const runsRoot = makeRunsRoot();
  const request = makeRequest();
  const baseStore = new RepoAgentRunStore(runsRoot);
  baseStore.create(request);
  moveToRunning(baseStore, request);
  const store = new TransitionFailureStore(runsRoot, true);

  const reconciled = store.reconcile(request.runId, { isAlive: () => false });

  assert.equal(reconciled.revision, 2);
  assert.equal(reconciled.status, 'failed');
});
