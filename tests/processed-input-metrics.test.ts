import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  ensureRunLogsTable,
  normalizeIdleSummarySnapshotRow,
  type IdleSummarySnapshotDbRow,
} from '../src/status-server/dashboard-runs.js';
import {
  ensureIdleSummarySnapshotsTable,
  IdleSummarySnapshotDbRowSchema,
} from '../src/status-server/idle-summary.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  readMetrics,
} from '../src/status-server/metrics.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeRuntimeDatabase,
  getRuntimeDatabase,
  getRuntimeDatabasePath,
} from '../src/state/runtime-db.js';

// SQLite .get()/.all() return `unknown`; narrow rows to JsonObject at the boundary.
function asRow<T>(value: T): JsonObject {
  return JsonRecordReader.asObject(value) ?? {};
}

function asRows<T>(values: readonly T[]): JsonObject[] {
  return values.map((value) => JsonRecordReader.asObject(value) ?? {});
}

function waitSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function removeDirectoryWithRetriesSync(targetPath: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        return;
      }
      waitSync(50);
    }
  }
}

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-processed-input-'));
  const previousCwd = process.cwd();
  const previousUserProfile = process.env.USERPROFILE;
  try {
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.env.USERPROFILE = repoRoot;
    process.chdir(repoRoot);
    fn(repoRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    closeRuntimeDatabase();
    removeDirectoryWithRetriesSync(repoRoot);
  }
}

test('ensureRunLogsTable preserves existing run token fields', () => {
  const database = new Database(':memory:');
  try {
    ensureRunLogsTable(database);
    database.prepare(`
      INSERT INTO run_logs (
        run_id, request_id, run_kind, run_group, terminal_state,
        started_at_utc, finished_at_utc, title, model, backend, repo_root,
        input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, duration_ms,
        request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
        source_paths_json, flushed_at_utc, source_deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'run-1',
      'req-1',
      'repo_search',
      'repo_search',
      'completed',
      '2026-04-17T00:00:00.000Z',
      '2026-04-17T00:00:01.000Z',
      'legacy repo search',
      'mock-model',
      'llama.cpp',
      process.cwd(),
      123,
      45,
      0,
      0,
      100,
      null,
      1000,
      null,
      null,
      null,
      null,
      '{}',
      '',
      '[]',
      '2026-04-17T00:00:01.000Z',
      null,
    );

    ensureRunLogsTable(database);

    const row = asRow(database.prepare(`
      SELECT input_tokens, prompt_eval_tokens
      FROM run_logs
      WHERE run_id = 'run-1'
    `).get());
    assert.equal(row.input_tokens, 123);
    assert.equal(row.prompt_eval_tokens, null);
  } finally {
    database.close();
  }
});

test('ensureRunLogsTable does not rewrite existing run rows', () => {
  const database = new Database(':memory:');
  try {
    ensureRunLogsTable(database);
    database.prepare(`
      INSERT INTO run_logs (
        run_id, request_id, run_kind, run_group, terminal_state,
        started_at_utc, finished_at_utc, title, model, backend, repo_root,
        input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, duration_ms,
        request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
        source_paths_json, flushed_at_utc, source_deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'run-1',
      'req-1',
      'repo_search',
      'repo_search',
      'completed',
      '2026-04-17T00:00:00.000Z',
      '2026-04-17T00:00:01.000Z',
      'legacy repo search',
      'mock-model',
      'llama.cpp',
      process.cwd(),
      123,
      45,
      0,
      0,
      100,
      null,
      1000,
      null,
      null,
      null,
      null,
      '{}',
      '',
      '[]',
      '2026-04-17T00:00:01.000Z',
      null,
    );

    ensureRunLogsTable(database);
    const before = Number(asRow(database.prepare('SELECT total_changes() AS changes').get()).changes);
    ensureRunLogsTable(database);
    const after = Number(asRow(database.prepare('SELECT total_changes() AS changes').get()).changes);

    assert.equal(after - before, 0);
  } finally {
    database.close();
  }
});

test('ensureRunLogsTable creates indexes for request lookup and dashboard ordering', () => {
  const database = new Database(':memory:');
  try {
    ensureRunLogsTable(database);

    const indexes = asRows(database.prepare("PRAGMA index_list('run_logs')").all());
    assert.equal(indexes.some((row) => row.name === 'idx_run_logs_request_id'), true);
    assert.equal(indexes.some((row) => row.name === 'idx_run_logs_dashboard_order'), true);

    const requestPlan = asRows(database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT speculative_accepted_tokens, speculative_generated_tokens
      FROM run_logs
      WHERE request_id = ?
      LIMIT 1
    `).all('request-1'));
    assert.equal(
      requestPlan.some((row) => String(row.detail || '').includes('idx_run_logs_request_id')),
      true,
    );

    const orderPlan = asRows(database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, run_id, request_id
      FROM run_logs
      ORDER BY COALESCE(finished_at_utc, started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC
      LIMIT 20
    `).all());
    assert.equal(
      orderPlan.some((row) => String(row.detail || '').includes('idx_run_logs_dashboard_order')),
      true,
    );
  } finally {
    database.close();
  }
});

