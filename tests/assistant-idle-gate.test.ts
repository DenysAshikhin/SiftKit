import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateIdle } from '../src/status-server/assistant-idle-gate.js';

test('idle requires shell-reported input quiet for the full threshold', () => {
  assert.equal(evaluateIdle(false, 180, 180), true);
  assert.equal(evaluateIdle(false, 179, 180), false);
  assert.equal(evaluateIdle(false, 500, 180), true);
});

test('server busyness overrides reported input idleness', () => {
  assert.equal(evaluateIdle(true, 500, 180), false);
});

test('missing shell input data means not idle, never a fallback path', () => {
  assert.equal(evaluateIdle(false, null, 180), false);
  assert.equal(evaluateIdle(true, null, 180), false);
});

test('a zero threshold drains as soon as input stops and the server is quiet', () => {
  assert.equal(evaluateIdle(false, 0, 0), true);
  assert.equal(evaluateIdle(true, 0, 0), false);
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
