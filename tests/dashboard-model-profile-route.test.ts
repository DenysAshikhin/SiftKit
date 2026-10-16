import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ModelProfileResponseSchema } from '@siftkit/contracts';
import { startStatusServer } from '../src/status-server/index.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getConfigPath } from '../src/config/index.ts';
import { asObject, getAddressInfo, requestJson } from './helpers/dashboard-http.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo } from './helpers/dashboard-test-repo.ts';

async function withStatusServer(run: (baseUrl: string, tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = createManagedTempDir('siftkit-model-profile-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(getConfigPath(), getDefaultServerConfig());
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  try {
    await run(`http://127.0.0.1:${getAddressInfo(server).port}`, tempRoot);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
}

function postProfile(baseUrl: string, body: string) {
  return requestJson(`${baseUrl}/dashboard/model-profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}

test('POST /dashboard/model-profile profiles the model directory it is given', async () => {
  await withStatusServer(async (baseUrl, tempRoot) => {
    const modelDirectory = path.join(tempRoot, 'GLM-5.3-Flash-3.00bpw-hq');
    fs.mkdirSync(modelDirectory);
    fs.writeFileSync(path.join(modelDirectory, 'config.json'), JSON.stringify({
      architectures: ['Glm5NextForConditionalGeneration'], text_config: { n_routed_experts: 288, kv_lora_rank: 512 },
    }));
    fs.writeFileSync(path.join(modelDirectory, 'chat_template.jinja'),
      "{%- set e = reasoning_effort if reasoning_effort in ['low', 'high'] else 'max' -%}");

    const response = await postProfile(baseUrl, JSON.stringify({ modelPath: modelDirectory }));

    assert.equal(response.statusCode, 200);
    const { profile } = ModelProfileResponseSchema.parse(response.body);
    assert.equal(profile.name, 'GLM-5.3-Flash-3.00bpw-hq');
    assert.equal(profile.moe, true);
    assert.equal(profile.mla, true);
    assert.deepEqual(profile.reasoningEfforts, ['low', 'high', 'max']);
  });
});

test('POST /dashboard/model-profile rejects a missing path and reports an unreadable directory', async () => {
  await withStatusServer(async (baseUrl, tempRoot) => {
    const missingPath = await postProfile(baseUrl, JSON.stringify({}));
    assert.equal(missingPath.statusCode, 400);
    assert.equal(asObject(missingPath.body).error, 'Expected a modelPath string.');

    const emptyDirectory = path.join(tempRoot, 'empty-model');
    fs.mkdirSync(emptyDirectory);
    const unreadable = await postProfile(baseUrl, JSON.stringify({ modelPath: emptyDirectory }));
    assert.equal(unreadable.statusCode, 422);
    assert.match(String(asObject(unreadable.body).error), /has no config\.json/u);
  });
});
