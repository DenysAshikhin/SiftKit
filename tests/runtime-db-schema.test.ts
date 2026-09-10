import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mock } from 'node:test';
import path from 'node:path';
import test from 'node:test';

import { SystemClock } from '../src/assistant/clock.js';
import {
  closeRuntimeDatabase,
  CURRENT_SCHEMA_VERSION,
  getRuntimeDatabase,
  getSchemaVersion,
} from '../src/state/runtime-db.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import {
  REMOVED_BACKEND_COLUMN_PREFIX, REMOVED_BACKEND_ID, REMOVED_BACKEND_RUNS_TABLE,
  REMOVED_BACKEND_LOG_CHUNKS_TABLE, REMOVED_BACKEND_STREAM_KIND,
} from './helpers/legacy-backend-fixtures.js';

const TableNameRowsSchema = z.array(z.object({ name: z.string() }));
const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
type DatabaseInstance = InstanceType<typeof Database>;

const BOOTSTRAP_TABLES = [
  'app_config',
  'assertion_evidence',
  'assistant_activity_events',
  'assistant_activity_sessions',
  'assistant_audit_events',
  'assistant_capture_queue',
  'assistant_device_nonces',
  'assistant_devices',
  'assistant_jobs',
  'assistant_owners',
  'assistant_policies',
  'assistant_question_feedback',
  'assistant_questions',
  'benchmark_attempts',
  'benchmark_cases',
  'benchmark_logs',
  'benchmark_matrix_logs',
  'benchmark_matrix_runs',
  'benchmark_matrix_sessions',
  'benchmark_question_presets',
  'benchmark_runs',
  'benchmark_sessions',
  'candidate_assertions',
  'chat_messages',
  'chat_pending_messages',
  'chat_sessions',
  'eval_results',
  'evidence_blobs',
  'evidence_records',
  'graph_assertions',
  'graph_assertions_fts',
  'graph_entity_merges',
  'graph_mutation_log',
  'graph_node_aliases',
  'graph_node_types',
  'graph_nodes',
  'graph_nodes_fts',
  'graph_relation_types',
  'inference_run_log_chunks',
  'inference_runs',
  'memory_projections',
  'memory_projections_fts',
  'observations',
  'observed_budget_state',
  'retrieval_usage',
  'runtime_artifacts',
  'runtime_error_events',
  'runtime_metadata',
  'runtime_metrics_totals',
  'runtime_schema',
  'runtime_status',
  'web_search_usage',
] as const;

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function seedMarker(dbPath: string, version: number): void {
  const database = new Database(dbPath);
  try {
    database.exec(`
      CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO runtime_schema (id, version) VALUES (1, ${String(version)});
      CREATE TABLE sentinel (value TEXT NOT NULL);
      INSERT INTO sentinel (value) VALUES ('preserve');
    `);
  } finally {
    database.close();
  }
}

function readSentinel(dbPath: string): string {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = z.object({ value: z.string() }).parse(database.prepare('SELECT value FROM sentinel').get());
    return row.value;
  } finally {
    database.close();
  }
}

function columnNames(database: DatabaseInstance, table: string): string[] {
  return ColumnNameRowsSchema.parse(database.prepare(
    `SELECT name FROM pragma_table_info('${table}')`,
  ).all()).map((row) => row.name);
}

