import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { KeyCustodyStatusDtoSchema, KeyMaterialDtoSchema } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { getDefaultConfig, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { z } from '../src/lib/zod.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const AuditRowSchema = z.object({ event_type: z.string(), details_json: z.string() });

test('key custody routes migrate the evidence key to the desktop shell and fail closed', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-custody-');
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
    for (const route of ['/assistant/keys/custody', '/assistant/keys/export', '/assistant/keys/import']) {
      assert.equal((await requestJson(`${baseUrl}${route}`, { method: 'POST' })).statusCode, 401, route);
    }

    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const before = await requestJson(`${baseUrl}/assistant/keys/custody`, { headers });
    assert.equal(before.statusCode, 200);
    const beforeStatus = KeyCustodyStatusDtoSchema.parse(before.body);
    assert.equal(beforeStatus.custody, 'file');
    assert.equal(beforeStatus.imported, false);
    assert.equal(beforeStatus.activeKeyId, null, 'no key exists before first use');

    const exported = await requestJson(`${baseUrl}/assistant/keys/export`, { method: 'POST', headers });
    assert.equal(exported.statusCode, 200);
    const material = KeyMaterialDtoSchema.parse(exported.body);
    const afterExport = await requestJson(`${baseUrl}/assistant/keys/custody`, { headers });
    assert.equal(KeyCustodyStatusDtoSchema.parse(afterExport.body).activeKeyId, material.activeKeyId);

    const keyFilePath = assistantKeyFile(path.join(tempRoot, '.siftkit'));
    assert.ok(fs.existsSync(keyFilePath), keyFilePath);

    const imported = await requestJson(`${baseUrl}/assistant/keys/import`, {
      method: 'POST', headers, body: JSON.stringify(material),
    });
    assert.equal(imported.statusCode, 200);
    const importedStatus = KeyCustodyStatusDtoSchema.parse(imported.body);
    assert.equal(importedStatus.custody, 'desktop');
    assert.equal(importedStatus.imported, true);
    assert.equal(fs.existsSync(keyFilePath), false);
    assert.equal(readConfig(getConfigPath()).Assistant.KeyCustody, 'desktop');

    // Export is refused once the shell owns custody; re-import stays idempotent.
    assert.equal((await requestJson(`${baseUrl}/assistant/keys/export`, {
      method: 'POST', headers,
    })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/keys/import`, {
      method: 'POST', headers, body: JSON.stringify(material),
    })).statusCode, 200);

    // Evidence stays readable through the imported key.
    assert.equal((await requestJson(`${baseUrl}/assistant/evidence`, { headers })).statusCode, 200);

    const rejected = await requestJson(`${baseUrl}/assistant/keys/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...material, schemaVersion: 2 }),
    });
    assert.equal(rejected.statusCode, 400);

    const database = getRuntimeDatabase();
    const audits = z.array(AuditRowSchema).parse(database.prepare(
      "SELECT event_type, details_json FROM assistant_audit_events WHERE event_type = 'desktop_contract_rejected'",
    ).all());
    assert.equal(audits.length, 1);
    const secret = Object.values(material.keys)[0] ?? '';
    assert.ok(secret.length > 0);
    assert.equal(audits[0]?.details_json.includes(secret), false);
    assert.equal(audits[0]?.details_json.includes(material.activeKeyId), false);
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
