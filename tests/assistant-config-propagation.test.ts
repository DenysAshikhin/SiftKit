import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyMaterialDtoSchema } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, readConfig } from '../src/status-server/config-store.js';
import { z } from '../src/lib/zod.js';
import { requestJson } from './helpers/dashboard-http.js';
import { withAssistantServer } from './helpers/assistant-server-harness.js';

const AssistantViewSchema = z.object({
  assistant: z.object({ Enabled: z.boolean(), KeyCustody: z.string() }),
});

test('dashboard PUT /config enable reaches the live service and survives custody migration', async () => {
  await withAssistantServer('siftkit-assistant-config-prop-', getDefaultConfig().Assistant, async ({ baseUrl, headers }) => {
    const initialView = await requestJson(`${baseUrl}/assistant/config`, { headers });
    assert.equal(initialView.statusCode, 200);

    // The dashboard settings page persists through the general config endpoint, not the
    // assistant PATCH. The running service must still observe the change.
    const current = readConfig(getConfigPath());
    const saved = await requestJson(`${baseUrl}/config`, {
      method: 'PUT',
      body: JSON.stringify({ ...current, Assistant: { ...current.Assistant, Enabled: true } }),
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(readConfig(getConfigPath()).Assistant.Enabled, true);

    const liveView = await requestJson(`${baseUrl}/assistant/config`, { headers });
    assert.equal(liveView.statusCode, 200);
    assert.equal(
      AssistantViewSchema.parse(liveView.body).assistant.Enabled,
      true,
      'PUT /config must refresh the running assistant service',
    );

    // First shell connect runs the one-time custody migration (export then import). The flip
    // must only touch KeyCustody: the enable persisted above has to survive it.
    const exported = await requestJson(`${baseUrl}/assistant/keys/export`, { method: 'POST', headers });
    assert.equal(exported.statusCode, 200);
    const material = KeyMaterialDtoSchema.parse(exported.body);
    const imported = await requestJson(`${baseUrl}/assistant/keys/import`, {
      method: 'POST', headers, body: JSON.stringify(material),
    });
    assert.equal(imported.statusCode, 200);

    const persisted = readConfig(getConfigPath()).Assistant;
    assert.equal(persisted.KeyCustody, 'desktop');
    assert.equal(persisted.Enabled, true, 'custody migration must not clobber the enabled flag');

    const afterMigration = await requestJson(`${baseUrl}/assistant/config`, { headers });
    const afterBlock = AssistantViewSchema.parse(afterMigration.body).assistant;
    assert.equal(afterBlock.Enabled, true);
    assert.equal(afterBlock.KeyCustody, 'desktop');
  });
});
