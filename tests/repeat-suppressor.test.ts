import test from 'node:test';
import assert from 'node:assert/strict';

import { RepeatSuppressor } from '../src/status-server/repeat-suppressor.js';

test('an unbroken run of identical events logs once on entry and once on release', () => {
  const lines: string[] = [];
  const suppressor = new RepeatSuppressor();

  const first = suppressor.observe('drain:813b39b4', 1_000);
  assert.equal(first.shouldLog, true);
  assert.equal(first.repeatCount, 0);
  lines.push('entry');

  for (let at = 2_000; at <= 10_000; at += 1_000) {
    assert.equal(suppressor.observe('drain:813b39b4', at).shouldLog, false);
  }

  const released = suppressor.release('drain:813b39b4', 11_000);
  assert.notEqual(released, null);
  assert.equal(released?.repeatCount, 9);
  assert.equal(released?.elapsedMs, 10_000);
  lines.push('exit');

  assert.deepEqual(lines, ['entry', 'exit']);
});

test('repeat counts are reported on every observation of the run', () => {
  const suppressor = new RepeatSuppressor();
  suppressor.observe('a', 0);
  assert.equal(suppressor.observe('a', 1).repeatCount, 1);
  assert.equal(suppressor.observe('a', 2).repeatCount, 2);
});

test('a different key restarts the run', () => {
  const suppressor = new RepeatSuppressor();
  assert.equal(suppressor.observe('a', 0).shouldLog, true);
  assert.equal(suppressor.observe('b', 1).shouldLog, true);
  assert.equal(suppressor.observe('b', 2).shouldLog, false);
});

test('releasing a key that was never observed reports nothing', () => {
  const suppressor = new RepeatSuppressor();
  assert.equal(suppressor.release('missing', 5), null);
});

test('releasing a superseded key reports nothing', () => {
  const suppressor = new RepeatSuppressor();
  suppressor.observe('a', 0);
  suppressor.observe('b', 1);
  assert.equal(suppressor.release('a', 5), null);
});

test('a run can be released and then started again', () => {
  const suppressor = new RepeatSuppressor();
  suppressor.observe('a', 0);
  suppressor.observe('a', 1_000);
  assert.equal(suppressor.release('a', 2_000)?.repeatCount, 1);
  assert.equal(suppressor.release('a', 3_000), null);

  assert.equal(suppressor.observe('a', 4_000).shouldLog, true);
  assert.deepEqual(suppressor.release('a', 5_000), { repeatCount: 0, elapsedMs: 1_000 });
});

test('a clock that moves backwards clamps elapsed to zero', () => {
  const suppressor = new RepeatSuppressor();
  suppressor.observe('a', 5_000);
  assert.equal(suppressor.release('a', 1_000)?.elapsedMs, 0);
});
