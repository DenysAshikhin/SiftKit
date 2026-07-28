import assert from 'node:assert/strict';
import test from 'node:test';

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
      ['summary', 'repo-search', 'chat', 'plan', 'repo-agent'],
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