test('fresh creation bootstraps the current schema and marker', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-fresh-');
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    assert.equal(
      z.object({ value: z.string() }).parse(database.prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'assistant.local_device_id'",
      ).get()).value.length > 0,
      true,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('fresh bootstrap creates every current bootstrap-owned table', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-tables-');
  try {
    getRuntimeDatabase(dbPath);
    const database = new Database(dbPath, { readonly: true });
    try {
      const names = new Set(TableNameRowsSchema.parse(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all()).map((row) => row.name));
      for (const table of BOOTSTRAP_TABLES) {
        assert.equal(names.has(table), true, `missing bootstrap table ${table}`);
      }
    } finally {
      database.close();
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('fresh schema carries current backend, web-search, timeline, and assistant fields', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-fields-');
  try {
    const database = getRuntimeDatabase(dbPath);
    const appConfigColumns = columnNames(database, 'app_config');
    assert.equal(appConfigColumns.includes('inference_json'), true);
    assert.equal(appConfigColumns.includes('server_exl3_json'), true);
    assert.equal(appConfigColumns.includes('web_search_json'), true);
    assert.equal(appConfigColumns.includes('assistant_json'), true);
    assert.equal(appConfigColumns.includes('backend'), false);
    assert.equal(appConfigColumns.some((name) => name.startsWith(REMOVED_BACKEND_COLUMN_PREFIX)), false);
    assert.deepEqual(appConfigColumns.filter((name) => name.startsWith('server_')).sort(), [
      'server_exl3_json', 'server_external_server_enabled', 'server_model_active_preset_id', 'server_model_presets_json',
    ]);
    assert.ok(appConfigColumns.includes('presets_json'));
    assert.ok(columnNames(database, 'chat_sessions').includes('web_search_enabled'));
    const tables = TableNameRowsSchema.parse(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).map((row) => row.name);
    assert.equal(tables.includes(REMOVED_BACKEND_RUNS_TABLE), false);
    assert.equal(tables.includes(REMOVED_BACKEND_LOG_CHUNKS_TABLE), false);
    assert.ok(columnNames(database, 'inference_runs').includes('entrypoint_path'));
    assert.equal(columnNames(database, 'inference_runs').includes('script_path'), false);

    const chatMessageColumns = columnNames(database, 'chat_messages');
    assert.equal(chatMessageColumns.includes('web_search_enabled'), false);
    assert.equal(chatMessageColumns.includes('images'), true);
    assert.equal(chatMessageColumns.includes('image_meta'), true);
    assert.equal(chatMessageColumns.includes('removed_image_count'), true);
    assert.equal(columnNames(database, 'candidate_assertions').includes('hold_json'), true);
    assert.equal(columnNames(database, 'candidate_assertions').includes('user_notes'), true);
    assert.equal(columnNames(database, 'graph_assertions').includes('user_demoted'), true);
    assert.equal(columnNames(database, 'graph_nodes').includes('fts_rowid'), true);
    assert.equal(columnNames(database, 'memory_projections').includes('fts_rowid'), true);

    assert.throws(() => database.prepare(`
      INSERT INTO inference_runs (
        id, backend, purpose, status, started_at_utc, updated_at_utc
      ) VALUES ('invalid', ?, 'test', 'failed', '2026-09-07', '2026-09-07')
    `).run(REMOVED_BACKEND_ID), /CHECK constraint failed/u);
  } finally {
    closeRuntimeDatabase();
  }
});

test('opening a current database preserves stored values and device identity', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-current-');
  try {
    const database = getRuntimeDatabase(dbPath);
    const ValueRow = z.object({ value: z.string() });
    const before = ValueRow.parse(database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.local_device_id'",
    ).get());
    database.prepare(
      'INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)',
    ).run('schema-test.sentinel', 'preserve-exactly', '2026-09-07T00:00:00.000Z');
    closeRuntimeDatabase();

    const reopened = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(reopened), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(ValueRow.parse(reopened.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.local_device_id'",
    ).get()), before);
    assert.equal(ValueRow.parse(reopened.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema-test.sentinel'",
    ).get()).value, 'preserve-exactly');
  } finally {
    closeRuntimeDatabase();
  }
});

test('historical and future schema markers are rejected without changing their contents', () => {
  for (const version of [64, 65, 68]) {
    const dbPath = tempDbPath(`siftkit-runtime-schema-version-${String(version)}-`);
    seedMarker(dbPath, version);
    const before = readFileSync(dbPath);
    try {
      assert.throws(() => getRuntimeDatabase(dbPath), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(dbPath));
        assert.ok(error.message.includes(`version ${version}`));
        assert.match(error.message, /expected 67/u);
        return true;
      });
      assert.deepEqual(readFileSync(dbPath), before);
      assert.equal(readSentinel(dbPath), 'preserve');
    } finally {
      closeRuntimeDatabase();
    }
  }
});

