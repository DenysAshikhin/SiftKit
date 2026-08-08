import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import type { JsonObject } from '../src/lib/json-types.js';
import {
  RepoAgentApprovalSchema,
  RepoAgentDecisionSchema,
  RepoAgentRunStateSchema,
  RepoAgentRunRequestSchema,
  isTerminalStatus,
  type RepoAgentApproval,
  type RepoAgentDecision,
  type RepoAgentRunRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { RepoAgentRunApprovalPrompter } from '../src/repo-agent/run-approval-prompter.js';
import {
  RepoAgentBoundaryWaiter,
  repoAgentStateToResult,
} from '../src/repo-agent/boundary-waiter.js';
import type { ApprovalPrompter } from '../src/cli/approval-prompter.js';
import {
  CLIENT_ABORT_MESSAGE,
  buildApprovalTimeoutMessage,
} from '../src/repo-search/engine/approval-gate.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-run-approval-prompter-tests-${process.pid}`,
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
    reviewPayload: '{"action":"edit","oldText":"foo"}',
  });
}

function makeApprovalEvent(approval: RepoAgentApproval): JsonObject {
  return {
    kind: 'approval_request',
    requestId: randomUUID(),
    approvalId: approval.approvalId,
    toolName: approval.toolName,
    command: approval.command,
    reviewPayload: approval.reviewPayload,
  };
}

function moveToRunning(store: RepoAgentRunStore, request: RepoAgentRunRequest): void {
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });
}

function makePrompter(
  store: RepoAgentRunStore,
  runId: string,
): RepoAgentRunApprovalPrompter {
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId,
    pollIntervalMs: 5,
  });
  return new RepoAgentRunApprovalPrompter({ store, waiter, runId });
}

test('rejects event missing requestId', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const prompter = makePrompter(store, request.runId);
  const badEvent: JsonObject = {
    kind: 'approval_request',
    approvalId: randomUUID(),
    toolName: 'edit',
    command: 'edit something',
  };
  await assert.rejects(
    () => prompter.promptDecision(badEvent),
    /requestId/u,
  );
});

test('rejects event missing approvalId', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const prompter = makePrompter(store, request.runId);
  const badEvent: JsonObject = {
    kind: 'approval_request',
    requestId: randomUUID(),
    toolName: 'edit',
    command: 'edit something',
  };
  await assert.rejects(
    () => prompter.promptDecision(badEvent),
    /approvalId/u,
  );
});

test('rejects event missing toolName', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const prompter = makePrompter(store, request.runId);
  const badEvent: JsonObject = {
    kind: 'approval_request',
    requestId: randomUUID(),
    approvalId: randomUUID(),
    command: 'edit something',
  };
  await assert.rejects(
    () => prompter.promptDecision(badEvent),
    /toolName/u,
  );
});

test('rejects event missing command', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const prompter = makePrompter(store, request.runId);
  const badEvent: JsonObject = {
    kind: 'approval_request',
    requestId: randomUUID(),
    approvalId: randomUUID(),
    toolName: 'edit',
  };
  await assert.rejects(
    () => prompter.promptDecision(badEvent),
    /command/u,
  );
});

// ---- Publish approval_required state ----

test('publishes complete approval_required state with full payload', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  const event = makeApprovalEvent(approval);

  const prompter = makePrompter(store, request.runId);
  const pending = prompter.promptDecision(event);

  // State should have been published to approval_required
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_required');
  assert.equal(state.revision, 2);
  assert.equal(state.approval.approvalId, approval.approvalId);
  assert.equal(state.approval.toolName, approval.toolName);
  assert.equal(state.approval.command, approval.command);
  assert.equal(state.approval.reviewPayload, approval.reviewPayload);

  // Submit an abort decision to settle the pending promise
  const decision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision: 'abort',
  });
  store.submitDecision(decision);
  const result = await pending;
  assert.deepEqual(result, { kind: 'abort', reason: CLIENT_ABORT_MESSAGE });
});

