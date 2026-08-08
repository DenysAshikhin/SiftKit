import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import {
  ApprovalGate,
  DEFAULT_DECISION_TIMEOUT_MS,
  buildApprovalTimeoutMessage,
  type ApprovalDecision,
} from '../src/repo-search/engine/approval-gate.js';
import { ApprovalGateHarness } from './helpers/approval-gate-harness.js';

class CollectingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

test('request emits approval_request and resolves with the submitted decision', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 2,
    toolName: 'write',
    command: 'write path=src/x.ts',
    reviewPayload: null,
  });
  assert.equal(writer.events.length, 1);
  const event = writer.events[0];
  assert.equal(event.kind, 'approval_request');
  assert.equal(event.requestId, 'run-1');
  assert.equal(event.toolName, 'write');
  assert.equal(event.command, 'write path=src/x.ts');
  assert.equal(typeof event.approvalId, 'string');
  const submitted = gate.submit(String(event.approvalId), { kind: 'approve' });
  assert.equal(submitted, true);
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('deny decision carries its reason', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 1,
    toolName: 'git',
    command: 'git log',
    reviewPayload: null,
  });
  gate.submit(String(writer.events[0].approvalId), { kind: 'deny', reason: 'wrong branch' });
  assert.deepEqual(await pending, { kind: 'deny', reason: 'wrong branch' });
});

test('unknown or already-resolved approvalId returns false', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  assert.equal(gate.submit('nope', { kind: 'approve' }), false);
  const pending = gate.request({
    turn: 1,
    toolName: 'ls',
    command: 'ls',
    reviewPayload: null,
  });
  const approvalId = String(writer.events[0].approvalId);
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), true);
  await pending;
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), false);
});

test('pending approval remains live until an explicit decision', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 1,
    toolName: 'write',
    command: 'write path=a.ts',
    reviewPayload: null,
  });
  await delay(50);
  assert.equal(
    gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }),
    true,
  );
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('the decision timeout matches the ten minutes the repo-agent prompter waits', () => {
  assert.equal(DEFAULT_DECISION_TIMEOUT_MS, 600_000);
});

// Without this bound the gate parks forever: a run whose client never answers holds the model
// lock indefinitely, which is how one operation held it for 943s with a queue behind it.
// Timing out must end the run, not inject a denial the planner silently absorbs.
test('an unanswered approval aborts the run once the decision timeout elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 1,
    toolName: 'git',
    command: 'git grep -n "x" src1',
    reviewPayload: null,
  });

  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS);

  assert.deepEqual(await pending, {
    kind: 'abort',
    reason: buildApprovalTimeoutMessage(DEFAULT_DECISION_TIMEOUT_MS),
  });
  // The approval is gone, so a late decision cannot resurrect a command already reported as timed out.
  assert.equal(gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }), false);
});

test('a submitted decision cancels the pending timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 1,
    toolName: 'write',
    command: 'write path=a.ts',
    reviewPayload: null,
  });

  assert.equal(gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }), true);
  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS * 2);

  assert.deepEqual(await pending, { kind: 'approve' });
});

test('abort clears the timeout so it cannot resolve an already-rejected approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1,
    toolName: 'write',
    command: 'write path=a.ts',
    reviewPayload: null,
  });
  const reason = new Error('client disconnected');
  harness.controller.abort(reason);

  await assert.rejects(pending, reason);
  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS * 2);
  assert.equal(harness.gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }), false);
});

test('abort rejects every pending approval and makes their IDs stale', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const first = harness.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  const second = harness.gate.request({
    turn: 2, toolName: 'edit', command: 'edit path=b.ts', reviewPayload: null,
  });
  const firstId = String(writer.events[0].approvalId);
  const secondId = String(writer.events[1].approvalId);
  const reason = new Error('client disconnected');
  harness.controller.abort(reason);

  await assert.rejects(first, reason);
  await assert.rejects(second, reason);
  assert.equal(harness.gate.submit(firstId, { kind: 'approve' }), false);
  assert.equal(harness.gate.submit(secondId, { kind: 'approve' }), false);
});

test('an already-aborted signal rejects without emitting approval_request', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  harness.controller.abort(new Error('stream already closed'));
  await assert.rejects(
    harness.gate.request({
      turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
    }),
    /stream already closed/u,
  );
  assert.equal(writer.events.length, 0);
});

test('submission removes abort handling from the resolved approval', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  assert.equal(
    harness.gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }),
    true,
  );
  harness.controller.abort(new Error('late disconnect'));
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('read-only bypass still approves when the signal is already aborted', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer, true);
  harness.controller.abort(new Error('closed'));
  assert.deepEqual(await harness.gate.request({
    turn: 1, toolName: 'read', command: 'read path=a.ts', reviewPayload: null,
  }), { kind: 'approve' });
  assert.equal(writer.events.length, 0);
});

for (const toolName of ['read', 'grep', 'find', 'ls']) {
  test(`bypassReadOnlyTools: true — ${toolName} returns approve immediately with no event`, async () => {
    const writer = new CollectingWriter();
    const gate = new ApprovalGateHarness(writer, true).gate;
    const decision = gate.request({
      turn: 1,
      toolName,
      command: `${toolName} path=test`,
      reviewPayload: null,
    });
    const event = writer.events[0];
    if (event) {
      gate.submit(String(event.approvalId), { kind: 'approve' });
    }
    assert.deepEqual(await decision, { kind: 'approve' });
    assert.equal(writer.events.length, 0);
  });
}

