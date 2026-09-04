import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalMode } from '@siftkit/contracts';
import type {
  ApprovalDecision,
  ApprovalRequestInput,
  ApprovalRequester,
  HumanApprovalRequester,
  HumanApprovalRequestInput,
  LiveApprovalMode,
} from '../src/repo-search/engine/approval-gate.js';
import { ModeSwitchedApprovalRequester } from '../src/repo-search/engine/approval-mode-requester.js';

class FakeHumanGate implements HumanApprovalRequester {
  readonly calls: HumanApprovalRequestInput[] = [];
  request(input: HumanApprovalRequestInput): Promise<ApprovalDecision> {
    this.calls.push(input);
    return Promise.resolve({ kind: 'deny', reason: 'human' });
  }
}

class FakeLlmGate implements ApprovalRequester {
  readonly calls: ApprovalRequestInput[] = [];
  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    this.calls.push(input);
    return Promise.resolve({ kind: 'deny', reason: 'llm' });
  }
}

class MutableMode implements LiveApprovalMode {
  constructor(public mode: ApprovalMode) {}
}

const INPUT: ApprovalRequestInput = {
  turn: 1, toolName: 'write', command: 'write x', reviewPayload: null, pendingMessages: [],
};

test('off approves without consulting either gate', async () => {
  const human = new FakeHumanGate();
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(new MutableMode('off'), human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'approve' });
  assert.equal(human.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('interactive routes to the human gate only', async () => {
  const human = new FakeHumanGate();
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(new MutableMode('interactive'), human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'human' });
  assert.equal(llm.calls.length, 0);
});

test('auto routes to the LLM gate', async () => {
  const human = new FakeHumanGate();
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(new MutableMode('auto'), human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'llm' });
  assert.equal(human.calls.length, 0);
});

test('the mode is read on every call, so a switch mid-run changes the next decision', async () => {
  const mode = new MutableMode('interactive');
  const human = new FakeHumanGate();
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(mode, human, llm);
  assert.equal((await requester.request(INPUT)).kind, 'deny');
  mode.mode = 'off';
  assert.deepEqual(await requester.request(INPUT), { kind: 'approve' });
  mode.mode = 'auto';
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'llm' });
  assert.equal(human.calls.length, 1);
  assert.equal(llm.calls.length, 1);
});