test('preserves reviewPayload exactly without trimming content', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const approval = makeApproval();
  const reviewPayload = ' \n{"action":"edit","content":"complete"}\n ';
  const pending = makePrompter(store, request.runId).promptDecision({
    ...makeApprovalEvent(approval),
    reviewPayload,
  });
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_required');
  if (state.status !== 'approval_required') {
    assert.fail('Expected approval_required state.');
  }
  store.submitDecision(RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: state.revision,
    decision: 'abort',
  }));
  await pending;
  assert.equal(state.approval.reviewPayload, reviewPayload);
});

test('rejects a non-string reviewPayload instead of hiding it', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const approval = makeApproval();
  const pending = makePrompter(store, request.runId).promptDecision({
    ...makeApprovalEvent(approval),
    reviewPayload: { hidden: 'content' },
  });
  const state = store.readState(request.runId);
  if (state.status === 'approval_required') {
    store.submitDecision(RepoAgentDecisionSchema.parse({
      runId: request.runId,
      approvalId: approval.approvalId,
      observedRevision: state.revision,
      decision: 'abort',
    }));
  }
  await assert.rejects(() => pending, /reviewPayload/iu);
  assert.equal(store.readState(request.runId).status, 'running');
});

// ---- Approve decision ----

test('approve returns {kind:"approve"}', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  const event = makeApprovalEvent(approval);

  const prompter = makePrompter(store, request.runId);
  const pending = prompter.promptDecision(event);

  // Submit approve decision
  const decision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision: 'approve',
  });
  store.submitDecision(decision);

  const result = await pending;
  assert.deepEqual(result, { kind: 'approve' });
});

// ---- Deny decision ----

test('deny returns {kind:"deny", reason:"..."}', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  const event = makeApprovalEvent(approval);

  const prompter = makePrompter(store, request.runId);
  const pending = prompter.promptDecision(event);

  const decision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision: 'deny',
    reason: 'unsafe path',
  });
  store.submitDecision(decision);

  const result = await pending;
  assert.deepEqual(result, { kind: 'deny', reason: 'unsafe path' });
});

// ---- Abort decision ----

test('abort returns {kind:"abort"} and terminal aborted state', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  const event = makeApprovalEvent(approval);

  const prompter = makePrompter(store, request.runId);
  const pending = prompter.promptDecision(event);

  const decision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision: 'abort',
  });
  store.submitDecision(decision);

  const result = await pending;
  assert.deepEqual(result, { kind: 'abort', reason: CLIENT_ABORT_MESSAGE });

  // State should be aborted
  const state = store.readState(request.runId);
  assert.equal(state.status, 'aborted');
});

// ---- Sensitive state cleanup ----

test('settled state and decision files contain no command or review payload', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  const event = makeApprovalEvent(approval);

  const prompter = makePrompter(store, request.runId);
  const pending = prompter.promptDecision(event);

  const decision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 2,
    decision: 'approve',
  });
  store.submitDecision(decision);
  await pending;

  // Check settled state has no approval payload
  const state = store.readState(request.runId);
  assert.equal(state.status, 'running');
  // The state should be back to 'running' after approve, with no approval field
  const stateRaw = readFileSync(join(runsRoot, request.runId, 'state.json'), 'utf8');
  assert.ok(!stateRaw.includes('command'), 'settled state must not contain command');
  assert.ok(!stateRaw.includes('reviewPayload'), 'settled state must not contain reviewPayload');
  assert.ok(!stateRaw.includes('toolName'), 'settled state must not contain toolName');

  // Decision file should be consumed (deleted)
  assert.ok(
    !existsSync(join(runsRoot, request.runId, 'decision.json')),
    'decision file must be consumed',
  );
});

// ---- Mismatched/stale decisions ----

