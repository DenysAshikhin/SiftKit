import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';
import { z } from '../src/lib/zod.js';
import {
  ModelRuntimePresetSchema,
} from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { CURRENT_SCHEMA_VERSION, closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const PresetsJsonRowSchema = z.object({ presets_json: z.string() });
const SchemaVersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function missingIdleActionPresets(): JsonValue {
  return JsonValueSchema.parse(getDefaultConfigObject().Server.ModelPresets.Presets.map((preset) => {
    const { IdleAction: _idleAction, ...withoutIdleAction } = preset;
    return withoutIdleAction;
  }));
}

function seedMissingIdleActionConfig(dbPath: string): void {
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  database.prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1').run(
    JSON.stringify(missingIdleActionPresets()),
  );
  database.prepare('UPDATE runtime_schema SET version = 46 WHERE id = 1').run();
  closeRuntimeDatabase();
}

function configWithoutIdleAction(): JsonObject {
  const config = JsonObjectSchema.parse(JsonValueSchema.parse(getDefaultConfigObject()));
  const server = JsonObjectSchema.parse(config.Server);
  const modelPresets = JsonObjectSchema.parse(server.ModelPresets);
  const presets = z.array(JsonObjectSchema).parse(modelPresets.Presets).map((preset) => {
    const { IdleAction: _idleAction, ...withoutIdleAction } = preset;
    return withoutIdleAction;
  });
  config.Server = {
    ...server,
    ModelPresets: { ...modelPresets, Presets: presets },
  };
  return config;
}

