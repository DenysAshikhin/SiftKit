import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
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
