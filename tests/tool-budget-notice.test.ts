import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolBudgetNotice, isToolBudgetSpent } from '../src/repo-search/engine/task-loop-support.js';

test('percent notices fire exactly at 25/50/75% used', () => {
  assert.match(String(buildToolBudgetNotice(25, 100)), /25% of the tool-call budget used \(25\/100/u);
  assert.match(String(buildToolBudgetNotice(50, 100)), /50% of the tool-call budget used/u);
  assert.match(String(buildToolBudgetNotice(75, 100)), /75% of the tool-call budget used/u);
  assert.equal(buildToolBudgetNotice(24, 100), null);
  assert.equal(buildToolBudgetNotice(26, 100), null);
});

test('countdown covers the last ten turns and the limit-reached message', () => {
  assert.match(String(buildToolBudgetNotice(91, 100)), /9 tool-call turns remaining \(91\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(99, 100)), /1 tool-call turn remaining \(99\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(100, 100)), /Tool-call limit reached \(100\/100 turns used\)/u);
  assert.equal(buildToolBudgetNotice(90, 100), null);
});

test('a full run at limit 100 emits exactly 13 notices', () => {
  let count = 0;
  for (let used = 1; used <= 100; used += 1) {
    if (buildToolBudgetNotice(used, 100) !== null) count += 1;
  }
  assert.equal(count, 13);
});

test('countdown outranks percent thresholds at small limits', () => {
  // limit 8: 75% threshold is ceil(6) but remaining 2 is inside the countdown window.
  assert.match(String(buildToolBudgetNotice(6, 8)), /2 tool-call turns remaining/u);
});

test('percent notices only fire while more than the countdown window remains', () => {
  // limit 14: the 25% threshold is ceil(3.5) = 4 with remaining 10 (> window 9) → percent notice.
  assert.match(String(buildToolBudgetNotice(4, 14)), /25% of the tool-call budget used \(4\/14/u);
  // one more turn: remaining 9 enters the countdown window, which outranks percents.
  assert.match(String(buildToolBudgetNotice(5, 14)), /9 tool-call turns remaining \(5\/14 used\)/u);
});

test('tiny limits never mislabel: percent collisions are covered by the countdown window', () => {
  // ceil(percent·limit) collisions require limit < 4, where remaining is always ≤ 9, so the
  // countdown or limit-reached message wins and the percent loop is never consulted.
  assert.match(String(buildToolBudgetNotice(1, 2)), /1 tool-call turn remaining \(1\/2 used\)/u);
  assert.match(String(buildToolBudgetNotice(1, 3)), /2 tool-call turns remaining \(1\/3 used\)/u);
  assert.match(String(buildToolBudgetNotice(2, 2)), /Tool-call limit reached \(2\/2 turns used\)/u);
});

test('isToolBudgetSpent is the boundary the notice, the refusal and the finish gate share', () => {
  assert.equal(isToolBudgetSpent(44, 45), false);
  assert.equal(isToolBudgetSpent(45, 45), true);
  assert.equal(isToolBudgetSpent(46, 45), true);
  assert.equal(isToolBudgetSpent(0, 0), true);
});