function seedAllMissingIdleActionSnapshots(dbPath: string): void {
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  const preset = JsonObjectSchema.parse(JsonValueSchema.parse(
    getDefaultConfigObject().Server.ModelPresets.Presets[0],
  ));
  delete preset.IdleAction;
  const timestamp = '2026-01-01T00:00:00.000Z';
  const originalConfig = configWithoutIdleAction();
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', ?, 0, 1, NULL, 'chat', '.', ?, ?)
  `).run(JSON.stringify(preset), timestamp, timestamp);
  database.prepare(`
    INSERT INTO benchmark_sessions (
      id, status, question_preset_count, case_count, repetitions,
      current_case_index, current_prompt_index, current_repeat_index,
      restore_status, restore_error, original_config_json,
      started_at_utc, completed_at_utc, updated_at_utc
    ) VALUES ('benchmark-session-1', 'completed', 1, 1, 1, NULL, NULL, NULL, 'completed', NULL, ?, ?, NULL, ?)
  `).run(JSON.stringify(originalConfig), timestamp, timestamp);
  database.prepare(`
    INSERT INTO benchmark_cases (
      id, session_id, case_index, label, managed_preset_id, managed_preset_label,
      managed_preset_json, spec_override_json, created_at_utc
    ) VALUES ('benchmark-case-1', 'benchmark-session-1', 0, 'Case', 'default', 'Default', ?, '{}', ?)
  `).run(JSON.stringify(preset), timestamp);
  database.prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1').run(
    JSON.stringify(missingIdleActionPresets()),
  );
  database.prepare('UPDATE runtime_schema SET version = 46 WHERE id = 1').run();
  closeRuntimeDatabase();
}

function readSnapshotRows(dbPath: string): {
  appPresets: string;
  chatPreset: string;
  benchmarkConfig: string;
  benchmarkPreset: string;
} {
  const database = new Database(dbPath, { readonly: true });
  try {
    return {
      appPresets: z.object({ value: z.string() }).parse(
        database.prepare('SELECT server_llama_presets_json AS value FROM app_config WHERE id = 1').get(),
      ).value,
      chatPreset: z.object({ value: z.string() }).parse(
        database.prepare('SELECT model_preset_json AS value FROM chat_sessions WHERE id = ?').get('session-1'),
      ).value,
      benchmarkConfig: z.object({ value: z.string() }).parse(
        database.prepare('SELECT original_config_json AS value FROM benchmark_sessions WHERE id = ?').get('benchmark-session-1'),
      ).value,
      benchmarkPreset: z.object({ value: z.string() }).parse(
        database.prepare('SELECT managed_preset_json AS value FROM benchmark_cases WHERE id = ?').get('benchmark-case-1'),
      ).value,
    };
  } finally {
    database.close();
  }
}

function readStoredPresets(dbPath: string): JsonObject[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = PresetsJsonRowSchema.parse(
      database.prepare('SELECT server_llama_presets_json AS presets_json FROM app_config WHERE id = 1').get(),
    );
    const value = parseJsonValueText(row.presets_json);
    return z.array(JsonObjectSchema).parse(value);
  } finally {
    database.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    return SchemaVersionRowSchema.parse(
      database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    ).version;
  } finally {
    database.close();
  }
}

test('v47 migrates every missing IdleAction to unload and persists it once', () => {
  const dbPath = tempDbPath('sk-idle-action-migrate-');
  try {
    seedMissingIdleActionConfig(dbPath);

    const migrated = readConfig(dbPath);
    assert.equal(migrated.Server.ModelPresets.Presets.every((preset) => preset.IdleAction === 'unload'), true);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
    const persisted = readStoredPresets(dbPath);
    assert.equal(persisted.every((preset) => preset.IdleAction === 'unload'), true);
    const persistedBeforeSecondRead = JSON.stringify(persisted);

    readConfig(dbPath);

    assert.equal(JSON.stringify(readStoredPresets(dbPath)), persistedBeforeSecondRead);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 migration preserves unrelated preset fields and records', () => {
  const dbPath = tempDbPath('sk-idle-action-preserve-');
  try {
    seedMissingIdleActionConfig(dbPath);
    const before = readStoredPresets(dbPath).map((preset) => {
      const { IdleAction: _idleAction, ...withoutIdleAction } = preset;
      return withoutIdleAction;
    });

    readConfig(dbPath);

    const after = readStoredPresets(dbPath).map((preset) => {
      const { IdleAction: _idleAction, ...withoutIdleAction } = preset;
      return withoutIdleAction;
    });
    assert.deepEqual(after, before);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 migrates persisted chat-session preset snapshots before they are read', () => {
  const dbPath = tempDbPath('sk-idle-action-session-migrate-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
    if (!preset) throw new Error('Expected a default model preset.');
    const { IdleAction: _idleAction, ...withoutIdleAction } = preset;
    database.prepare(`
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root,
        created_at_utc, updated_at_utc
      ) VALUES ('session-1', 'Session', 'default', ?, 0, 1, NULL, 'chat', '.', '2026-01-01', '2026-01-01')
    `).run(JSON.stringify(withoutIdleAction));
    database.prepare('UPDATE runtime_schema SET version = 46 WHERE id = 1').run();
    closeRuntimeDatabase();

    readConfig(dbPath);

    const migratedDatabase = new Database(dbPath, { readonly: true });
    try {
      const row = z.object({ model_preset_json: z.string() }).parse(
        migratedDatabase.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get('session-1'),
      );
      const migratedPreset = JsonObjectSchema.parse(parseJsonValueText(row.model_preset_json));
      assert.equal(migratedPreset.IdleAction, 'unload');
    } finally {
      migratedDatabase.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 migrates benchmark session configs and case preset snapshots in the same transaction', () => {
  const dbPath = tempDbPath('sk-idle-action-benchmark-migrate-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);

    readConfig(dbPath);

    const rows = readSnapshotRows(dbPath);
    const benchmarkConfig = JsonObjectSchema.parse(parseJsonValueText(rows.benchmarkConfig));
    const server = JsonObjectSchema.parse(benchmarkConfig.Server);
    const modelPresets = JsonObjectSchema.parse(server.ModelPresets);
    const configPreset = z.array(JsonObjectSchema).parse(modelPresets.Presets)[0];
    const benchmarkPreset = JsonObjectSchema.parse(parseJsonValueText(rows.benchmarkPreset));
    assert.equal(configPreset?.IdleAction, 'unload');
    assert.equal(benchmarkPreset.IdleAction, 'unload');
    assert.equal(JsonObjectSchema.parse(parseJsonValueText(rows.chatPreset)).IdleAction, 'unload');
    assert.equal(z.array(JsonObjectSchema).parse(parseJsonValueText(rows.appPresets))[0]?.IdleAction, 'unload');
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 leaves pre-ModelPresets benchmark snapshots unchanged and still migrates the rest', () => {
  const dbPath = tempDbPath('sk-idle-action-legacy-benchmark-config-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);
    const legacyLlamaCppConfig = JSON.stringify({
      Version: '0.1.0',
      Backend: 'llama.cpp',
      Server: { LlamaCpp: { Port: 8080 } },
    });
    const legacyNoServerConfig = JSON.stringify({ Version: '0.1.0' });
    const database = new Database(dbPath);
    database.prepare('UPDATE benchmark_sessions SET original_config_json = ? WHERE id = ?')
      .run(legacyLlamaCppConfig, 'benchmark-session-1');
    database.prepare(`
      INSERT INTO benchmark_sessions (
        id, status, question_preset_count, case_count, repetitions,
        current_case_index, current_prompt_index, current_repeat_index,
        restore_status, restore_error, original_config_json,
        started_at_utc, completed_at_utc, updated_at_utc
      ) VALUES ('benchmark-session-2', 'completed', 1, 1, 1, NULL, NULL, NULL, 'completed', NULL, ?, '2026-01-01', NULL, '2026-01-01')
    `).run(legacyNoServerConfig);
    database.close();

    readConfig(dbPath);

    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
    const after = readSnapshotRows(dbPath);
    assert.equal(after.benchmarkConfig, legacyLlamaCppConfig);
    const readonlyDatabase = new Database(dbPath, { readonly: true });
    try {
      const secondRow = z.object({ value: z.string() }).parse(
        readonlyDatabase.prepare('SELECT original_config_json AS value FROM benchmark_sessions WHERE id = ?').get('benchmark-session-2'),
      );
      assert.equal(secondRow.value, legacyNoServerConfig);
    } finally {
      readonlyDatabase.close();
    }
    assert.equal(JsonObjectSchema.parse(parseJsonValueText(after.chatPreset)).IdleAction, 'unload');
    assert.equal(JsonObjectSchema.parse(parseJsonValueText(after.benchmarkPreset)).IdleAction, 'unload');
    assert.equal(z.array(JsonObjectSchema).parse(parseJsonValueText(after.appPresets))[0]?.IdleAction, 'unload');
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 rejects malformed app preset JSON without advancing or partially updating snapshots', () => {
  const dbPath = tempDbPath('sk-idle-action-malformed-app-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);
    const before = readSnapshotRows(dbPath);
    const database = new Database(dbPath);
    database.prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1').run('{ broken json');
    database.close();

    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.equal(readSchemaVersion(dbPath), 46);
    const after = readSnapshotRows(dbPath);
    assert.equal(after.appPresets, '{ broken json');
    assert.equal(after.chatPreset, before.chatPreset);
    assert.equal(after.benchmarkConfig, before.benchmarkConfig);
    assert.equal(after.benchmarkPreset, before.benchmarkPreset);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 rejects non-object app preset records without advancing or partially updating snapshots', () => {
  const dbPath = tempDbPath('sk-idle-action-invalid-app-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);
    const before = readSnapshotRows(dbPath);
    const appPresets = JSON.stringify([
      z.array(JsonObjectSchema).parse(parseJsonValueText(before.appPresets))[0],
      null,
    ]);
    const database = new Database(dbPath);
    database.prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1').run(appPresets);
    database.close();

    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.equal(readSchemaVersion(dbPath), 46);
    const after = readSnapshotRows(dbPath);
    assert.equal(after.appPresets, appPresets);
    assert.equal(after.chatPreset, before.chatPreset);
    assert.equal(after.benchmarkConfig, before.benchmarkConfig);
    assert.equal(after.benchmarkPreset, before.benchmarkPreset);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 rejects malformed benchmark session config JSON without partial updates', () => {
  const dbPath = tempDbPath('sk-idle-action-malformed-benchmark-config-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);
    const before = readSnapshotRows(dbPath);
    const database = new Database(dbPath);
    database.prepare('UPDATE benchmark_sessions SET original_config_json = ? WHERE id = ?')
      .run('{ broken json', 'benchmark-session-1');
    database.close();

    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.equal(readSchemaVersion(dbPath), 46);
    const after = readSnapshotRows(dbPath);
    assert.equal(after.benchmarkConfig, '{ broken json');
    assert.equal(after.appPresets, before.appPresets);
    assert.equal(after.chatPreset, before.chatPreset);
    assert.equal(after.benchmarkPreset, before.benchmarkPreset);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v47 rejects a non-object benchmark case preset without partial updates', () => {
  const dbPath = tempDbPath('sk-idle-action-invalid-benchmark-case-');
  try {
    seedAllMissingIdleActionSnapshots(dbPath);
    const before = readSnapshotRows(dbPath);
    const database = new Database(dbPath);
    database.prepare('UPDATE benchmark_cases SET managed_preset_json = ? WHERE id = ?')
      .run('[]', 'benchmark-case-1');
    database.close();

    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.equal(readSchemaVersion(dbPath), 46);
    const after = readSnapshotRows(dbPath);
    assert.equal(after.benchmarkPreset, '[]');
    assert.equal(after.appPresets, before.appPresets);
    assert.equal(after.chatPreset, before.chatPreset);
    assert.equal(after.benchmarkConfig, before.benchmarkConfig);
  } finally {
    closeRuntimeDatabase();
  }
});

test('after v47, a newly missing IdleAction fails loudly', () => {
  const dbPath = tempDbPath('sk-idle-action-post-marker-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    const row = PresetsJsonRowSchema.parse(
      database.prepare('SELECT server_llama_presets_json AS presets_json FROM app_config WHERE id = 1').get(),
    );
    const presets = z.array(JsonObjectSchema).parse(parseJsonValueText(row.presets_json));
    const first = presets[0];
    if (!first) throw new Error('Expected a default model preset.');
    delete first.IdleAction;
    database.prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1').run(JSON.stringify(presets));
    closeRuntimeDatabase();

    assert.throws(() => readConfig(dbPath), /IdleAction/u);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a failed v47 migration write surfaces and leaves the marker incomplete', () => {
  const dbPath = tempDbPath('sk-idle-action-write-failure-');
  try {
    seedMissingIdleActionConfig(dbPath);
    const database = new Database(dbPath);
    database.exec(`
      CREATE TRIGGER reject_idle_action_migration
      BEFORE UPDATE OF server_llama_presets_json ON app_config
      BEGIN
        SELECT RAISE(ABORT, 'migration write blocked');
      END;
    `);
    database.close();

    assert.throws(() => getRuntimeDatabase(dbPath), /migration write blocked/u);
    assert.equal(readSchemaVersion(dbPath), 46);

    const unlocked = new Database(dbPath);
    unlocked.exec('DROP TRIGGER reject_idle_action_migration');
    unlocked.close();
    readConfig(dbPath);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('IdleAction schema rejects ram and other invalid values', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Expected a default model preset.');
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, IdleAction: 'ram' }).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, IdleAction: 'hibernate' }).success, false);
});

test('EXL3 accepts all documented IdleAction values', () => {
  const base = getDefaultConfigObject();
  for (const IdleAction of ['none', 'freeze', 'unload'] as const) {
    const exl3 = {
      ...base,
      Server: {
        ...base.Server,
        ModelPresets: {
          ...base.Server.ModelPresets,
          Presets: base.Server.ModelPresets.Presets.map((preset) => ({
            ...preset,
            Backend: 'exl3',
            IdleAction,
          })),
        },
      },
    };
    assert.equal(normalizeConfigObject(exl3).Server.ModelPresets.Presets[0]?.IdleAction, IdleAction);
  }
});

test('new defaults explicitly persist unload', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  assert.equal(preset?.IdleAction, 'unload');
});
