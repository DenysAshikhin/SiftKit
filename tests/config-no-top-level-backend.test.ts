import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getBuiltinPresets } from '../src/presets.js';
import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';

const ColumnNameRowSchema = z.array(z.object({ name: z.string() }));
const VersionRowSchema = z.object({ version: z.number() });
const PresetsJsonRowSchema = z.object({ presets_json: z.string() });

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

function readPresetsJson(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return PresetsJsonRowSchema
      .parse(db.prepare('SELECT presets_json FROM app_config WHERE id = 1').get())
      .presets_json;
  } finally {
    db.close();
  }
}

function seedVersion35AppConfig(dbPath: string, presetsJson: string): void {
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO runtime_schema (id, version) VALUES (1, 35);
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
      include_agents_md INTEGER NOT NULL DEFAULT 1 CHECK (include_agents_md IN (0, 1)),
      include_repo_file_listing INTEGER NOT NULL DEFAULT 1 CHECK (include_repo_file_listing IN (0, 1)),
      expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1)),
      prompt_prefix TEXT,
      runtime_model TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
      server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
      server_llama_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1)),
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL,
      presets_json TEXT NOT NULL,
      web_search_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );
  `);
  seed.prepare(`
    INSERT INTO app_config (
      id, version, policy_mode, raw_log_retention, include_agents_md,
      include_repo_file_listing, expand_reads, prompt_prefix, runtime_model,
      thresholds_min_characters_for_summary, thresholds_min_lines_for_summary,
      interactive_enabled, interactive_wrapped_commands_json, interactive_idle_timeout_ms,
      interactive_max_transcript_characters, interactive_transcript_retention,
      server_llama_presets_json, server_llama_active_preset_id,
      server_external_server_enabled, inference_json, server_exl3_json,
      operation_mode_allowed_tools_json, presets_json, web_search_json, updated_at_utc
    ) VALUES (
      1, '0.1.0', 'conservative', 1, 0,
      0, 1, NULL, NULL,
      500, 16,
      1, '[]', 900000,
      60000, 1,
      '[]', NULL,
      0, '{}', '{}',
      '{}', ?, '{}', '2026-07-28T00:00:00.000Z'
    )
  `).run(presetsJson);
  seed.close();
}

test('default config has no top-level Backend field', () => {
  assert.equal('Backend' in getDefaultConfigObject(), false);
});

test('normalization drops any provided top-level Backend', () => {
  const normalized = normalizeConfigObject({ Backend: 'llama.cpp' });
  assert.equal('Backend' in normalized, false);
});

test('canonical config has no global startup-context switches', () => {
  const config = getDefaultConfigObject();
  assert.equal(Object.hasOwn(config, 'IncludeAgentsMd'), false);
  assert.equal(Object.hasOwn(config, 'IncludeRepoFileListing'), false);
});

test('a fresh database is created at the current schema without the backend column', () => {
  const dbPath = tempDbPath('sk-current-fresh-');
  getRuntimeDatabase(dbPath);
  assert.equal(columnNames(dbPath).includes('backend'), false);
  assert.equal(schemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
});

test('schema 36 removes startup-context columns and preserves preset autoload files', () => {
  const dbPath = tempDbPath('sk-v35-context-migrate-');
  seedVersion35AppConfig(dbPath, JSON.stringify([{
    ...getBuiltinPresets()[0],
    autoloadFiles: ['C:\\shared\\policy.md'],
  }]));

  getRuntimeDatabase(dbPath);

  const columns = columnNames(dbPath);
  assert.equal(columns.includes('include_agents_md'), false);
  assert.equal(columns.includes('include_repo_file_listing'), false);
  assert.equal(schemaVersion(dbPath), 36);
  assert.match(readPresetsJson(dbPath), /C:\\\\shared\\\\policy\.md/u);
});

test('v31 migration drops the legacy backend column before advancing to the current schema', () => {
  const dbPath = tempDbPath('sk-v31-migrate-');
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
  assert.equal(schemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
});