test('ensureIdleSummarySnapshotsTable preserves existing token totals and exposes inputOutputRatio', () => {
  const database = new Database(':memory:');
  try {
    ensureIdleSummarySnapshotsTable(database);
    database.prepare(`
      INSERT INTO idle_summary_snapshots (
        emitted_at_utc,
        completed_request_count,
        input_characters_total,
        output_characters_total,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        tool_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        task_totals_json,
        tool_stats_json,
        saved_tokens,
        saved_percent,
        compression_ratio,
        request_duration_ms_total,
        avg_request_ms,
        avg_tokens_per_second
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '2026-04-17T00:00:00.000Z',
      1,
      200,
      80,
      123,
      45,
      0,
      0,
      100,
      0,
      JSON.stringify({
        summary: {
          inputCharactersTotal: 200,
          outputCharactersTotal: 80,
          inputTokensTotal: 123,
          outputTokensTotal: 45,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 100,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 1000,
          completedRequestCount: 1,
        },
        plan: {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
        'repo-search': {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
        chat: {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
      }),
      '{}',
      78,
      0.634,
      2.733,
      1000,
      1000,
      45,
    );

    ensureIdleSummarySnapshotsTable(database);

    const row = IdleSummarySnapshotDbRowSchema.parse(database.prepare('SELECT * FROM idle_summary_snapshots').get());
    assert.equal(Number(row.input_tokens_total), 123);
    assert.equal(Number(row.prompt_eval_tokens_total), 0);
    const snapshot = normalizeIdleSummarySnapshotRow(row);
    assert.ok(snapshot);
    assert.equal(snapshot?.inputTokensTotal, 123);
    assert.equal(snapshot?.taskTotals.summary.inputTokensTotal, 123);
    assert.equal(snapshot?.taskTotals.summary.promptEvalTokensTotal, 0);
    assert.equal(snapshot?.inputOutputRatio, 2.733);
  } finally {
    database.close();
  }
});

test('ensureIdleSummarySnapshotsTable creates emitted-at ordering index', () => {
  const database = new Database(':memory:');
  try {
    ensureIdleSummarySnapshotsTable(database);

    const indexes = asRows(database.prepare("PRAGMA index_list('idle_summary_snapshots')").all());
    assert.equal(indexes.some((row) => row.name === 'idx_idle_summary_snapshots_emitted'), true);

    const beforeDatePlan = asRows(database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, emitted_at_utc
      FROM idle_summary_snapshots
      WHERE emitted_at_utc < ?
      ORDER BY emitted_at_utc DESC, id DESC
      LIMIT 1
    `).all('2026-05-01T00:00:00.000Z'));
    assert.equal(
      beforeDatePlan.some((row) => String(row.detail || '').includes('idx_idle_summary_snapshots_emitted')),
      true,
    );
  } finally {
    database.close();
  }
});

