import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { z } from '../src/lib/zod.js';
import { getRuntimeDatabase, closeAllRuntimeDatabases, pruneRuntimeHistory } from '../src/state/runtime-db.js';
import { insertRuntimeErrorEvent } from '../src/state/runtime-error-events.js';
import { readMetrics } from '../src/status-server/metrics.js';
import { queryDashboardRunsFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { previewDashboardRunLogDeletion } from '../src/status-server/dashboard-runs/deletion.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('fresh initialization owns run logs and idle snapshots with their current indexes', () => {
  const dbPath = join(createManagedTempDir('siftkit-store-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    const rows = z.array(z.object({ name: z.string() }));
    const columns = rows.parse(database.prepare('PRAGMA table_info(run_logs)').all()).map((row) => row.name);
    for (const column of ['operation_type', 'operation_preset_id', 'model_preset_id', 'speculative_accepted_tokens', 'speculative_generated_tokens', 'prompt_eval_duration_ms', 'generation_duration_ms', 'provider_duration_ms', 'wall_duration_ms']) {
      assert.ok(columns.includes(column), column);
    }
    const snapshots = rows.parse(database.prepare('PRAGMA table_info(idle_summary_snapshots)').all()).map((row) => row.name);
    for (const column of ['thinking_tokens_total', 'tool_tokens_total', 'prompt_cache_tokens_total', 'prompt_eval_tokens_total', 'speculative_accepted_tokens_total', 'speculative_generated_tokens_total', 'task_totals_json', 'tool_stats_json']) {
      assert.ok(snapshots.includes(column), column);
    }
    const indexes = rows.parse(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all()).map((row) => row.name);
    for (const index of ['idx_run_logs_started', 'idx_run_logs_group_started', 'idx_run_logs_kind_started', 'idx_run_logs_request_id', 'idx_run_logs_dashboard_order', 'idx_idle_summary_snapshots_emitted']) {
      assert.ok(indexes.includes(index), index);
    }
  } finally { closeAllRuntimeDatabases(); }
});

test('metrics reads fail on a missing current timing column without repairing it', () => {
  const dbPath = join(createManagedTempDir('siftkit-metrics-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec('ALTER TABLE runtime_metrics_totals DROP COLUMN wall_duration_ms_total');
    assert.throws(() => readMetrics(dbPath), /wall_duration_ms_total/u);
    const columns = z.array(z.object({ name: z.string() })).parse(database.prepare('PRAGMA table_info(runtime_metrics_totals)').all());
    assert.equal(columns.some((column) => column.name === 'wall_duration_ms_total'), false);
  } finally { closeAllRuntimeDatabases(); }
});

test('dashboard reads fail on a missing current run column without repairing it', () => {
  const dbPath = join(createManagedTempDir('siftkit-runs-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    queryDashboardRunsFromDb(database);
    database.exec('ALTER TABLE run_logs DROP COLUMN provider_duration_ms');
    assert.throws(() => queryDashboardRunsFromDb(database), /provider_duration_ms/u);
  } finally { closeAllRuntimeDatabases(); }
});

test('error recording rejects an uninitialized database without creating schema', () => {
  const database = new Database(':memory:');
  try {
    assert.throws(() => insertRuntimeErrorEvent(database, {
      source: 'test', route: '/test', method: 'GET', statusCode: 500, error: new Error('example'),
    }), /runtime_error_events/u);
    assert.deepEqual(z.array(z.object({ name: z.string() })).parse(database.prepare('SELECT name FROM sqlite_schema').all()), []);
  } finally { database.close(); }
});

test('retention rejects missing canonical tables and rolls back preceding deletes', () => {
  const dbPath = join(createManagedTempDir('siftkit-retention-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec("INSERT INTO runtime_artifacts (id, artifact_kind, created_at_utc, updated_at_utc) VALUES ('preserve', 'test', '2000-01-01', '2000-01-01')");
    database.exec('DROP TABLE runtime_error_events');
    assert.throws(() => pruneRuntimeHistory(7, dbPath), /runtime_error_events/u);
    assert.deepEqual(z.object({ id: z.string() }).parse(database.prepare('SELECT id FROM runtime_artifacts').get()), { id: 'preserve' });
  } finally { closeAllRuntimeDatabases(); }
});

test('history deletion preview rejects a missing required auxiliary table', () => {
  const dbPath = join(createManagedTempDir('siftkit-deletion-schema-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec('DROP TABLE runtime_artifacts');
    assert.throws(() => previewDashboardRunLogDeletion(database, { mode: 'before_date', type: 'all', beforeDate: '2026-01-01' }), /runtime_artifacts/u);
  } finally { closeAllRuntimeDatabases(); }
});
