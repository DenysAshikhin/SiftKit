import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINISH_VERIFICATION_CHALLENGE_MESSAGE,
  FINISH_VERIFICATION_MAX_CHALLENGES,
  FinishVerificationGate,
} from '../src/repo-search/engine/finish-verification.js';

test('disabled gate accepts every finish without challenging', () => {
  const gate = new FinishVerificationGate(false);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(gate.evaluateFinish(), { kind: 'accept' });
  }
  assert.equal(gate.issuedCount, 0);
});

test('first finish is challenged and an immediate second finish is accepted as reaffirmed', () => {
  const gate = new FinishVerificationGate(true);
  const first = gate.evaluateFinish();
  assert.equal(first.kind, 'challenge');
  if (first.kind === 'challenge') {
    assert.equal(first.message, FINISH_VERIFICATION_CHALLENGE_MESSAGE);
    assert.equal(first.challengesIssued, 1);
  }
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'reaffirmed' });
});

test('backing down with tool actions re-arms the challenge, up to the maximum', () => {
  const gate = new FinishVerificationGate(true);
  assert.equal(gate.evaluateFinish().kind, 'challenge'); // finish #1
  gate.recordNonFinishAction();                           // backs down, works
  const second = gate.evaluateFinish();                   // finish #2
  assert.equal(second.kind, 'challenge');
  if (second.kind === 'challenge') {
    assert.equal(second.challengesIssued, FINISH_VERIFICATION_MAX_CHALLENGES);
  }
  gate.recordNonFinishAction();                           // backs down again
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'forced' }); // finish #3
  assert.equal(gate.issuedCount, 2);
});

test('an invalid response between challenge and finish does not clear the reaffirmation window', () => {
  const gate = new FinishVerificationGate(true);
  assert.equal(gate.evaluateFinish().kind, 'challenge');
  // No recordNonFinishAction call: only an executed tool action counts as backing down.
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'reaffirmed' });
});
