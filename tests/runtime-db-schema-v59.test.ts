import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';

import { LEGACY_MODEL_PRESETS_COLUMN, LEGACY_ACTIVE_MODEL_PRESET_COLUMN, LEGACY_ENGINE_SNAPSHOT_KEY, LEGACY_ENGINE_CONFIG_KEY } from '../src/state/migrations/constants.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import { z } from '../src/lib/zod.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { ensureRunLogsTable } from '../src/status-server/dashboard-runs/table.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
  migrateDatabaseFile,
  CURRENT_SCHEMA_VERSION,
} from '../src/state/runtime-db.js';
import {
  createManagedTempDir,
  removeDirectoryWithRetries,
} from './helpers/temp-dirs.js';

const NumberValueRowSchema = z.object({ value: z.number() });
const StringValueRowSchema = z.object({ value: z.string() });

function withoutMaxTokens(value: string): JsonObject {
  const parsed = JsonObjectSchema.parse(parseJsonValueText(value));
  assert.equal(Object.hasOwn(parsed, 'MaxTokens'), false);
  return parsed;
}

test('v59 strips model MaxTokens from executable state but preserves historical run evidence', async () => {
  const tempRoot = createManagedTempDir('sk-v59-max-tokens-');
  const dbPath = path.join(tempRoot, 'runtime.sqlite');
  const presets = [
    {
      id: 'one',
      label: 'One',
      Backend: 'exl3',
      Model: 'one.exl3',
      NumCtx: 155_000,
      MaxTokens: 15_000,
    },
    {
      id: 'two',
      label: 'Two',
      Backend: 'exl3',
      Model: 'two.exl3',
      NumCtx: 32_000,
      MaxTokens: 4_096,
    },
  ];
  const sessionPreset = { ...presets[0], Temperature: 0.6 };
  const launchSnapshot = {
    Model: 'one.exl3',
    [LEGACY_ENGINE_CONFIG_KEY]: { NumCtx: 155_000, MaxTokens: 15_000, Temperature: 0.6 },
  };
  const historicalPresetJson = JSON.stringify({
    ...presets[1],
    evidence: 'immutable',
  });

  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    database.exec(`ALTER TABLE app_config RENAME COLUMN server_model_presets_json TO ${LEGACY_MODEL_PRESETS_COLUMN}; ALTER TABLE app_config RENAME COLUMN server_model_active_preset_id TO ${LEGACY_ACTIVE_MODEL_PRESET_COLUMN};`);
    database
      .prepare(
        `
      UPDATE app_config
      SET ${LEGACY_MODEL_PRESETS_COLUMN} = ?, ${LEGACY_ACTIVE_MODEL_PRESET_COLUMN} = 'one'
      WHERE id = 1
    `,
      )
      .run(JSON.stringify(presets));
    database
      .prepare(
        `
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
      ) VALUES ('session', 'Session', 'one', ?, 0, 0, NULL, 'chat', '', ?, ?)
    `,
      )
      .run(
        JSON.stringify(sessionPreset),
        '2026-09-02T00:00:00.000Z',
        '2026-09-02T00:00:00.000Z',
      );
    database
      .prepare(
        `
      INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES ('${LEGACY_ENGINE_SNAPSHOT_KEY}', ?, ?)
    `,
      )
      .run(JSON.stringify(launchSnapshot), '2026-09-02T00:00:00.000Z');
    ensureRunLogsTable(database);
    database
      .prepare(
        `
      INSERT INTO run_logs (
        run_id, request_id, run_kind, run_group, terminal_state, title,
        model_preset_json, flushed_at_utc
      ) VALUES ('historical', 'historical', 'chat', 'chat', 'completed', 'Historical', ?, ?)
    `,
      )
      .run(historicalPresetJson, '2026-09-02T00:00:00.000Z');
    database
      .prepare('UPDATE runtime_schema SET version = 58 WHERE id = 1')
      .run();
    closeRuntimeDatabase();
    migrateDatabaseFile(dbPath);
    closeRuntimeDatabase();

    const migrated = new Database(dbPath, { readonly: true });
    try {
      const version = NumberValueRowSchema.parse(
        migrated
          .prepare('SELECT version AS value FROM runtime_schema WHERE id = 1')
          .get(),
      ).value;
      assert.equal(version, CURRENT_SCHEMA_VERSION);

      const presetJson = StringValueRowSchema.parse(
        migrated
          .prepare(
            'SELECT server_model_presets_json AS value FROM app_config WHERE id = 1',
          )
          .get(),
      ).value;
      const migratedPresets = parseJsonValueText(presetJson);
      assert.ok(Array.isArray(migratedPresets));
      assert.deepEqual(migratedPresets, [
        { id: 'one', label: 'One', Backend: 'exl3', Model: 'one.exl3', NumCtx: 155_000 },
        { id: 'two', label: 'Two', Backend: 'exl3', Model: 'two.exl3', NumCtx: 32_000 },
      ]);

      const migratedSession = StringValueRowSchema.parse(
        migrated
          .prepare(
            "SELECT model_preset_json AS value FROM chat_sessions WHERE id = 'session'",
          )
          .get(),
      ).value;
      assert.deepEqual(withoutMaxTokens(migratedSession), {
        id: 'one',
        label: 'One',
        Backend: 'exl3',
        Model: 'one.exl3',
        NumCtx: 155_000,
        Temperature: 0.6,
      });

      const migratedLaunch = migrated.prepare(
        `SELECT value FROM runtime_metadata WHERE key = '${LEGACY_ENGINE_SNAPSHOT_KEY}'`,
      ).get();
      assert.equal(migratedLaunch, undefined);

      const historical = StringValueRowSchema.parse(
        migrated
          .prepare(
            "SELECT model_preset_json AS value FROM run_logs WHERE run_id = 'historical'",
          )
          .get(),
      ).value;
      assert.equal(historical, historicalPresetJson);
    } finally {
      migrated.close();
    }
  } finally {
    closeRuntimeDatabase();
    await removeDirectoryWithRetries(tempRoot);
  }
});
