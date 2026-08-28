import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateIdle, QuietWindowTracker } from '../src/status-server/assistant-idle-gate.js';

const T0 = 1_000_000;
const SECOND = 1000;

test('a fresh tracker is not idle until the quiet window has fully elapsed', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(tracker.isIdle(false, 180, T0), false);
  assert.equal(tracker.isIdle(false, 180, T0 + 179 * SECOND), false);
  assert.equal(tracker.isIdle(false, 180, T0 + 180 * SECOND), true);
});

test('observed busyness restarts the quiet window', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(tracker.isIdle(true, 180, T0 + 170 * SECOND), false);
  assert.equal(tracker.isIdle(false, 180, T0 + 180 * SECOND), false);
  assert.equal(tracker.isIdle(false, 180, T0 + 350 * SECOND), true);
});

test('reported activity between polls restarts the quiet window', () => {
  const tracker = new QuietWindowTracker(T0);
  tracker.noteActivity(T0 + 100 * SECOND);

  assert.equal(tracker.isIdle(false, 180, T0 + 180 * SECOND), false);
  assert.equal(tracker.isIdle(false, 180, T0 + 280 * SECOND), true);
});

test('a zero threshold preserves drain-as-soon-as-quiet behavior', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(tracker.isIdle(false, 0, T0), true);
  assert.equal(tracker.isIdle(true, 0, T0), false);
});

test('a threshold change applies to the already-running window', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(tracker.isIdle(false, 180, T0 + 60 * SECOND), false);
  assert.equal(tracker.isIdle(false, 30, T0 + 60 * SECOND), true);
});

test('the status server gate reads the configured idle threshold live', () => {
  const gateSource = fs.readFileSync(path.join('src', 'status-server', 'assistant-idle-gate.ts'), 'utf8');

  assert.match(gateSource, /IdleSecondsBeforeProcessing/u);
  assert.match(gateSource, /QuietWindowTracker/u);
  assert.match(gateSource, /noteActivity/u);
});

test('every incoming model request stamps the idle gate', () => {
  const opsSource = fs.readFileSync(path.join('src', 'status-server', 'server-ops.ts'), 'utf8');

  assert.match(opsSource, /assistantIdleGate.*noteActivity/u);
});

test('reported keyboard/mouse idleness alone decides when the shell is reporting', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(evaluateIdle(tracker, false, 200, 180, T0), true);
  assert.equal(evaluateIdle(tracker, false, 40, 180, T0 + 400 * SECOND), false);
});

test('server busyness overrides reported input idleness', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(evaluateIdle(tracker, true, 500, 180, T0), false);
});

test('without shell input data the quiet window fallback decides', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(evaluateIdle(tracker, false, null, 180, T0 + 100 * SECOND), false);
  assert.equal(evaluateIdle(tracker, false, null, 180, T0 + 180 * SECOND), true);
});

test('busyness during input-driven mode still resets the fallback window', () => {
  const tracker = new QuietWindowTracker(T0);

  assert.equal(evaluateIdle(tracker, true, 500, 180, T0 + 100 * SECOND), false);
  assert.equal(evaluateIdle(tracker, false, null, 180, T0 + 200 * SECOND), false);
  assert.equal(evaluateIdle(tracker, false, null, 180, T0 + 280 * SECOND), true);
});

test('the environment cache exposes input idleness only while heartbeats are fresh', async () => {
  const { DesktopEnvironmentCache } = await import('../src/assistant/observation/environment-cache.js');
  const { FixedClock } = await import('../src/assistant/clock.js');
  const clock = new FixedClock('2026-08-28T09:00:00.000Z');
  const cache = new DesktopEnvironmentCache(clock);

  assert.equal(cache.readInputIdleSeconds(), null);

  cache.ingest({
    schemaVersion: 1,
    capturedAtUtc: clock.nowUtc(),
    fullscreen: false,
    locked: false,
    doNotDisturb: false,
    presenting: false,
    excludedApplication: false,
    secondsSinceInput: 240,
    power: { kind: 'unavailable' },
  });
  assert.equal(cache.readInputIdleSeconds(), 240);

  clock.advanceSeconds(120);
  assert.equal(cache.readInputIdleSeconds(), null);
});
