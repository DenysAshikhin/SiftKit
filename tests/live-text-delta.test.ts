import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_TEXT_FLUSH_MAX_LATENCY_MS,
  LIVE_TEXT_FLUSH_MAX_PENDING_CHARS,
  LiveTextDeltaTracker,
} from '../src/status-server/live-text-delta.js';

test('merges contiguous snapshots into one pending delta and flushes on latency', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'ab', 0);
  assert.equal(tracker.takeDue(10, false), null);
  tracker.pushSnapshot(1, 'abcd', 50);
  assert.deepEqual(tracker.takeDue(LIVE_TEXT_FLUSH_MAX_LATENCY_MS, false), { turn: 1, offset: 0, text: 'abcd' });
  tracker.pushSnapshot(1, 'abcdef', 130);
  assert.deepEqual(tracker.takeDue(130, true), { turn: 1, offset: 4, text: 'ef' });
});

test('flushes when the pending delta reaches the size threshold', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'a'.repeat(LIVE_TEXT_FLUSH_MAX_PENDING_CHARS), 0);
  assert.deepEqual(tracker.takeDue(0, false), {
    turn: 1,
    offset: 0,
    text: 'a'.repeat(LIVE_TEXT_FLUSH_MAX_PENDING_CHARS),
  });
});

test('a turn change pends a keyframe that replaces anything pending', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'turn one', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'turn one' });
  tracker.pushSnapshot(1, 'turn one more', 10);
  tracker.pushSnapshot(2, 'turn two', 20);
  assert.deepEqual(tracker.takeDue(20, true), { turn: 2, offset: 0, text: 'turn two' });
});

test('a shrink of the source snapshot pends a keyframe', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'abcdef', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'abcdef' });
  tracker.pushSnapshot(1, 'abc', 10);
  assert.deepEqual(tracker.takeDue(10, true), { turn: 1, offset: 0, text: 'abc' });
});

test('unchanged snapshots emit nothing', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'abc', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'abc' });
  tracker.pushSnapshot(1, 'abc', 10);
  assert.equal(tracker.hasPending(), false);
  assert.equal(tracker.takeDue(500, true), null);
});