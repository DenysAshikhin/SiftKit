import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateIdleDecision, secondsSinceModelActivity,
} from '../src/status-server/assistant-idle-gate.js';

test('idle requires mouse and keyboard quiet for the full threshold, mouse checked first', () => {
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 180, keyboard: 180 }, 180, 500), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 179, keyboard: 500 }, 180, 500), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 500, keyboard: 179 }, 180, 500), {
    kind: 'blocked',
    reason: 'keyboard_idle_below_threshold',
    details: { keyboardIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 180, 500), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 0, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 500, keyboard: 500 }, 180, 500), { kind: 'allowed' });
});

test('server busyness overrides reported input idleness', () => {
  assert.deepEqual(evaluateIdleDecision(true, { mouse: 500, keyboard: 500 }, 180, 500), {
    kind: 'blocked', reason: 'server_busy', details: {},
  });
});

test('missing shell input data means not idle, never a fallback path', () => {
  assert.deepEqual(evaluateIdleDecision(false, null, 180, 500), {
    kind: 'blocked', reason: 'environment_heartbeat_missing', details: {},
  });
  assert.deepEqual(evaluateIdleDecision(true, null, 180, 500), {
    kind: 'blocked', reason: 'server_busy', details: {},
  });
});

test('a zero threshold drains as soon as input stops and the server is quiet', () => {
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 0, 500), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(true, { mouse: 0, keyboard: 0 }, 0, 500), {
    kind: 'blocked', reason: 'server_busy', details: {},
  });
});

test('the gate has no quiet-window fallback and reads the configured threshold', () => {
  const gateSource = fs.readFileSync(path.join('src', 'status-server', 'assistant-idle-gate.ts'), 'utf8');

  assert.match(gateSource, /IdleSecondsBeforeProcessing/u);
  assert.doesNotMatch(gateSource, /QuietWindowTracker/u);
  assert.doesNotMatch(gateSource, /noteActivity/u);
});

test('no server code stamps or references the removed idle-gate activity plumbing', () => {
  for (const file of ['server-ops.ts', 'server-types.ts', 'index.ts']) {
    const source = fs.readFileSync(path.join('src', 'status-server', file), 'utf8');
    assert.doesNotMatch(source, /assistantIdleGate/u, file);
  }
});

test('the environment cache exposes both input signals only while heartbeats are fresh', async () => {
  const { DesktopEnvironmentCache } = await import('../src/assistant/observation/environment-cache.js');
  const { FixedClock } = await import('../src/assistant/clock.js');
  const clock = new FixedClock('2026-08-28T09:00:00.000Z');
  const cache = new DesktopEnvironmentCache(clock);

  assert.equal(cache.readInputIdle(), null);

  cache.ingest({
    schemaVersion: 1,
    capturedAtUtc: clock.nowUtc(),
    fullscreen: false,
    locked: false,
    doNotDisturb: false,
    presenting: false,
    excludedApplication: false,
    secondsSinceMouseInput: 240,
    secondsSinceKeyboardInput: 300,
    power: { kind: 'unavailable' },
  });
  assert.deepEqual(cache.readInputIdle(), { mouse: 240, keyboard: 300 });

  clock.advanceSeconds(120);
  assert.equal(cache.readInputIdle(), null);
});

test('model quiet is checked after data availability and before the input signals', () => {
  const quiet = { mouse: 500, keyboard: 500 };
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 180), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 179), {
    kind: 'blocked',
    reason: 'model_recently_active',
    details: { secondsSinceModelActivity: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 180, 0), {
    kind: 'blocked',
    reason: 'model_recently_active',
    details: { secondsSinceModelActivity: 0, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, null, 180, 0), {
    kind: 'blocked', reason: 'environment_heartbeat_missing', details: {},
  });
  assert.deepEqual(evaluateIdleDecision(true, null, 180, 0), {
    kind: 'blocked', reason: 'server_busy', details: {},
  });
});

test('model activity is measured from server start until the first request finishes', () => {
  const startedAtMs = 1_000_000;
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: null, serverStartedAtMs: startedAtMs }, startedAtMs + 179_999,
  ), 179);
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: null, serverStartedAtMs: startedAtMs }, startedAtMs + 180_000,
  ), 180);
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: startedAtMs + 500_000, serverStartedAtMs: startedAtMs },
    startedAtMs + 530_000,
  ), 30);
});
