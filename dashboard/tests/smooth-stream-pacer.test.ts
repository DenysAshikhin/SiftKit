import test from 'node:test';
import assert from 'node:assert/strict';

import { SmoothStreamPacer } from '../src/lib/smooth-stream-pacer';

test('starts caught up at the initial length', () => {
  const pacer = new SmoothStreamPacer(10);
  assert.equal(pacer.isCaughtUp(), true);
  assert.equal(pacer.sample(0), 10);
});

test('advances toward the target at a rate derived from arrivals', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(100, 0);
  pacer.push(200, 1000); // EMA = 0.1 chars/ms
  const first = pacer.sample(1000);
  const second = pacer.sample(1100);
  assert.equal(second > first, true);
  assert.equal(second <= 200, true);
  assert.equal(pacer.isCaughtUp(), false);
});

test('reaches the target with repeated samples and stays there', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(50, 0);
  pacer.push(100, 500); // EMA = 0.1 chars/ms
  let at = 500;
  let displayed = 0;
  for (let step = 0; step < 100 && displayed < 100; step += 1) {
    at += 33;
    displayed = pacer.sample(at);
  }
  assert.equal(displayed, 100);
  assert.equal(pacer.isCaughtUp(), true);
});

test('jumps forward when the backlog exceeds the cap, keeping a small tail', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(10_000, 0);
  // Fallback rate 0.06 chars/ms -> backlog is far beyond 2000 ms; jump to
  // target minus a 300 ms tail (0.06 * 300 = 18 chars).
  assert.equal(pacer.sample(0), 10_000 - 18);
});

test('snap completes instantly and shrink snaps back', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(100, 0);
  assert.equal(pacer.snap(), 100);
  pacer.push(40, 10);
  assert.equal(pacer.sample(10), 40);
});