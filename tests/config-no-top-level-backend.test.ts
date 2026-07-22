import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));
const VersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ColumnNameRowSchema
      .parse(db.prepare("SELECT name FROM pragma_table_info('app_config')").all())
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function schemaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return VersionRowSchema.parse(db.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version;
  } finally {
    db.close();
  }
}

test('default config has no top-level Backend field', () => {
  assert.equal('Backend' in getDefaultConfigObject(), false);
});

test('normalization drops any provided top-level Backend', () => {
  const normalized = normalizeConfigObject({ Backend: 'llama.cpp' });
  assert.equal('Backend' in normalized, false);
});

test('a fresh database is created at v34 without the backend column', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 34);
  const dbPath = tempDbPath('sk-v34-fresh-');
  getRuntimeDatabase(dbPath);
  assert.equal(columnNames(dbPath).includes('backend'), false);
  assert.equal(schemaVersion(dbPath), 34);
});

test('v31 migration drops the legacy backend column before advancing to v34', () => {
  const dbPath = tempDbPath('sk-v32-migrate-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 31);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      backend TEXT NOT NULL,
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL,
      include_agents_md INTEGER NOT NULL DEFAULT 1,
      include_repo_file_listing INTEGER NOT NULL DEFAULT 1,
      prompt_prefix TEXT,
      runtime_model TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL,
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL,
      server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
      server_llama_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0,
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{}',
      presets_json TEXT NOT NULL DEFAULT '[]',
      web_search_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );
    INSERT INTO app_config (
      id, version, backend, policy_mode, raw_log_retention,
      thresholds_min_characters_for_summary, thresholds_min_lines_for_summary,
      interactive_enabled, interactive_wrapped_commands_json, interactive_idle_timeout_ms,
      interactive_max_transcript_characters, interactive_transcript_retention,
      presets_json, updated_at_utc
    ) VALUES (
      1, '0.1.0', 'llama.cpp', 'conservative', 1,
      500, 16,
      1, '[]', 900000,
      60000, 1,
      '[]', '2026-07-21T00:00:00.000Z'
    );
  `);
  seed.close();

  getRuntimeDatabase(dbPath);

  assert.equal(columnNames(dbPath).includes('backend'), false);
  assert.equal(schemaVersion(dbPath), 34);
});
