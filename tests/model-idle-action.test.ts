import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ModelRuntimePresetSchema } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { z } from '../src/lib/zod.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

const PresetsRowSchema = z.object({ server_model_presets_json: z.string() });

test('IdleAction schema rejects invalid values and accepts documented EXL3 values', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  assert.ok(preset);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, IdleAction: 'ram' }).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, IdleAction: 'hibernate' }).success, false);

  for (const idleAction of ['none', 'unload'] as const) {
    const config = {
      ...getDefaultConfigObject(),
      Server: {
        ...getDefaultConfigObject().Server,
        ModelPresets: {
          ...getDefaultConfigObject().Server.ModelPresets,
          Presets: getDefaultConfigObject().Server.ModelPresets.Presets.map((entry) => ({
            ...entry,
            Backend: 'exl3',
            IdleAction: idleAction,
          })),
        },
      },
    };
    assert.equal(normalizeConfigObject(config).Server.ModelPresets.Presets[0]?.IdleAction, idleAction);
  }
});

test('new model defaults explicitly persist unload', () => {
  assert.equal(getDefaultConfigObject().Server.ModelPresets.Presets[0]?.IdleAction, 'unload');
});

test('current config consumer rejects a persisted preset with missing IdleAction', () => {
  const dbPath = tempDbPath('siftkit-model-idle-action-current-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    const row = PresetsRowSchema.parse(database.prepare(
      'SELECT server_model_presets_json FROM app_config WHERE id = 1',
    ).get());
    const presets = z.array(JsonObjectSchema).parse(parseJsonValueText(row.server_model_presets_json));
    const first = presets[0];
    assert.ok(first && typeof first === 'object' && !Array.isArray(first));
    delete first.IdleAction;
    database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = 1')
      .run(JSON.stringify(presets));
    closeRuntimeDatabase();

    assert.throws(() => readConfig(dbPath), /IdleAction/u);
  } finally {
    closeRuntimeDatabase();
  }
});

test('current config consumer rejects removed residency actions without rewriting them', () => {
  const dbPath = tempDbPath('siftkit-model-idle-action-removed-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    const row = PresetsRowSchema.parse(database.prepare('SELECT server_model_presets_json FROM app_config WHERE id = 1').get());
    const presets = z.array(JsonObjectSchema).parse(parseJsonValueText(row.server_model_presets_json));
    const first = presets[0];
    assert.ok(first);
    first.IdleAction = 'freeze';
    const stored = JSON.stringify(presets);
    database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = 1').run(stored);
    closeRuntimeDatabase();
    assert.throws(() => readConfig(dbPath), /IdleAction/u);
    assert.equal(PresetsRowSchema.parse(getRuntimeDatabase(dbPath).prepare('SELECT server_model_presets_json FROM app_config WHERE id = 1').get()).server_model_presets_json, stored);
  } finally { closeRuntimeDatabase(); }
});
