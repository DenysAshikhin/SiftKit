import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORCED_FINISH_MAX_ATTEMPTS,
  FORCED_FINISH_MODE_MESSAGE,
  ForcedFinishController,
  ZERO_OUTPUT_FORCE_THRESHOLD,
} from '../src/repo-search/engine/forced-finish.js';

test('activateFromStagnation arms the controller and returns the mode-change message', () => {
  const controller = new ForcedFinishController();
  assert.equal(controller.isActive(), false);
  assert.equal(controller.activateFromStagnation(), FORCED_FINISH_MODE_MESSAGE);
  assert.equal(controller.isActive(), true);
});

test('consumeAttempt counts down with exact engine message strings and reports exhaustion', () => {
  const controller = new ForcedFinishController();
  controller.activateFromStagnation();
  const first = controller.consumeAttempt();
  assert.equal(first.attemptsRemaining, FORCED_FINISH_MAX_ATTEMPTS - 1);
  assert.equal(first.rejectionReason, `Forced finish mode active. Return a finish action now. Attempts remaining: ${FORCED_FINISH_MAX_ATTEMPTS - 1}.`);
  assert.equal(first.countdownText, `Forced finish attempts remaining: ${FORCED_FINISH_MAX_ATTEMPTS - 1}. Return a finish action now.`);
  assert.equal(first.exhausted, false);
  controller.consumeAttempt();
  const last = controller.consumeAttempt();
  assert.equal(last.attemptsRemaining, 0);
  assert.equal(last.exhausted, true);
});

test('consumeAttempt before activation stays exhausted at zero remaining attempts', () => {
  const controller = new ForcedFinishController();
  const attempt = controller.consumeAttempt();
  assert.equal(attempt.attemptsRemaining, 0);
  assert.equal(attempt.exhausted, true);
  assert.equal(controller.isActive(), false);
});

test('recordToolOutput counts a zero-output streak with engine warning text', () => {
  const controller = new ForcedFinishController();
  const first = controller.recordToolOutput(0);
  assert.equal(first.zeroOutputStreak, 1);
  assert.equal(first.remainingBeforeForce, ZERO_OUTPUT_FORCE_THRESHOLD - 1);
  assert.equal(first.warningText, `Zero-output warning: ${ZERO_OUTPUT_FORCE_THRESHOLD - 1} more zero-output command(s) and you will be forced to answer.`);
  assert.equal(first.activated, false);
});

test('recordToolOutput resets the streak on non-empty output', () => {
  const controller = new ForcedFinishController();
  controller.recordToolOutput(0);
  const reset = controller.recordToolOutput(42);
  assert.equal(reset.zeroOutputStreak, 0);
  assert.equal(reset.warningText, '');
  assert.equal(controller.recordToolOutput(0).zeroOutputStreak, 1);
});

test('recordToolOutput activates forced finish at the threshold, once', () => {
  const controller = new ForcedFinishController();
  let last = controller.recordToolOutput(0);
  for (let i = 1; i < ZERO_OUTPUT_FORCE_THRESHOLD; i += 1) {
    last = controller.recordToolOutput(0);
  }
  assert.equal(last.remainingBeforeForce, 0);
  assert.equal(last.warningText, `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`);
  assert.equal(last.activated, true);
  assert.equal(controller.isActive(), true);
  // already active -> not re-activated
  assert.equal(controller.recordToolOutput(0).activated, false);
});
