import assert from 'node:assert/strict';
import test from 'node:test';
import { SiftConfigSchema } from '@siftkit/contracts';

import {
  asObject,
  asObjectArray,
  requestJson,
} from './helpers/dashboard-http.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';

test('config HTTP boundary creates defaults once and rejects invalid persisted catalogs', async () => {
  const fixture = await DashboardTestServer.start('siftkit-config-preset-http-');
  try {
    const initial = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`);
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(
      asObjectArray(initial.body.Presets).map((preset) => preset.id),
      ['summary', 'repo-search', 'chat', 'plan', 'repo-agent', 'orchestrator'],
    );

    const missingBuiltin = structuredClone(initial.body);
    missingBuiltin.Presets = asObjectArray(missingBuiltin.Presets)
      .filter((preset) => preset.id !== 'plan');
    const missingResponse = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(missingBuiltin),
    });
    assert.equal(missingResponse.statusCode, 400);
    assert.match(String(missingResponse.body.error ?? ''), /Missing built-in preset 'plan'\./u);

    const legacy = structuredClone(initial.body);
    const legacyPresets = asObjectArray(legacy.Presets);
    const legacySummary = asObject(legacyPresets[0]);
    const removedField = ['execution', 'Family'].join('');
    legacySummary[removedField] = 'summary';
    legacyPresets[0] = legacySummary;
    legacy.Presets = legacyPresets;
    const legacyResponse = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(legacy),
    });
    assert.equal(legacyResponse.statusCode, 400);
    assert.match(String(legacyResponse.body.error ?? ''), new RegExp(removedField, 'u'));

    const persisted = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`);
    assert.equal(persisted.statusCode, 200);
    assert.equal(
      asObjectArray(persisted.body.Presets).some((preset) => preset.id === 'plan'),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test('config HTTP boundary rejects a dangling operation model reference', async () => {
  const fixture = await DashboardTestServer.start('siftkit-config-preset-model-ref-');
  try {
    const initial = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`);
    assert.equal(initial.statusCode, 200);

    const payload = structuredClone(initial.body);
    const presets = asObjectArray(payload.Presets);
    const target = presets.find((preset) => preset.id === 'repo-search');
    assert.ok(target);
    target.modelPresetId = 'deleted-model';
    const response = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 400);
    assert.match(String(response.body.error ?? ''), /deleted-model/u);
  } finally {
    await fixture.close();
  }
});

test('config HTTP boundary persists explicit and current operation model choices', async () => {
  const fixture = await DashboardTestServer.start('siftkit-config-preset-model-persistence-');
  try {
    const initial = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`);
    assert.equal(initial.statusCode, 200);
    const config = SiftConfigSchema.parse(initial.body);
    const preset = config.Presets.find((entry) => entry.id === 'repo-search');
    assert.ok(preset);

    for (const modelPresetId of [config.Server.ModelPresets.ActivePresetId, null]) {
      preset.modelPresetId = modelPresetId;
      const saved = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`, {
        method: 'PUT',
        body: JSON.stringify(config),
      });
      assert.equal(saved.statusCode, 200);
      const reloaded = await requestJson(`${fixture.baseUrl}/config?skip_ready=1`);
      assert.equal(reloaded.statusCode, 200);
      const persisted = SiftConfigSchema.parse(reloaded.body);
      assert.equal(persisted.Presets.find((entry) => entry.id === preset.id)?.modelPresetId, modelPresetId);
    }
  } finally {
    await fixture.close();
  }
});
