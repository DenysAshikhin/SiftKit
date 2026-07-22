import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

class CollectingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

test('request emits approval_request and resolves with the submitted decision', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  const pending = gate.request({ turn: 2, toolName: 'write', command: 'write path=src/x.ts' });
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
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  const pending = gate.request({ turn: 1, toolName: 'git', command: 'git log' });
  gate.submit(String(writer.events[0].approvalId), { kind: 'deny', reason: 'wrong branch' });
  assert.deepEqual(await pending, { kind: 'deny', reason: 'wrong branch' });
});

test('unknown or already-resolved approvalId returns false', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  assert.equal(gate.submit('nope', { kind: 'approve' }), false);
  const pending = gate.request({ turn: 1, toolName: 'ls', command: 'ls' });
  const approvalId = String(writer.events[0].approvalId);
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), true);
  await pending;
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), false);
});

test('timeout rejects with a distinct error', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 30 });
  await assert.rejects(
    gate.request({ turn: 1, toolName: 'read', command: 'read path=a.ts' }),
    /Approval request timed out after 30 ms\./u,
  );
});