test('runtime database creates runtime artifact updated-at ordering index', () => {
  withTempRepo(() => {
    const database = getRuntimeDatabase();
    const indexes = asRows(database.prepare("PRAGMA index_list('runtime_artifacts')").all());
    assert.equal(indexes.some((row) => row.name === 'idx_runtime_artifacts_updated'), true);

    const planRows = asRows(database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
      FROM runtime_artifacts
      WHERE (? = '' OR request_id = ?)
      ORDER BY updated_at_utc DESC, id DESC
      LIMIT ?
    `).all('', '', 20));
    assert.equal(
      planRows.some((row) => String(row.detail || '').includes('idx_runtime_artifacts_updated')),
      true,
    );
  });
});

test('readMetrics backfills timing columns for already-current runtime databases', () => {
  withTempRepo(() => {
    const database = getRuntimeDatabase();
    const databasePath = getRuntimeDatabasePath();
    database.exec('DROP TABLE runtime_metrics_totals;');
    database.exec(`
      CREATE TABLE runtime_metrics_totals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        input_characters_total INTEGER NOT NULL,
        output_characters_total INTEGER NOT NULL,
        input_tokens_total INTEGER NOT NULL,
        output_tokens_total INTEGER NOT NULL,
        thinking_tokens_total INTEGER NOT NULL,
        tool_tokens_total INTEGER NOT NULL,
        prompt_cache_tokens_total INTEGER NOT NULL,
        prompt_eval_tokens_total INTEGER NOT NULL,
        speculative_accepted_tokens_total INTEGER NOT NULL,
        speculative_generated_tokens_total INTEGER NOT NULL,
        request_duration_ms_total INTEGER NOT NULL,
        completed_request_count INTEGER NOT NULL,
        task_totals_json TEXT NOT NULL,
        tool_stats_json TEXT NOT NULL,
        updated_at_utc TEXT
      );
    `);
    database.prepare(`
      INSERT INTO runtime_metrics_totals (
        id, schema_version, input_characters_total, output_characters_total,
        input_tokens_total, output_tokens_total, thinking_tokens_total, tool_tokens_total,
        prompt_cache_tokens_total, prompt_eval_tokens_total, speculative_accepted_tokens_total,
        speculative_generated_tokens_total, request_duration_ms_total, completed_request_count,
        task_totals_json, tool_stats_json, updated_at_utc
      ) VALUES (1, 2, 10, 5, 4, 2, 0, 0, 0, 0, 0, 0, 1000, 1, '{}', '{}', NULL)
    `).run();
    closeRuntimeDatabase();

    const metrics = readMetrics(databasePath);

    assert.equal(metrics.requestDurationMsTotal, 1000);
    assert.equal(metrics.wallDurationMsTotal, 0);
    const reopened = getRuntimeDatabase(databasePath);
    const columns = asRows(reopened.prepare('PRAGMA table_info(runtime_metrics_totals)').all());
    assert.ok(columns.some((column) => column.name === 'wall_duration_ms_total'));
  });
});

test('runtime database schema migration preserves existing metrics token totals', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();
    getRuntimeDatabase(databasePath);
    closeRuntimeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      UPDATE runtime_schema SET version = 11 WHERE id = 1;
      INSERT INTO runtime_metrics_totals (
        id, schema_version, input_characters_total, output_characters_total, input_tokens_total, output_tokens_total,
        thinking_tokens_total, tool_tokens_total, prompt_cache_tokens_total, prompt_eval_tokens_total,
        speculative_accepted_tokens_total, speculative_generated_tokens_total,
        request_duration_ms_total, completed_request_count, task_totals_json, tool_stats_json, updated_at_utc
      ) VALUES (
        1, 2, 200, 80, 123, 45,
        0, 0, 100, 0,
        0, 0,
        1000, 1,
        '{"summary":{"inputCharactersTotal":200,"outputCharactersTotal":80,"inputTokensTotal":123,"outputTokensTotal":45,"thinkingTokensTotal":0,"toolTokensTotal":0,"promptCacheTokensTotal":100,"promptEvalTokensTotal":0,"requestDurationMsTotal":1000,"completedRequestCount":1},"plan":{"inputCharactersTotal":0,"outputCharactersTotal":0,"inputTokensTotal":0,"outputTokensTotal":0,"thinkingTokensTotal":0,"toolTokensTotal":0,"promptCacheTokensTotal":0,"promptEvalTokensTotal":0,"requestDurationMsTotal":0,"completedRequestCount":0},"repo-search":{"inputCharactersTotal":0,"outputCharactersTotal":0,"inputTokensTotal":0,"outputTokensTotal":0,"thinkingTokensTotal":0,"toolTokensTotal":0,"promptCacheTokensTotal":0,"promptEvalTokensTotal":0,"requestDurationMsTotal":0,"completedRequestCount":0},"chat":{"inputCharactersTotal":0,"outputCharactersTotal":0,"inputTokensTotal":0,"outputTokensTotal":0,"thinkingTokensTotal":0,"toolTokensTotal":0,"promptCacheTokensTotal":0,"promptEvalTokensTotal":0,"requestDurationMsTotal":0,"completedRequestCount":0}}',
        '{}',
        '2026-04-17T00:00:00.000Z'
      )
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        input_characters_total = excluded.input_characters_total,
        output_characters_total = excluded.output_characters_total,
        input_tokens_total = excluded.input_tokens_total,
        output_tokens_total = excluded.output_tokens_total,
        thinking_tokens_total = excluded.thinking_tokens_total,
        tool_tokens_total = excluded.tool_tokens_total,
        prompt_cache_tokens_total = excluded.prompt_cache_tokens_total,
        prompt_eval_tokens_total = excluded.prompt_eval_tokens_total,
        request_duration_ms_total = excluded.request_duration_ms_total,
        completed_request_count = excluded.completed_request_count,
        task_totals_json = excluded.task_totals_json,
        tool_stats_json = excluded.tool_stats_json,
        updated_at_utc = excluded.updated_at_utc;
    `);
    legacy.close();

    const migrated = getRuntimeDatabase(databasePath);
    const schemaVersionRow = asRow(migrated.prepare('SELECT version FROM runtime_schema WHERE id = 1').get());
    const metricsRow = asRow(migrated.prepare(`
      SELECT input_tokens_total, prompt_eval_tokens_total, task_totals_json
      FROM runtime_metrics_totals
      WHERE id = 1
    `).get());

    assert.equal(schemaVersionRow.version, CURRENT_SCHEMA_VERSION);
    assert.equal(metricsRow.input_tokens_total, 123);
    assert.equal(metricsRow.prompt_eval_tokens_total, 0);
    const taskTotals = asObject(parseJsonValueText(String(metricsRow.task_totals_json)));
    const summaryTotals = asObject(taskTotals.summary);
    assert.equal(summaryTotals.inputTokensTotal, 123);
    assert.equal(summaryTotals.promptEvalTokensTotal, 0);
    closeRuntimeDatabase();
  });
});
