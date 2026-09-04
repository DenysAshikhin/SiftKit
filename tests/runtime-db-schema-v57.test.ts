import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { LEGACY_MODEL_PRESETS_COLUMN, LEGACY_ACTIVE_MODEL_PRESET_COLUMN } from '../src/state/migrations/constants.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { z } from '../src/lib/zod.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase, CURRENT_SCHEMA_VERSION, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const IdentityRowSchema = z.object({
  run_id: z.string(),
  run_kind: z.string(),
  operation_type: z.string().nullable(),
  operation_preset_id: z.string().nullable(),
  model_preset_id: z.string().nullable(),
  operation_preset_json: z.string().nullable(),
  model_preset_json: z.string().nullable(),
});
const VersionRowSchema = z.object({ version: z.number() });

/** The run_logs table as the pre-identity `ensureRunLogsTable` created it: no identity columns. */
const V56_RUN_LOGS_DDL = `
  CREATE TABLE run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    run_kind TEXT NOT NULL
      CHECK (run_kind IN ('summary_request','failed_request','request_abandoned','repo_search','chat','plan','unknown')),
    run_group TEXT NOT NULL
      CHECK (run_group IN ('summary','repo_search','planner','chat','other')),
    terminal_state TEXT NOT NULL
      CHECK (terminal_state IN ('completed','failed','abandoned','unknown')),
    started_at_utc TEXT,
    finished_at_utc TEXT,
    title TEXT NOT NULL,
    model TEXT,
    backend TEXT,
    repo_root TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    thinking_tokens INTEGER,
    tool_tokens INTEGER,
    prompt_cache_tokens INTEGER,
    prompt_eval_tokens INTEGER,
    duration_ms INTEGER,
    request_json TEXT,
    planner_debug_json TEXT,
    failed_request_json TEXT,
    abandoned_request_json TEXT,
    repo_search_json TEXT,
    repo_search_transcript_jsonl TEXT,
    source_paths_json TEXT NOT NULL DEFAULT '[]',
    flushed_at_utc TEXT NOT NULL,
    source_deleted_at_utc TEXT
  );
`;

const LEGACY_ROWS: { runId: string; runKind: string; runGroup: string; terminalState: string }[] = [
  { runId: 'legacy-summary', runKind: 'summary_request', runGroup: 'summary', terminalState: 'completed' },
  { runId: 'legacy-plan', runKind: 'plan', runGroup: 'planner', terminalState: 'completed' },
  { runId: 'legacy-chat', runKind: 'chat', runGroup: 'chat', terminalState: 'completed' },
  { runId: 'legacy-repo-search', runKind: 'repo_search', runGroup: 'repo_search', terminalState: 'completed' },
  { runId: 'legacy-failed', runKind: 'failed_request', runGroup: 'summary', terminalState: 'failed' },
  { runId: 'legacy-abandoned', runKind: 'request_abandoned', runGroup: 'summary', terminalState: 'abandoned' },
  { runId: 'legacy-unknown', runKind: 'unknown', runGroup: 'other', terminalState: 'unknown' },
];

/** A production v56 database: lazily-created legacy run_logs, stamped one version behind. */
function seedV56Database(tempRoot: string, options: { withRunLogs: boolean }): string {
  const dbPath = path.join(tempRoot, 'runtime.sqlite');
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  if (options.withRunLogs) {
    database.exec(V56_RUN_LOGS_DDL);
    const insert = database.prepare(`
      INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, flushed_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z')
    `);
    for (const row of LEGACY_ROWS) {
      insert.run(row.runId, row.runId, row.runKind, row.runGroup, row.terminalState, row.runId);
    }
  }
  database.exec(`ALTER TABLE app_config RENAME COLUMN server_model_presets_json TO ${LEGACY_MODEL_PRESETS_COLUMN}; ALTER TABLE app_config RENAME COLUMN server_model_active_preset_id TO ${LEGACY_ACTIVE_MODEL_PRESET_COLUMN};`);
  database.prepare('UPDATE runtime_schema SET version = 56 WHERE id = 1').run();
  closeRuntimeDatabase();
  return dbPath;
}