for (const { toolName, command } of [
  { toolName: 'run', command: 'grep secret.txt' },
  { toolName: 'future_read', command: 'read path=a.ts' },
]) {
  test(`bypassReadOnlyTools: true — ${toolName} still emits approval_request`, async () => {
    const writer = new CollectingWriter();
    const gate = new ApprovalGateHarness(writer, true).gate;
    const pending = gate.request({
      turn: 1,
      toolName,
      command,
      reviewPayload: null,
    });
    assert.equal(writer.events.length, 1);
    assert.equal(writer.events[0].kind, 'approval_request');
    gate.submit(String(writer.events[0].approvalId), { kind: 'approve' });
    assert.deepEqual(await pending, { kind: 'approve' });
  });
}

test('manual approval event carries the transient review payload but the decision does not', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const reviewPayload = '{\n  "content": "manual-review-sentinel"\n}';
  const pending = gate.request({
    turn: 1,
    toolName: 'write',
    command: 'write path="src/x.ts" bytes=22',
    reviewPayload,
  });

  assert.equal(writer.events.length, 1);
  assert.equal(writer.events[0].reviewPayload, reviewPayload);
  gate.submit(String(writer.events[0].approvalId), { kind: 'approve' });
  assert.deepEqual(await pending, { kind: 'approve' });
});

// ---- Console visibility: a parked approval must never be silent ----

test('the gate logs a park line and a decision line around an approval wait', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 3,
    toolName: 'write',
    command: 'write path=src/x.ts bytes=12',
    reviewPayload: null,
  });
  const approvalId = String(writer.events[0].approvalId);
  assert.equal(harness.logLines.length, 1);
  assert.match(harness.logLines[0], /approval_wait/u);
  assert.match(harness.logLines[0], new RegExp(`approval=${approvalId.slice(0, 8)}`, 'u'));
  assert.match(harness.logLines[0], /tool=write/u);
  assert.match(harness.logLines[0], new RegExp(`timeout_ms=${DEFAULT_DECISION_TIMEOUT_MS}`, 'u'));
  assert.match(harness.logLines[0], /command=write path=src\/x\.ts bytes=12/u);

  harness.gate.submit(approvalId, { kind: 'approve' });
  await pending;
  assert.equal(harness.logLines.length, 2);
  assert.match(harness.logLines[1], /approval_decision/u);
  assert.match(harness.logLines[1], /decision=approve/u);
  assert.match(harness.logLines[1], /waited_ms=\d+/u);
});

test('an expired approval logs approval_timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1, toolName: 'run', command: 'npm test', reviewPayload: null,
  });
  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS);
  await pending;
  assert.equal(harness.logLines.length, 2);
  assert.match(harness.logLines[1], /approval_timeout/u);
  assert.match(harness.logLines[1], /tool=run/u);
  assert.match(harness.logLines[1], new RegExp(`waited_ms=${DEFAULT_DECISION_TIMEOUT_MS}`, 'u'));
});

test('a client disconnect while parked logs approval_abandoned, an immediate abort logs nothing', async () => {
  const writer = new CollectingWriter();
  const parked = new ApprovalGateHarness(writer);
  const pending = parked.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  parked.controller.abort(new Error('client disconnected'));
  await assert.rejects(pending, /client disconnected/u);
  assert.equal(parked.logLines.length, 2);
  assert.match(parked.logLines[1], /approval_abandoned/u);

  const preAborted = new ApprovalGateHarness(new CollectingWriter());
  preAborted.controller.abort(new Error('stream already closed'));
  await assert.rejects(preAborted.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  }), /stream already closed/u);
  assert.equal(preAborted.logLines.length, 0);
});

// ---- Observer hooks ----

class RecordingObserver {
  decisions: ApprovalDecision[] = [];
  timeouts = 0;
  onDecision(decision: ApprovalDecision): void { this.decisions.push(decision); }
  onTimeout(): void { this.timeouts += 1; }
}

test('observer.onDecision fires with the submitted decision', async () => {
  const writer = new CollectingWriter();
  const observer = new RecordingObserver();
  const controller = new AbortController();
  const gate = new ApprovalGate({
    requestId: 'req-observer-1',
    progressWriter: writer,
    abortSignal: controller.signal,
    bypassReadOnlyTools: false,
    observer,
  });
  const pending = gate.request({ turn: 1, toolName: 'run', command: 'echo hi', reviewPayload: null });
  const approvalId = String(writer.events.find((e) => e.kind === 'approval_request')?.approvalId ?? '');
  assert.ok(approvalId);
  assert.equal(gate.submit(approvalId, { kind: 'deny', reason: 'nope' }), true);
  assert.deepEqual(await pending, { kind: 'deny', reason: 'nope' });
  assert.deepEqual(observer.decisions, [{ kind: 'deny', reason: 'nope' }]);
  assert.equal(observer.timeouts, 0);
});

test('observer.onTimeout fires when the decision timer expires', async () => {
  const writer = new CollectingWriter();
  const observer = new RecordingObserver();
  const controller = new AbortController();
  const gate = new ApprovalGate({
    requestId: 'req-observer-2',
    progressWriter: writer,
    abortSignal: controller.signal,
    bypassReadOnlyTools: false,
    decisionTimeoutMs: 25,
    observer,
  });
  const decision = await gate.request({ turn: 1, toolName: 'run', command: 'echo hi', reviewPayload: null });
  assert.equal(decision.kind, 'abort');
  assert.equal(observer.timeouts, 1);
  assert.deepEqual(observer.decisions, []);
});