test('a version 66 database upgrades to 67 in place, adding the pending-message table and keeping chat and log rows', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-upgrade-66-');
  const CountRow = z.object({ count: z.number() });
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec(`
      INSERT INTO chat_sessions (id, title, model_preset_id, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
      VALUES ('s1', 'Kept', 'preset', 1, 1, 'chat', 'chat', 'C:/repo', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
      INSERT INTO chat_messages (session_id, id, role, kind, content, input_tokens_estimate, output_tokens_estimate, thinking_tokens, input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated, created_at_utc, compressed_into_summary, position)
      VALUES ('s1', 'm1', 'user', 'user_text', 'kept message', 1, 0, 0, 1, 0, 0, '2026-09-09T00:00:00.000Z', 0, 0);
      INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, flushed_at_utc)
      VALUES ('run-1', 'run-1', 'chat', 'chat', 'completed', 'kept run', '2026-09-09T00:00:00.000Z');
    `);
    // The exact shape a database left by the previous release has: no queue table, marker 66.
    database.exec('DROP TABLE chat_pending_messages; UPDATE runtime_schema SET version = 66 WHERE id = 1;');
    closeRuntimeDatabase();

    const upgraded = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 67);
    assert.ok(columnNames(upgraded, 'chat_pending_messages').includes('delivered_request_id'));
    assert.equal(CountRow.parse(upgraded.prepare("SELECT count(*) AS count FROM chat_messages WHERE content = 'kept message'").get()).count, 1);
    assert.equal(CountRow.parse(upgraded.prepare("SELECT count(*) AS count FROM run_logs WHERE run_id = 'run-1'").get()).count, 1);
    assert.equal(CountRow.parse(upgraded.prepare('SELECT count(*) AS count FROM chat_pending_messages').get()).count, 0);
    upgraded.prepare(`
      INSERT INTO chat_pending_messages (session_id, id, content, images_json, options_json, revision, state, created_at_utc)
      VALUES ('s1', 'q1', 'queued', '[]', '{}', 1, 'pending', '2026-09-09T00:00:00.000Z')
    `).run();
    upgraded.exec("DELETE FROM chat_sessions WHERE id = 's1'");
    assert.equal(CountRow.parse(upgraded.prepare('SELECT count(*) AS count FROM chat_pending_messages').get()).count, 0);
  } finally {
    closeRuntimeDatabase();
  }
});

test('unreadable files are rejected without destructive recovery', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-unreadable-');
  const original = Buffer.from('this is not sqlite', 'utf8');
  writeFileSync(dbPath, original);
  try {
    assert.throws(() => getRuntimeDatabase(dbPath));
    assert.deepEqual(readFileSync(dbPath), original);
  } finally {
    closeRuntimeDatabase();
  }
});

test('schema version access performs no writes', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-readonly-version-');
  const database = new Database(dbPath);
  try {
    database.exec(`
      CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO runtime_schema (id, version) VALUES (1, ${String(CURRENT_SCHEMA_VERSION)});
    `);
    const before = readFileSync(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    database.close();
  }
});

test('fresh bootstrap rolls back schema and seed rows when the clock fails', () => {
  const dbPath = tempDbPath('siftkit-runtime-schema-rollback-');
  const clockMock = mock.method(SystemClock.prototype, 'nowUtc', () => {
    throw new Error('clock failed');
  });
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /clock failed/u);
  } finally {
    clockMock.mock.restore();
    closeRuntimeDatabase();
  }

  const database = new Database(dbPath, { readonly: true });
  try {
    const names = TableNameRowsSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all()).map((row) => row.name);
    assert.deepEqual(names, []);
  } finally {
    database.close();
  }
});

