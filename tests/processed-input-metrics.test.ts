import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeIdleSummarySnapshotRow,
} from '../src/status-server/dashboard-runs.js';
import {
  IdleSummarySnapshotDbRowSchema,
} from '../src/status-server/idle-summary.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { createManagedTempDir, removeDirectorySync } from './helpers/temp-dirs.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  closeAllRuntimeDatabases,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';

// SQLite .get()/.all() return `unknown`; narrow rows to JsonObject at the boundary.
function asRow<T>(value: T): JsonObject {
  return JsonRecordReader.asObject(value) ?? {};
}

function asRows<T>(values: readonly T[]): JsonObject[] {
  return values.map((value) => JsonRecordReader.asObject(value) ?? {});
}

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = createManagedTempDir('siftkit-processed-input-');
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
    closeAllRuntimeDatabases();
    if (!removeDirectorySync(repoRoot)) {
      process.stderr.write(`\nTEMP DIRECTORY LEFT BEHIND: ${repoRoot}\n`);
    }
  }
}

test('runtime initialization preserves existing run token fields', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-current-store-'), 'runtime.sqlite');
  let database = getRuntimeDatabase(databasePath);
  try {
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
      'exl3',
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

    closeAllRuntimeDatabases();
    database = getRuntimeDatabase(databasePath);

    const row = asRow(database.prepare(`
      SELECT input_tokens, prompt_eval_tokens
      FROM run_logs
      WHERE run_id = 'run-1'
    `).get());
    assert.equal(row.input_tokens, 123);
    assert.equal(row.prompt_eval_tokens, null);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('runtime initialization does not rewrite existing run rows', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-current-store-'), 'runtime.sqlite');
  let database = getRuntimeDatabase(databasePath);
  try {
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
      'exl3',
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

    const before = asRows(database.prepare('SELECT * FROM run_logs').all());
    closeAllRuntimeDatabases();
    database = getRuntimeDatabase(databasePath);
    assert.deepEqual(asRows(database.prepare('SELECT * FROM run_logs').all()), before);
    assert.equal(Number(asRow(database.prepare('SELECT total_changes() AS changes').get()).changes), 0);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('runtime initialization creates indexes for request lookup and dashboard ordering', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-current-store-'), 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  try {

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
    closeAllRuntimeDatabases();
  }
});

test('runtime initialization preserves existing token totals and exposes inputOutputRatio', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-current-store-'), 'runtime.sqlite');
  let database = getRuntimeDatabase(databasePath);
  try {
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

    closeAllRuntimeDatabases();
    database = getRuntimeDatabase(databasePath);

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
    closeAllRuntimeDatabases();
  }
});

test('runtime initialization creates emitted-at ordering index', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-current-store-'), 'runtime.sqlite');
  const database = getRuntimeDatabase(databasePath);
  try {

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
    closeAllRuntimeDatabases();
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
