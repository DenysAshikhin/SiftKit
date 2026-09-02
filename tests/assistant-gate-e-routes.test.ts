import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  AssistantEvidenceDeletionPreviewSchema, AssistantFactoryResetPreviewSchema,
  AssistantRestorePreviewResponseSchema, AssistantRestoreResultSchema,
  AssistantTopicForgetPreviewSchema,
} from '@siftkit/contracts';
import { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { FixedClock } from '../src/assistant/clock.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { readArchiveEntriesFromBytes } from './helpers/archive-bytes.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { FIXTURE_START_INSTANT, type AssistantTestContext } from './helpers/assistant-fixture.js';
import {
  closeHttpServer, getAddressInfo, requestBinary, requestJson,
} from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import {
  TEST_DEVICE_ID, seedTestDevice, signEnvelope, unsignedEnvelope,
} from './helpers/mobile-envelope.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

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

test('the Gate E routes serve deletion, maintenance, transfer, and mobile end to end', async () => {
  const tempRoot = createManagedTempDir('siftkit-gate-e-routes-');
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
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const runtimeRoot = path.join(tempRoot, '.siftkit');

  try {
    const context = contextFor(runtimeRoot);
    const kappa = seedOwnerAssertion(context, { objectName: 'Kappa Tool' });
    const lambda = seedOwnerAssertion(context, { objectName: 'Lambda Tool' });

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

    // Evidence deletion: preview, then a 404 for an id this owner does not have, then a
    // stale token, then the real thing.
    const evidencePreview = await requestJson(
      `${baseUrl}/assistant/evidence/${kappa.evidenceId}/deletion-preview`, { headers },
    );
    assert.equal(evidencePreview.statusCode, 200);
    const preview = AssistantEvidenceDeletionPreviewSchema.parse(evidencePreview.body);
    assert.equal(preview.targetEvidenceId, kappa.evidenceId);
    assert.deepEqual(preview.dependentAssertionIds, [kappa.assertion.id]);

    assert.equal((await requestJson(
      `${baseUrl}/assistant/evidence/ev_nonexistent/deletion-preview`, { headers },
    )).statusCode, 404);

    assert.equal((await requestJson(`${baseUrl}/assistant/evidence/${kappa.evidenceId}`, {
      method: 'DELETE', headers, body: JSON.stringify({ previewToken: 'not-a-token' }),
    })).statusCode, 400, 'an unsigned token is a malformed request');

    // A real token, issued for a different record: signed, current, and still refused.
    const otherPreview = AssistantEvidenceDeletionPreviewSchema.parse((await requestJson(
      `${baseUrl}/assistant/evidence/${lambda.evidenceId}/deletion-preview`, { headers },
    )).body);
    assert.equal((await requestJson(`${baseUrl}/assistant/evidence/${kappa.evidenceId}`, {
      method: 'DELETE', headers,
      body: JSON.stringify({ previewToken: otherPreview.previewToken }),
    })).statusCode, 409, 'a preview token for another record is a conflict');

    const deleted = await requestJson(`${baseUrl}/assistant/evidence/${kappa.evidenceId}`, {
      method: 'DELETE', headers, body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(context.graph.evidence.getEvidence(kappa.evidenceId)?.status, 'deleted');

    // Forget a topic.
    const topicPreview = await requestJson(`${baseUrl}/assistant/topics/forget-preview`, {
      method: 'POST', headers, body: JSON.stringify({ topicKey: lambda.topicKey }),
    });
    assert.equal(topicPreview.statusCode, 200);
    const topic = AssistantTopicForgetPreviewSchema.parse(topicPreview.body);
    assert.deepEqual(topic.assertionIds, [lambda.assertion.id]);

    // An evidence-deletion token cannot be spent on a topic, however well signed it is.
    assert.equal((await requestJson(`${baseUrl}/assistant/topics/forget`, {
      method: 'POST', headers,
      body: JSON.stringify({
        topicKey: lambda.topicKey, addPolicy: false, previewToken: otherPreview.previewToken,
      }),
    })).statusCode, 409);

    const forgot = await requestJson(`${baseUrl}/assistant/topics/forget`, {
      method: 'POST', headers,
      body: JSON.stringify({
        topicKey: lambda.topicKey, addPolicy: true, previewToken: topic.previewToken,
      }),
    });
    assert.equal(forgot.statusCode, 200);
    assert.equal(
      context.graph.assertions.requireAssertion(lambda.assertion.id).status, 'deleted',
    );

    // §7.6: the mobile route is indistinguishable from absent while the flag is off.
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
    assert.equal((await requestJson(`${baseUrl}/assistant/evidence`, { headers })).statusCode, 409);

    const resetPreview = await requestJson(`${baseUrl}/assistant/factory-reset/preview`, { headers });
    assert.equal(resetPreview.statusCode, 200);
    const reset = AssistantFactoryResetPreviewSchema.parse(resetPreview.body);
    assert.ok((reset.tableCounts.graph_assertions ?? 0) > 0);

    assert.equal((await requestJson(`${baseUrl}/assistant/factory-reset`, {
      method: 'POST', headers,
      body: JSON.stringify({ previewToken: otherPreview.previewToken }),
    })).statusCode, 409, 'a deletion token does not authorize a factory reset');

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

    // With the flag on but the assistant off, mobile is no longer hidden — it is refused for
    // the honest reason.
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        assistant: { ...enabledConfig, Enabled: false, Mobile: { Enabled: true } },
      }),
    })).statusCode, 200);
    const mobile = await requestJson(`${baseUrl}/assistant/ingest/mobile`, {
      method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1 }),
    });
    assert.equal(mobile.statusCode, 409);

    // Enabled on both axes: an unenrolled device is refused, an enrolled one is accepted.
    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        assistant: { ...enabledConfig, Enabled: true, Mobile: { Enabled: true } },
      }),
    })).statusCode, 200);

    const envelope = signEnvelope(unsignedEnvelope());
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/mobile`, {
      method: 'POST', headers, body: JSON.stringify(envelope),
    })).statusCode, 403, 'an unenrolled device is refused');

    seedTestDevice(context.graph.devices, LOCAL_OWNER_ID);
    const accepted = await requestJson(`${baseUrl}/assistant/ingest/mobile`, {
      method: 'POST', headers, body: JSON.stringify(envelope),
    });
    assert.equal(accepted.statusCode, 202);
    assert.notEqual(
      context.graph.evidence.findBySourceEventId(
        LOCAL_OWNER_ID, `mobile:${TEST_DEVICE_ID}:${envelope.nonce}`,
      ),
      null,
    );
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