test('mismatched approvalId decision is rejected by store', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);

  // Submit a decision with wrong approvalId
  const badDecision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: randomUUID(), // wrong!
    observedRevision: 2,
    decision: 'approve',
  });
  // This should fail because approvalId doesn't match
  assert.throws(
    () => store.submitDecision(badDecision),
    /approval ID/u,
  );

  // Verify the pending approval is still intact
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_required');
  assert.equal(state.approval.approvalId, approval.approvalId);
});

test('stale revision decision is rejected by store', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const approval = makeApproval();
  store.publishApproval(request.runId, 1, approval);

  // Submit a decision with stale revision
  const staleDecision: RepoAgentDecision = RepoAgentDecisionSchema.parse({
    runId: request.runId,
    approvalId: approval.approvalId,
    observedRevision: 1, // stale! current is 2
    decision: 'approve',
  });
  assert.throws(
    () => store.submitDecision(staleDecision),
    /stale|revision/u,
  );

  // Verify the pending approval is still intact
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_required');
  assert.equal(state.approval.approvalId, approval.approvalId);
});

// ---- Decision timeout ----

test('an undecided approval times out into a terminal approval_timeout and aborts', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({ store, runId: request.runId, pollIntervalMs: 5 });
  const prompter = new RepoAgentRunApprovalPrompter({
    store,
    waiter,
    runId: request.runId,
    decisionTimeoutMs: 100,
  });
  const approval = makeApproval();
  const decision = await prompter.promptDecision(makeApprovalEvent(approval));
  assert.deepEqual(decision, {
    kind: 'abort',
    reason: buildApprovalTimeoutMessage(100),
  });
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_timeout');
  if (state.status !== 'approval_timeout') {
    assert.fail('Expected approval_timeout state.');
  }
  assert.equal(state.approval.approvalId, approval.approvalId);
  assert.equal(state.approval.reviewPayload, null);
});

// ---- Constructor dependency ----

test('constructor accepts store, waiter, and runId', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const runId = randomUUID();
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId,
    pollIntervalMs: 10,
  });
  const prompter = new RepoAgentRunApprovalPrompter({ store, waiter, runId });
  assert.ok(prompter instanceof RepoAgentRunApprovalPrompter);
});

test('implements ApprovalPrompter interface', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const runId = randomUUID();
  const waiter = new RepoAgentBoundaryWaiter({
    store,
    runId,
    pollIntervalMs: 10,
  });
  const prompter: ApprovalPrompter = new RepoAgentRunApprovalPrompter({
    store,
    waiter,
    runId,
  });
  assert.ok(typeof prompter.promptDecision === 'function');
});

// ---- approval_timeout terminal status ----

test('approval_timeout is a terminal state that maps to an approval_timeout result', () => {
  const runId = randomUUID();
  const approval = makeApproval();
  const state = RepoAgentRunStateSchema.parse({
    runId,
    revision: 3,
    updatedAtUtc: new Date().toISOString(),
    status: 'approval_timeout',
    pid: process.pid,
    approval,
  });
  assert.equal(isTerminalStatus(state.status), true);
  assert.deepEqual(repoAgentStateToResult(state), {
    status: 'approval_timeout',
    runId,
    approval,
  });
});

test('clearPendingApproval can settle into approval_timeout, dropping the review payload', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const approval = makeApproval();
  const published = store.publishApproval(request.runId, 1, approval);

  const next = store.clearPendingApproval(request.runId, published.revision, 'approval_timeout');

  assert.equal(next.status, 'approval_timeout');
  if (next.status !== 'approval_timeout') {
    assert.fail('Expected approval_timeout state.');
  }
  assert.equal(next.approval.approvalId, approval.approvalId);
  assert.equal(next.approval.toolName, approval.toolName);
  assert.equal(next.approval.command, approval.command);
  assert.equal(next.approval.reviewPayload, null);
  const raw = readFileSync(join(runsRoot, request.runId, 'state.json'), 'utf8');
  assert.ok(!raw.includes('"oldText"'), 'terminal state must not retain review payload content');
});
