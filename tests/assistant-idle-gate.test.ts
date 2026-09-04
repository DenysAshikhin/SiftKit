import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import {
  StatusServerIdleGate, evaluateIdleDecision, secondsSinceModelActivity,
} from '../src/status-server/assistant-idle-gate.js';
import { acquireModelRequest, releaseModelRequest } from '../src/status-server/server-ops.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './helpers/assistant-gates.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const idle = (secondsSinceMouseInput: number, secondsSinceKeyboardInput: number) => ({
  secondsSinceMouseInput, secondsSinceKeyboardInput,
});

test('idle requires mouse and keyboard quiet for the full threshold, mouse checked first', () => {
  assert.deepEqual(evaluateIdleDecision(false, idle(180, 180), 180, 500), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, idle(179, 500), 180, 500), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, idle(500, 179), 180, 500), {
    kind: 'blocked',
    reason: 'keyboard_idle_below_threshold',
    details: { keyboardIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, idle(0, 0), 180, 500), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 0, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, idle(500, 500), 180, 500), { kind: 'allowed' });
});

test('server busyness overrides reported input idleness', () => {
  assert.deepEqual(evaluateIdleDecision(true, idle(500, 500), 180, 500), {
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
  assert.deepEqual(evaluateIdleDecision(false, idle(0, 0), 0, 500), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(true, idle(0, 0), 0, 500), {
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
  assert.deepEqual(cache.readInputIdle(), idle(240, 300));

  clock.advanceSeconds(120);
  assert.equal(cache.readInputIdle(), null);
});

test('model quiet is checked after data availability and before the input signals', () => {
  const quiet = idle(500, 500);
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 180), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 179), {
    kind: 'blocked',
    reason: 'model_recently_active',
    details: { secondsSinceModelActivity: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, idle(0, 0), 180, 0), {
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

test('releasing a model request restarts the model quiet counter from the release time', () => {
  const ctx = createTestServerContext(path.join(createManagedTempDir('siftkit-idle-gate-'), 'runtime.sqlite'));
  ctx.terminalMetadata.serverStartedAtMs = Date.now() - 1_000_000;
  assert.ok(secondsSinceModelActivity(ctx.terminalMetadata, Date.now()) >= 1000);

  const lock = acquireModelRequest(ctx, 'test');
  assert.notEqual(lock, null);
  if (lock === null) return;
  assert.equal(releaseModelRequest(ctx, lock.token), true);

  assert.equal(secondsSinceModelActivity(ctx.terminalMetadata, Date.now()), 0);
});

test('the status-server gate wires the heartbeat, config threshold, server start, and busyness', () => {
  const runtimeRoot = createManagedTempDir('siftkit-idle-gate-wiring-');
  const ctx = createTestServerContext(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock('2026-09-02T09:00:00.000Z');
  const config = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true };
  const threshold = config.Background.IdleSecondsBeforeProcessing;
  const heartbeat = (secondsSinceMouseInput: number, secondsSinceKeyboardInput: number) => ({
    schemaVersion: 1 as const,
    capturedAtUtc: clock.nowUtc(),
    fullscreen: false, locked: false, doNotDisturb: false, presenting: false,
    excludedApplication: false,
    secondsSinceMouseInput, secondsSinceKeyboardInput,
    power: { kind: 'unavailable' as const },
  });
  try {
    const service = AssistantService.create({
      database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
      runtimeRoot,
      clock,
      ids: new SequentialIdGenerator(),
      configWriter: new MemoryAssistantConfigWriter(config),
      inference: new FakeAssistantInference([]),
      tokens: new EstimateTokenCounter(4),
      idleGate: ALWAYS_IDLE,
      residencyGate: ALWAYS_RESIDENT,
      config,
    });
    ctx.assistantControl = service;
    ctx.terminalMetadata.serverStartedAtMs = Date.now();
    const gate = new StatusServerIdleGate(ctx);

    assert.deepEqual(gate.evaluate(), {
      kind: 'blocked', reason: 'environment_heartbeat_missing', details: {},
    });

    service.ingestEnvironment(heartbeat(threshold, threshold));
    assert.deepEqual(gate.evaluate(), {
      kind: 'blocked',
      reason: 'model_recently_active',
      details: { secondsSinceModelActivity: 0, requiredIdleSeconds: threshold },
    });

    ctx.terminalMetadata.serverStartedAtMs = Date.now() - (threshold + 1) * 1000;
    assert.deepEqual(gate.evaluate(), { kind: 'allowed' });

    service.ingestEnvironment(heartbeat(threshold - 1, threshold));
    assert.deepEqual(gate.evaluate(), {
      kind: 'blocked',
      reason: 'mouse_idle_below_threshold',
      details: { mouseIdleSeconds: threshold - 1, requiredIdleSeconds: threshold },
    });

    const lock = acquireModelRequest(ctx, 'test');
    assert.ok(lock !== null);
    assert.deepEqual(gate.evaluate(), { kind: 'blocked', reason: 'server_busy', details: {} });
    assert.equal(releaseModelRequest(ctx, lock.token), true);
    service.ingestEnvironment(heartbeat(threshold, threshold));
    assert.deepEqual(gate.evaluate(), {
      kind: 'blocked',
      reason: 'model_recently_active',
      details: { secondsSinceModelActivity: 0, requiredIdleSeconds: threshold },
    });
  } finally {
    closeRuntimeDatabase();
  }
});