for (const marker of [
  { label: 'missing', sql: '' },
  { label: 'empty', sql: 'CREATE TABLE runtime_schema (id INTEGER, version INTEGER)' },
  { label: 'multiple', sql: 'CREATE TABLE runtime_schema (id INTEGER, version INTEGER); INSERT INTO runtime_schema VALUES (1, 66), (2, 66)' },
  { label: 'wrong id', sql: 'CREATE TABLE runtime_schema (id INTEGER, version INTEGER); INSERT INTO runtime_schema VALUES (2, 66)' },
  { label: 'fractional', sql: 'CREATE TABLE runtime_schema (id INTEGER, version REAL); INSERT INTO runtime_schema VALUES (1, 66.5)' },
  { label: 'text', sql: "CREATE TABLE runtime_schema (id INTEGER, version TEXT); INSERT INTO runtime_schema VALUES (1, '66')" },
  { label: 'nonnumeric text', sql: "CREATE TABLE runtime_schema (id INTEGER, version TEXT); INSERT INTO runtime_schema VALUES (1, 'bad')" },
  { label: 'missing version column', sql: 'CREATE TABLE runtime_schema (id INTEGER)' },
  { label: 'view', sql: 'CREATE VIEW runtime_schema AS SELECT 1 AS id, 66 AS version' },
] as const) {
  test(`invalid ${marker.label} marker rejects without changing database bytes or caching the handle`, () => {
    const dbPath = tempDbPath('siftkit-invalid-marker-');
    const raw = new Database(dbPath);
    try {
      raw.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserve')");
      if (marker.sql !== '') raw.exec(marker.sql);
    } finally { raw.close(); }
    const before = readFileSync(dbPath);
    const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      for (const entryPoint of ['version accessor', 'database opener'] as const) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          assert.throws(() => entryPoint === 'version accessor' ? getSchemaVersion(reader) : getRuntimeDatabase(dbPath), (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, 'Error');
            assert.match(error.message, /Runtime schema marker.*missing or invalid/u);
            assert.ok(error.message.includes(dbPath));
            assert.match(error.message, /expected.*67/iu);
            assert.ok(error.cause instanceof Error);
            return true;
          });
          assert.deepEqual(readFileSync(dbPath), before);
          assert.equal(readSentinel(dbPath), 'preserve');
        }
      }
    } finally {
      reader.close();
      closeRuntimeDatabase();
    }
  });
}

test('schema version accessor rejects an empty database without writing a marker table', () => {
  const database = new Database(':memory:');
  try {
    assert.throws(() => getSchemaVersion(database));
    assert.deepEqual(TableNameRowsSchema.parse(database.prepare('SELECT name FROM sqlite_schema').all()), []);
  } finally { database.close(); }
});

test('current inference and benchmark streams enforce constraints and foreign keys', () => {
  const dbPath = tempDbPath('siftkit-runtime-current-constraints-');
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec(`
      INSERT INTO inference_runs (id, backend, purpose, status, started_at_utc, updated_at_utc)
      VALUES ('run', 'exl3', 'test', 'stopped', '2026-09-08', '2026-09-08');
      INSERT INTO benchmark_sessions (id, status, question_preset_count, case_count, repetitions, restore_status, original_config_json, started_at_utc, updated_at_utc)
      VALUES ('bench', 'completed', 1, 1, 1, 'completed', '{}', '2026-09-08', '2026-09-08');
    `);
    const insertChunk = database.prepare('INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc) VALUES (?, ?, 1, ?, ?)');
    insertChunk.run('run', 'engine_stdout', 'retained', '2026-09-08');
    assert.throws(() => insertChunk.run('run', 'invalid', 'bad', '2026-09-08'), /CHECK constraint failed/u);
    assert.throws(() => insertChunk.run('missing', 'engine_stdout', 'bad', '2026-09-08'), /FOREIGN KEY constraint failed/u);
    const insertLog = database.prepare('INSERT INTO benchmark_logs (session_id, stream_kind, sequence, chunk_text, created_at_utc) VALUES (?, ?, 1, ?, ?)');
    insertLog.run('bench', 'managed_engine', 'retained', '2026-09-08');
    assert.throws(() => insertLog.run('bench', REMOVED_BACKEND_STREAM_KIND, 'bad', '2026-09-08'), /CHECK constraint failed/u);
    assert.throws(() => insertLog.run('missing', 'managed_engine', 'bad', '2026-09-08'), /FOREIGN KEY constraint failed/u);
    database.exec("DELETE FROM inference_runs WHERE id = 'run'; DELETE FROM benchmark_sessions WHERE id = 'bench'");
    const CountSchema = z.object({ count: z.number() });
    assert.equal(CountSchema.parse(database.prepare('SELECT count(*) AS count FROM inference_run_log_chunks').get()).count, 0);
    assert.equal(CountSchema.parse(database.prepare('SELECT count(*) AS count FROM benchmark_logs').get()).count, 0);
  } finally { closeRuntimeDatabase(); }
});
