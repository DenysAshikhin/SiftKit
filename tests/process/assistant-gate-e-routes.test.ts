import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  AssistantFactoryResetPreviewSchema, AssistantRestorePreviewResponseSchema, AssistantRestoreResultSchema,
} from '@siftkit/contracts';
import { AssistantGraph } from '../../src/assistant/assistant-graph.ts';
import { FixedClock } from '../../src/assistant/clock.ts';
import { FileKeyProvider } from '../../src/assistant/crypto/key-provider.ts';
import { SequentialIdGenerator } from '../../src/assistant/ids.ts';
import { assistantKeyFile } from '../../src/assistant/layout.ts';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.ts';
import { readArchiveEntriesFromBytes } from '../helpers/archive-bytes.ts';
import { getConfigPath } from '../../src/config/index.ts';
import { getDefaultConfig, readConfig, writeConfig } from '../../src/status-server/config-store.ts';
import { startStatusServer } from '../../src/status-server/index.ts';
import { getRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { FIXTURE_START_INSTANT, type AssistantTestContext } from '../helpers/assistant-fixture.ts';
import {
  closeHttpServer, getAddressInfo, requestBinary, requestJson,
} from '../helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from '../helpers/dashboard-test-repo.ts';
import { seedOwnerAssertion } from '../helpers/gate-e-seed.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.ts';
import { InMemoryDataProtector } from '../helpers/in-memory-data-protector.ts';

/**
 * A second view over the server's own runtime database, used only to seed rows and read them
 * back. The server's service mints random ids, so a sequential generator here cannot collide.
 */
function contextFor(runtimeRoot: string): AssistantTestContext {
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(FIXTURE_START_INSTANT);
  const ids = new SequentialIdGenerator();
  return {
    database, clock, ids, ownerId: LOCAL_OWNER_ID, runtimeRoot,
    graph: new AssistantGraph({
      database, clock, ids,
      keys: new FileKeyProvider(assistantKeyFile(runtimeRoot)),
      runtimeRoot,
    }),
  };
}

test('the Gate E routes serve maintenance and transfer end to end, and the retired routes are gone', async () => {
  const tempRoot = createManagedTempDir('siftkit-gate-e-routes-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial, Assistant: { ...initial.Assistant, Enabled: true },
  });
  const server = startStatusServer({ disableManagedEngineStartup: true, dataProtector: new InMemoryDataProtector() });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const runtimeRoot = path.join(tempRoot, '.siftkit');

  try {
    const context = contextFor(runtimeRoot);
    const kappa = seedOwnerAssertion(context, { objectName: 'Kappa Tool' });

    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    // Taken before any deletion, so the restore at the end has something to prove.
    const backup = await requestBinary(`${baseUrl}/assistant/backup`, { method: 'POST', headers });
    assert.equal(backup.statusCode, 200);
    assert.equal(backup.contentType, 'application/zip');
    const backupEntries = await readArchiveEntriesFromBytes(backup.body);
    assert.ok(backupEntries.has('snapshot.sqlite'));
    assert.ok(backupEntries.has('manifest.json'));

    const exportBytes = await requestBinary(`${baseUrl}/assistant/export`, {
      method: 'POST', headers,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ includeDecryptedBlobs: false }), 'utf8'),
    });
    assert.equal(exportBytes.statusCode, 200);
    assert.equal(exportBytes.contentType, 'application/zip');
    assert.ok((await readArchiveEntriesFromBytes(exportBytes.body)).has('manifest.json'));

    for (const retired of ['/assistant/evidence', '/assistant/graph/nodes', '/assistant/questions/current', '/assistant/validation', '/assistant/history']) {
      assert.equal((await requestJson(`${baseUrl}${retired}`, { headers })).statusCode, 404, `${retired} is retired`);
    }
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/mobile`, {
      method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1 }),
    })).statusCode, 404);

    // Maintenance sits above the enabled gate: turning the assistant off must not strand a
    // user who wants their data erased or restored.
    const enabledConfig = readConfig(getConfigPath()).Assistant;
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ assistant: { ...enabledConfig, Enabled: false } }),
    })).statusCode, 200);

    const resetPreview = await requestJson(`${baseUrl}/assistant/factory-reset/preview`, { headers });
    assert.equal(resetPreview.statusCode, 200);
    const reset = AssistantFactoryResetPreviewSchema.parse(resetPreview.body);
    assert.ok((reset.tableCounts.graph_assertions ?? 0) > 0);

    assert.equal((await requestJson(`${baseUrl}/assistant/factory-reset`, {
      method: 'POST', headers, body: JSON.stringify({ previewToken: reset.previewToken }),
    })).statusCode, 200);
    assert.equal(context.graph.assertions.list(LOCAL_OWNER_ID, 10, 0).length, 0);

    // Restore brings the pre-deletion graph back, through the same two-step contract.
    const restorePreview = await requestBinary(`${baseUrl}/assistant/restore-preview`, {
      method: 'POST', headers, body: backup.body,
    });
    assert.equal(restorePreview.statusCode, 200);
    const upload = AssistantRestorePreviewResponseSchema.parse(
      JSON.parse(restorePreview.body.toString('utf8')),
    );

    assert.equal((await requestJson(`${baseUrl}/assistant/restore`, {
      method: 'POST', headers,
      body: JSON.stringify({ uploadId: upload.uploadId, confirmToken: 'not-the-token' }),
    })).statusCode, 409);

    const restored = await requestJson(`${baseUrl}/assistant/restore`, {
      method: 'POST', headers,
      body: JSON.stringify({ uploadId: upload.uploadId, confirmToken: upload.confirmToken }),
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(AssistantRestoreResultSchema.parse(restored.body).ok, true);
    assert.equal(
      context.graph.assertions.requireAssertion(kappa.assertion.id).status, 'active',
    );
    assert.equal(context.graph.evidence.getEvidence(kappa.evidenceId)?.status, 'active');

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
