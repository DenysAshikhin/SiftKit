import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { EnvironmentStateDto } from '@siftkit/contracts';
import { FixedClock } from '../src/assistant/clock.js';
import { DesktopEnvironmentCache } from '../src/assistant/observation/environment-cache.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const CAPTURED_AT = '2026-08-10T14:00:00.000Z';

function environmentDto(overrides: Partial<EnvironmentStateDto> = {}): EnvironmentStateDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: CAPTURED_AT,
    fullscreen: false,
    locked: false,
    doNotDisturb: false,
    presenting: false,
    excludedApplication: false,
    secondsSinceInput: 4,
    power: { kind: 'available', onBattery: false, batteryPercent: 87 },
    ...overrides,
  };
}

function localTimeOf(clock: FixedClock): string {
  const now = new Date(clock.nowEpochMs());
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

test('an empty cache reports both seams unavailable', () => {
  const cache = new DesktopEnvironmentCache(new FixedClock(CAPTURED_AT));
  assert.equal(cache.read().kind, 'unavailable');
  assert.equal(cache.power.read().kind, 'unavailable');
});

test('fresh environment state feeds both providers', () => {
  const clock = new FixedClock(CAPTURED_AT);
  const cache = new DesktopEnvironmentCache(clock);
  cache.ingest(environmentDto({ doNotDisturb: true, secondsSinceInput: 12 }));

  const environment = cache.read();
  assert.equal(environment.kind, 'available');
  if (environment.kind !== 'available') return;
  assert.equal(environment.nowUtc, clock.nowUtc());
  assert.equal(environment.localTime, localTimeOf(clock));
  assert.equal(environment.doNotDisturb, true);
  assert.equal(environment.secondsSinceInput, 12);
  assert.equal(environment.fullscreen, false);
  assert.equal(environment.locked, false);
  assert.equal(environment.presenting, false);
  assert.equal(environment.excludedApplication, false);

  assert.deepEqual(cache.power.read(), { kind: 'available', onBattery: false, batteryPercent: 87 });
});

test('an unavailable power branch stays unavailable while the environment is still fresh', () => {
  const clock = new FixedClock(CAPTURED_AT);
  const cache = new DesktopEnvironmentCache(clock);
  cache.ingest(environmentDto({ power: { kind: 'unavailable' } }));
  assert.equal(cache.read().kind, 'available');
  assert.deepEqual(cache.power.read(), { kind: 'unavailable' });
});

test('stale environment state is unavailable on both seams', () => {
  const clock = new FixedClock(CAPTURED_AT);
  const cache = new DesktopEnvironmentCache(clock);
  cache.ingest(environmentDto());

  clock.advanceSeconds(59);
  assert.equal(cache.read().kind, 'available');

  clock.advanceSeconds(2);
  assert.equal(cache.read().kind, 'unavailable');
  assert.equal(cache.power.read().kind, 'unavailable');

  cache.ingest(environmentDto());
  assert.equal(cache.read().kind, 'available');
  assert.equal(cache.power.read().kind, 'available');
});

test('the staleness deadline is configurable', () => {
  const clock = new FixedClock(CAPTURED_AT);
  const cache = new DesktopEnvironmentCache(clock, 10);
  cache.ingest(environmentDto());
  clock.advanceSeconds(11);
  assert.equal(cache.read().kind, 'unavailable');
});

test('the local clock time reflects the clock, not the captured instant', () => {
  const clock = new FixedClock(CAPTURED_AT);
  const cache = new DesktopEnvironmentCache(clock);
  cache.ingest(environmentDto());
  clock.advanceSeconds(30);
  const environment = cache.read();
  assert.equal(environment.kind, 'available');
  if (environment.kind !== 'available') return;
  assert.equal(environment.nowUtc, clock.nowUtc());
  assert.equal(environment.localTime, localTimeOf(clock));
});

test('the ingestion route requires the bearer, fails closed on version, and rejects while disabled', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-env-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), { ...initial, Assistant: { ...initial.Assistant, Enabled: true } });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const body = JSON.stringify(environmentDto());
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/environment`, {
      method: 'POST', body,
    })).statusCode, 401);

    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/environment`, {
      method: 'POST', headers, body,
    })).statusCode, 200);
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/environment`, {
      method: 'POST', headers, body: JSON.stringify({ ...environmentDto(), schemaVersion: 2 }),
    })).statusCode, 400);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ assistant: { ...initial.Assistant, Enabled: false } }),
    })).statusCode, 200);
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/environment`, {
      method: 'POST', headers, body,
    })).statusCode, 409);
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