function readIdentityRows(dbPath: string): Map<string, z.infer<typeof IdentityRowSchema>> {
  const readonly = new Database(dbPath, { readonly: true });
  try {
    const rows = z.array(IdentityRowSchema).parse(readonly.prepare(`
      SELECT run_id, run_kind, operation_type, operation_preset_id, model_preset_id, operation_preset_json, model_preset_json
      FROM run_logs
    `).all());
    return new Map(rows.map((row) => [row.run_id, row]));
  } finally {
    readonly.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const readonly = new Database(dbPath, { readonly: true });
  try {
    return VersionRowSchema.parse(readonly.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version;
  } finally {
    readonly.close();
  }
}

test('v57 backfills canonical operation types only where the legacy run kind proves them', () => {
  const tempRoot = createManagedTempDir('sk-v57-backfill-');
  const dbPath = seedV56Database(tempRoot, { withRunLogs: true });
  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
    const rows = readIdentityRows(dbPath);
    assert.equal(rows.size, LEGACY_ROWS.length, 'no legacy row may be lost');
    assert.equal(rows.get('legacy-summary')?.operation_type, 'summary');
    assert.equal(rows.get('legacy-plan')?.operation_type, 'plan');
    assert.equal(rows.get('legacy-chat')?.operation_type, 'chat');
    assert.equal(rows.get('legacy-repo-search')?.operation_type, 'repo-search');
    assert.equal(rows.get('legacy-failed')?.operation_type, null);
    assert.equal(rows.get('legacy-abandoned')?.operation_type, null);
    assert.equal(rows.get('legacy-unknown')?.operation_type, null);
    for (const row of rows.values()) {
      assert.equal(row.operation_preset_id, null, row.run_id);
      assert.equal(row.model_preset_id, null, row.run_id);
      assert.equal(row.operation_preset_json, null, row.run_id);
      assert.equal(row.model_preset_json, null, row.run_id);
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('v57 ignores repo-agent evidence that lives outside run_logs', () => {
  const tempRoot = createManagedTempDir('sk-v57-aux-evidence-');
  const dbPath = seedV56Database(tempRoot, { withRunLogs: true });
  // Handoff-era repo-agent runs left state in an auxiliary directory keyed by run id. That
  // directory is not durable database history, so the migration must not read it.
  const auxiliaryRunsDir = path.join(tempRoot, '.siftkit', 'repo-agent', 'runs');
  fs.mkdirSync(auxiliaryRunsDir, { recursive: true });
  fs.writeFileSync(
    path.join(auxiliaryRunsDir, 'legacy-repo-search.json'),
    JSON.stringify({ runId: 'legacy-repo-search', requestId: 'legacy-repo-search', status: 'completed' }),
    'utf8',
  );
  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const row = readIdentityRows(dbPath).get('legacy-repo-search');
    assert.equal(row?.operation_type, 'repo-search');
    assert.equal(row?.operation_preset_id, null);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v57 completes on a database whose run_logs table was never created', () => {
  const tempRoot = createManagedTempDir('sk-v57-no-run-logs-');
  const dbPath = seedV56Database(tempRoot, { withRunLogs: false });
  try {
    assert.doesNotThrow(() => {
      getRuntimeDatabase(dbPath);
      closeRuntimeDatabase();
    });
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
    // The migration only touches a table that exists; creating run_logs stays with the lazy
    // DDL path, so the migration cannot drift with future changes to that DDL.
    const readonly = new Database(dbPath, { readonly: true });
    try {
      const table = readonly.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_logs'").get();
      assert.equal(table, undefined);
    } finally {
      readonly.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('v57 is idempotent and never overwrites an identity that was already recorded', () => {
  const tempRoot = createManagedTempDir('sk-v57-idempotent-');
  const dbPath = seedV56Database(tempRoot, { withRunLogs: true });
  try {
    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();
    const database = new Database(dbPath);
    try {
      database.prepare(`
        UPDATE run_logs SET operation_type = 'repo-agent', operation_preset_id = 'repo-agent'
        WHERE run_id = 'legacy-repo-search'
      `).run();
      database.exec(`ALTER TABLE app_config RENAME COLUMN server_model_presets_json TO ${LEGACY_MODEL_PRESETS_COLUMN}; ALTER TABLE app_config RENAME COLUMN server_model_active_preset_id TO ${LEGACY_ACTIVE_MODEL_PRESET_COLUMN};`);
  database.prepare('UPDATE runtime_schema SET version = 56 WHERE id = 1').run();
    } finally {
      database.close();
    }

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    const row = readIdentityRows(dbPath).get('legacy-repo-search');
    assert.equal(row?.operation_type, 'repo-agent');
    assert.equal(row?.operation_preset_id, 'repo-agent');
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});
