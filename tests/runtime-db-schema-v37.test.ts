import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { ModelRuntimePresetSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { createAppConfigMigrationFixture } from './helpers/app-config-migration-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const SnapshotRowSchema = z.object({ model_preset_json: z.string() });
const ColumnNameRowSchema = z.object({ name: z.string() });
const LEGACY_PRESETS_COLUMN = ['server_ll', 'ama_presets_json'].join('');
const LEGACY_ACTIVE_PRESET_COLUMN = ['server_ll', 'ama_active_preset_id'].join('');

type SeedSession = {
  id: string;
  modelPresetId: string;
  model: string | null;
  contextWindowTokens: number;
};

function seedV36Database(sessions: SeedSession[]): string {
  const tempRoot = createManagedTempDir('sk-v37-');
  const dbPath = path.join(tempRoot, 'runtime.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 36);
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_preset_id TEXT NOT NULL,
      model TEXT,
      context_window_tokens INTEGER NOT NULL,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      web_search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_search_enabled IN (0, 1)),
      preset_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
      plan_repo_root TEXT NOT NULL,
      condensed_summary TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
  `);
  createAppConfigMigrationFixture(database);
  database.prepare(`
    INSERT INTO app_config (id, ${LEGACY_PRESETS_COLUMN}, ${LEGACY_ACTIVE_PRESET_COLUMN})
    VALUES (1, ?, ?)
  `).run(
    JSON.stringify([
      mockModelPreset({ id: 'active', Model: 'active-model', Temperature: 0.11 }),
      mockModelPreset({ id: 'historical', Model: 'historical-model', Temperature: 0.42 }),
    ]),
    'active',
  );
  const insertSession = database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model, context_window_tokens, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
      created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 'chat', 'chat', '.', '', '2026-01-01', '2026-01-01')
  `);
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.id,
      session.modelPresetId,
      session.model,
      session.contextWindowTokens,
    );
  }
  database.close();
  return dbPath;
}

function readSnapshot(dbPath: string, sessionId: string): ReturnType<typeof ModelRuntimePresetSchema.parse> {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = SnapshotRowSchema.parse(
      database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(sessionId),
    );
    return ModelRuntimePresetSchema.parse(parseJsonValueText(row.model_preset_json));
  } finally {
    database.close();
  }
}

function readColumnNames(dbPath: string): string[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return z.array(ColumnNameRowSchema)
      .parse(database.prepare('PRAGMA table_info(chat_sessions);').all())
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

function removeSeedDatabase(dbPath: string): void {
  closeRuntimeDatabase();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

test('v37 migration snapshots the session preset with its historical model and context size', () => {
  const dbPath = seedV36Database([
    { id: 'historical-session', modelPresetId: 'historical', model: 'pinned-model', contextWindowTokens: 30_000 },
  ]);

  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const snapshot = readSnapshot(dbPath, 'historical-session');
    assert.equal(snapshot.id, 'historical');
    assert.equal(snapshot.Temperature, 0.42);
    assert.equal(snapshot.Model, 'pinned-model');
    assert.equal(snapshot.NumCtx, 30_000);

    const columns = readColumnNames(dbPath);
    assert.equal(columns.includes('model_preset_json'), true);
    assert.equal(columns.includes('model'), false);
    assert.equal(columns.includes('context_window_tokens'), false);
  } finally {
    removeSeedDatabase(dbPath);
  }
});

test('v37 migration falls back to the active preset when the session preset is gone', () => {
  const dbPath = seedV36Database([
    { id: 'orphan-session', modelPresetId: 'deleted-preset', model: null, contextWindowTokens: 12_000 },
  ]);

  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const snapshot = readSnapshot(dbPath, 'orphan-session');
    assert.equal(snapshot.id, 'active');
    // No stored model means the preset's own model stands.
    assert.equal(snapshot.Model, 'active-model');
    assert.equal(snapshot.NumCtx, 12_000);
  } finally {
    removeSeedDatabase(dbPath);
  }
});

test('v37 migration leaves a session-free database at the current schema', () => {
  const dbPath = seedV36Database([]);

  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const columns = readColumnNames(dbPath);
    assert.equal(columns.includes('model_preset_json'), true);
    assert.equal(columns.includes('context_window_tokens'), false);
    // The default preset list is unrelated to the migration; assert it still parses.
    assert.equal(getDefaultConfigObject().Server.ModelPresets.Presets.length > 0, true);
  } finally {
    removeSeedDatabase(dbPath);
  }
});
