import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AssistantErrorResponseSchema, AssistantRunJobResponseSchema } from '@siftkit/contracts';
import { SystemClock } from '../src/assistant/clock.ts';
import { RandomIdGenerator } from '../src/assistant/ids.ts';
import { VAULT_MAINTENANCE_REQUEST } from '../src/assistant/jobs/job-types.ts';
import { JobStore } from '../src/assistant/storage/job-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { getConfigPath } from '../src/config/index.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.ts';
import { startStatusServer } from '../src/status-server/index.ts';
import {
  closeHttpServer, getAddressInfo, requestJson,
} from './helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';

test('assistant HTTP surface bootstraps locally, enforces bearer auth, and serves the vault surface', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-routes-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await requestJson(`${baseUrl}/assistant/status`)).statusCode, 401);
    assert.equal((await requestJson(`${baseUrl}/assistant/auth/bootstrap`, {
      headers: { Origin: 'https://evil.example' },
    })).statusCode, 403);
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    assert.equal(bootstrap.statusCode, 200);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    assert.ok(token.length > 20);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await requestJson(`${baseUrl}/assistant/status`, {
      headers: { Authorization: 'Bearer wrong' },
    })).statusCode, 401);

    for (const route of [
      '/assistant/status', '/assistant/config', '/assistant/background-decisions',
      '/assistant/captures/pending', '/assistant/desktop/state', '/assistant/vault/tree',
      '/assistant/vault/notes', '/assistant/vault/search?q=PowerShell', '/assistant/vault/stats',
    ]) {
      const response = await requestJson(`${baseUrl}${route}`, { headers });
      assert.equal(response.statusCode, 200, route);
    }
    assert.equal((await requestJson(`${baseUrl}/assistant/vault/tree`)).statusCode, 401);
    for (const route of [
      '/assistant/search?q=PowerShell', '/assistant/graph/nodes', '/assistant/graph/assertions',
      '/assistant/evidence', '/assistant/projections', '/assistant/questions/current',
      '/assistant/policies', '/assistant/validation', '/assistant/history', '/assistant/cleanup/preview',
      '/assistant/capture/start', '/assistant/ingest/raw', '/assistant/export', '/assistant/backup',
      '/assistant/not-a-route',
    ]) {
      assert.equal((await requestJson(`${baseUrl}${route}`, { headers })).statusCode, 404, route);
    }

    const paused = {
      ...initial.Assistant,
      Enabled: false,
    };
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: JSON.stringify({ assistant: paused }),
    })).statusCode, 200);
    const status = await requestJson(`${baseUrl}/assistant/status`, { headers });
    assert.equal(status.body.enabled, false);
    assert.equal((await requestJson(`${baseUrl}/assistant/vault/tree`, { headers })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers, body: '{',
    })).statusCode, 400);
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

test('a known path with a wrong method responds 404, not a hang', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-method-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const response = await requestJson(`${baseUrl}/assistant/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
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

test('POST /assistant/jobs/run forces one queued job past the idle gate', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-run-job-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const run = (body: string) => requestJson(`${baseUrl}/assistant/jobs/run`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
    });

    const empty = await run('{}');
    assert.equal(empty.statusCode, 409);
    assert.equal(AssistantErrorResponseSchema.parse(empty.body).error.code, 'no_queued_job');
    assert.equal((await run(JSON.stringify({ jobId: 'job_missing' }))).statusCode, 404);
    assert.equal((await run(JSON.stringify({ jobId: 'job_missing', extra: true }))).statusCode, 400);

    // No desktop heartbeat reaches this server, so only a forced run can execute the job.
    const jobs = new JobStore(getRuntimeDatabase(), new SystemClock(), new RandomIdGenerator());
    const job = jobs.enqueue(LOCAL_OWNER_ID, VAULT_MAINTENANCE_REQUEST, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities);
    assert.ok(job !== null);
    const forced = await run(JSON.stringify({ jobId: job.id }));
    assert.equal(forced.statusCode, 200);
    assert.deepEqual(AssistantRunJobResponseSchema.parse(forced.body), {
      jobId: job.id, jobType: 'vault_maintenance', outcome: 'completed', detail: null,
    });
    assert.equal(jobs.countByStatus(LOCAL_OWNER_ID, 'completed'), 1);
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
