import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolBudgetNotice } from '../src/repo-search/engine/task-loop-support.js';

test('percent notices fire exactly at 25/50/75% used', () => {
  assert.match(String(buildToolBudgetNotice(25, 100)), /25% of the tool-call budget used \(25\/100/u);
  assert.match(String(buildToolBudgetNotice(50, 100)), /50% of the tool-call budget used/u);
  assert.match(String(buildToolBudgetNotice(75, 100)), /75% of the tool-call budget used/u);
  assert.equal(buildToolBudgetNotice(24, 100), null);
  assert.equal(buildToolBudgetNotice(26, 100), null);
});

test('countdown covers the last ten units and the limit-reached message', () => {
  assert.match(String(buildToolBudgetNotice(91, 100)), /9 tool-call batches remaining \(91\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(99, 100)), /1 tool-call batch remaining \(99\/100 used\)/u);
  assert.match(String(buildToolBudgetNotice(100, 100)), /Tool-call limit reached \(100\/100 batches used\)/u);
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
  assert.match(String(buildToolBudgetNotice(6, 8)), /2 tool-call batches remaining/u);
});
