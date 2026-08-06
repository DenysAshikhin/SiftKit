import assert from 'node:assert/strict';
import test from 'node:test';

import { startStubStatusServer } from './_runtime-helpers.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { asObject, asObjectArray, requestJson, type Dict } from './helpers/dashboard-http.js';

async function startServerWithRuntime(namePrefix: string): Promise<{
  server: DashboardTestServer;
  close(): Promise<void>;
}> {
  const stub = await startStubStatusServer({});
  const server = await DashboardTestServer.start(
    namePrefix,
    { baseUrl: `http://127.0.0.1:${stub.port}`, model: 'stub-model' },
    { managedLlamaStartup: true },
  );
  return {
    server,
    async close(): Promise<void> {
      await server.close();
      await stub.close();
    },
  };
}

async function readConfigBody(baseUrl: string): Promise<Dict> {
  const response = await requestJson(`${baseUrl}/config?skip_ready=1`);
  assert.equal(response.statusCode, 200);
  return response.body;
}

async function readRuntimeStatus(baseUrl: string): Promise<Dict> {
  const response = await requestJson(`${baseUrl}/runtime/inference`);
  assert.equal(response.statusCode, 200);
  return response.body;
}

test('saving preset autoload files persists them without touching the inference runtime', async () => {
  const { server, close } = await startServerWithRuntime('siftkit-config-autoload-');
  try {
    const before = await readRuntimeStatus(server.baseUrl);
    const config = await readConfigBody(server.baseUrl);
    const presets = asObjectArray(config.Presets);
    const firstPreset = presets[0];
    assert.ok(firstPreset, 'expected at least one summary preset');
    firstPreset.autoloadFiles = ['C:\\repo\\AGENTS.md'];
    config.Presets = presets;

    const saved = await requestJson(`${server.baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    assert.equal(saved.statusCode, 200);

    const persisted = asObjectArray((await readConfigBody(server.baseUrl)).Presets);
    assert.deepEqual(persisted[0]?.autoloadFiles, ['C:\\repo\\AGENTS.md']);

    const after = await readRuntimeStatus(server.baseUrl);
    assert.deepEqual(after, before);
  } finally {
    await close();
  }
});

test('saving a different active model preset persists it without switching the running runtime', async () => {
  const { server, close } = await startServerWithRuntime('siftkit-config-preset-');
  try {
    const before = await readRuntimeStatus(server.baseUrl);
    const config = await readConfigBody(server.baseUrl);
    const modelPresets = asObject(asObject(config.Server).ModelPresets);
    const presets = asObjectArray(modelPresets.Presets);
    const activePreset = presets[0];
    assert.ok(activePreset, 'expected at least one model preset');
    modelPresets.Presets = [...presets, { ...activePreset, id: 'second-preset', label: 'Second preset' }];
    modelPresets.ActivePresetId = 'second-preset';

    const saved = await requestJson(`${server.baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    assert.equal(saved.statusCode, 200);

    const persisted = asObject(asObject((await readConfigBody(server.baseUrl)).Server).ModelPresets);
    assert.equal(persisted.ActivePresetId, 'second-preset');

    const after = await readRuntimeStatus(server.baseUrl);
    assert.equal(after.activePresetId, before.activePresetId);
    assert.equal(after.processState, before.processState);
    assert.equal(after.modelState, before.modelState);
  } finally {
    await close();
  }
});

test('PUT /config preserves zero CacheRam and CacheRecurrentRam', async () => {
  const { server, close } = await startServerWithRuntime('siftkit-config-cache-ram-');
  try {
    const config = await readConfigBody(server.baseUrl);
    const modelPresets = asObject(asObject(config.Server).ModelPresets);
    const presets = asObjectArray(modelPresets.Presets);
    const activePreset = presets[0];
    assert.ok(activePreset, 'expected at least one model preset');
    activePreset.CacheRam = 0;
    activePreset.CacheRecurrentRam = 0;

    const saved = await requestJson(`${server.baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    assert.equal(saved.statusCode, 200);

    const persisted = asObjectArray(asObject(asObject((await readConfigBody(server.baseUrl)).Server).ModelPresets).Presets);
    assert.equal(persisted[0]?.CacheRam, 0, 'CacheRam must persist as zero');
    assert.equal(persisted[0]?.CacheRecurrentRam, 0, 'CacheRecurrentRam must persist as zero');
  } finally {
    await close();
  }
});

test('rejects a config payload that normalization refuses', async () => {
  const server = await DashboardTestServer.start('siftkit-config-invalid-');
  try {
    const response = await requestJson(`${server.baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify({ Server: { LlamaCpp: {} } }),
    });

    assert.equal(response.statusCode, 400);
    assert.match(String(response.body.error), /Server\.LlamaCpp/u);
  } finally {
    await server.close();
  }
});
