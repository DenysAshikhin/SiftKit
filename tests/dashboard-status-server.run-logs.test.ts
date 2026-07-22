import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import {
  removeDirectoryWithRetries,
  requestJson,
  asObjectArray,
  asArray,
  getAddressInfo,
  writeJson,
} from './helpers/dashboard-http.js';

function readRunLogRowCount(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = JsonRecordReader.asObject(database.prepare('SELECT COUNT(*) AS count FROM run_logs').get());
    return Number(row?.count || 0);
  } finally {
    database.close();
  }
}

function countRows(dbPath: string, sql: string, ...params: (string | number)[]): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = JsonRecordReader.asObject(database.prepare(sql).get(...params));
    return Number(row?.count || 0);
  } finally {
    database.close();
  }
}

function seedRunHistoryFixtures(dbPath: string): void {
  const database = new Database(dbPath);
  try {
    const insertArtifact = database.prepare(`
      INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    insertArtifact.run('art-old-transcript', 'repo_search_transcript', 'req-repo-01', 'old transcript', 'line', '2026-04-01T11:01:00.000Z', '2026-04-01T11:01:00.000Z');
    insertArtifact.run('art-old-summary', 'status_summary_request', 'req-summary-02', 'old summary', 'text', '2026-04-02T10:00:00.000Z', '2026-04-02T10:00:00.000Z');
    insertArtifact.run('art-benchmark', 'benchmark_run', 'bench-01', 'benchmark', 'text', '2026-04-03T10:00:00.000Z', '2026-04-03T10:00:00.000Z');
    insertArtifact.run('art-new', 'repo_search_artifact', 'req-new-01', 'new artifact', 'text', '2026-04-20T10:00:00.000Z', '2026-04-20T10:00:00.000Z');

    const insertManagedRun = database.prepare(`
      INSERT INTO inference_runs (id, backend, purpose, base_url, status, started_at_utc, finished_at_utc, updated_at_utc)
      VALUES (?, 'llama', ?, ?, ?, ?, ?, ?)
    `);
    insertManagedRun.run('mlr-old', 'startup', 'http://127.0.0.1:9001', 'ready', '2026-04-05T10:00:00.000Z', '2026-04-05T10:05:00.000Z', '2026-04-05T10:05:00.000Z');
    insertManagedRun.run('mlr-running', 'startup', 'http://127.0.0.1:9002', 'running', '2026-04-06T10:00:00.000Z', null, '2026-04-06T10:00:00.000Z');
    insertManagedRun.run('mlr-new', 'startup', 'http://127.0.0.1:9003', 'ready', '2026-04-25T10:00:00.000Z', '2026-04-25T10:05:00.000Z', '2026-04-25T10:05:00.000Z');

    const insertChunk = database.prepare(`
      INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertChunk.run('mlr-old', 'launcher_stdout', 0, 'old chunk', '2026-04-05T10:00:00.000Z');
    insertChunk.run('mlr-new', 'launcher_stdout', 0, 'new chunk', '2026-04-25T10:00:00.000Z');

    const insertSnapshot = database.prepare(`
      INSERT INTO idle_summary_snapshots (
        emitted_at_utc, completed_request_count, input_characters_total, output_characters_total,
        input_tokens_total, output_tokens_total, thinking_tokens_total, saved_tokens, request_duration_ms_total
      ) VALUES (?, 1, 0, 0, 0, 0, 0, 0, 0)
    `);
    insertSnapshot.run('2026-04-07T10:00:00.000Z');
    insertSnapshot.run('2026-04-22T10:00:00.000Z');

    const insertError = database.prepare(`
      INSERT INTO runtime_error_events (
        id, created_at_utc, source, route, method, status_code, error_name, error_message, diagnostic_json
      ) VALUES (?, ?, 'status-server', '/x', 'GET', 500, 'Error', 'boom', '{}')
    `);
    insertError.run('err-old', '2026-04-08T10:00:00.000Z');
    insertError.run('err-new', '2026-04-23T10:00:00.000Z');
  } finally {
    database.close();
  }
}

function configureDashboardTestEnv(
  tempRoot: string,
  statusPath: string,
  configPath: string,
): Record<string, string | undefined> {
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_METRICS_PATH: process.env.SIFTKIT_METRICS_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  // Isolate run-log delete tests from the background retention prune so seeded
  // history fixtures are not removed before assertions run.
  process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE = '1';
  return envBackup;
}

function enterDashboardTestRepo(tempRoot: string): string {
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  return previousCwd;
}

function restoreDashboardTestRepo(previousCwd: string): void {
  process.chdir(previousCwd);
  closeRuntimeDatabase();
}

test('dashboard initial runs load returns top 20 overall and migrates pre-existing file logs into sqlite', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-initial-cap-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const idleSummaryDbPath = path.join(runtimeRoot, 'runtime.sqlite');
  const logsRoot = path.join(runtimeRoot, 'logs');
  const requestsRoot = path.join(logsRoot, 'requests');
  const repoSearchFailedRoot = path.join(logsRoot, 'repo_search', 'failed');

  for (let index = 0; index < 12; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-summary-${ordinal}`;
    writeJson(path.join(requestsRoot, `request_${requestId}.json`), {
      requestId,
      question: `Summary run ${ordinal}`,
      backend: 'llama.cpp',
      model: 'Qwen3.5-9B-Q8_0.gguf',
      summary: `Summary output ${ordinal}`,
      createdAtUtc: `2026-04-01T10:${ordinal}:00.000Z`,
      inputTokens: 100 + index,
      outputTokens: 40 + index,
      requestDurationMs: 1000 + index,
    });
  }

  for (let index = 0; index < 12; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-repo-${ordinal}`;
    const artifactPath = path.join(repoSearchFailedRoot, `request_${requestId}.json`);
    writeJson(artifactPath, {
      requestId,
      prompt: `Repo search run ${ordinal}`,
      repoRoot: tempRoot,
      verdict: 'fail',
      totals: { commandsExecuted: 1 },
      createdAtUtc: `2026-04-01T11:${ordinal}:00.000Z`,
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath.replace(/\.json$/u, '.jsonl'),
      [
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:01.000Z`, kind: 'turn_model_response', text: '{"action":"finish"}' }),
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:03.000Z`, kind: 'run_done', scorecard: { verdict: 'fail' } }),
      ].join('\n') + '\n',
      'utf8',
    );
  }

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const cappedRunsResponse = await requestJson(`${baseUrl}/dashboard/runs?initial=1&limitPerGroup=20`);
    assert.equal(cappedRunsResponse.statusCode, 200);
    const runs = asObjectArray(cappedRunsResponse.body.runs);
    assert.equal(runs.length, 20);

    assert.equal(fs.readdirSync(requestsRoot).length, 0);
    assert.equal(fs.readdirSync(repoSearchFailedRoot).length, 0);
    assert.equal(readRunLogRowCount(idleSummaryDbPath), 24);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard filters runs by preset group and deletes the oldest matching logs by count', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-run-delete-count-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const idleSummaryDbPath = path.join(runtimeRoot, 'runtime.sqlite');
  const logsRoot = path.join(runtimeRoot, 'logs');
  const requestsRoot = path.join(logsRoot, 'requests');
  const repoSearchFailedRoot = path.join(logsRoot, 'repo_search', 'failed');

  for (let index = 0; index < 8; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-summary-${ordinal}`;
    writeJson(path.join(requestsRoot, `request_${requestId}.json`), {
      requestId,
      question: `Summary run ${ordinal}`,
      backend: 'llama.cpp',
      model: 'Qwen3.5-9B-Q8_0.gguf',
      summary: `Summary output ${ordinal}`,
      createdAtUtc: `2026-04-01T10:${ordinal}:00.000Z`,
      inputTokens: 100 + index,
      outputTokens: 40 + index,
      requestDurationMs: 1000 + index,
    });
  }

  for (let index = 0; index < 5; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-repo-${ordinal}`;
    const artifactPath = path.join(repoSearchFailedRoot, `request_${requestId}.json`);
    writeJson(artifactPath, {
      requestId,
      prompt: `Repo search run ${ordinal}`,
      repoRoot: tempRoot,
      verdict: 'fail',
      totals: { commandsExecuted: 1 },
      createdAtUtc: `2026-04-01T11:${ordinal}:00.000Z`,
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath.replace(/\.json$/u, '.jsonl'),
      [
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:01.000Z`, kind: 'turn_model_response', text: '{"action":"finish"}' }),
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:03.000Z`, kind: 'run_done', scorecard: { verdict: 'fail' } }),
      ].join('\n') + '\n',
      'utf8',
    );
  }

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const groupedRunsResponse = await requestJson(`${baseUrl}/dashboard/runs?kind=summary`);
    assert.equal(groupedRunsResponse.statusCode, 200);
    const summaryRuns = asObjectArray(groupedRunsResponse.body.runs);
    assert.equal(summaryRuns.length, 8);

    const previewResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs/preview`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'count',
        type: 'summary',
        count: 3,
      }),
    });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.matchCount, 3);

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs`, {
      method: 'DELETE',
      body: JSON.stringify({
        mode: 'count',
        type: 'summary',
        count: 3,
      }),
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.body.deletedCount, 3);
    assert.deepEqual(deleteResponse.body.deletedRunIds, [
      'req-summary-01',
      'req-summary-02',
      'req-summary-03',
    ]);

    const afterDeleteResponse = await requestJson(`${baseUrl}/dashboard/runs?kind=summary`);
    assert.equal(afterDeleteResponse.statusCode, 200);
    const remainingSummaryRuns = asObjectArray(afterDeleteResponse.body.runs);
    assert.equal(remainingSummaryRuns.length, 5);
    assert.equal(readRunLogRowCount(idleSummaryDbPath), 10);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard deletes matching logs before a date and rejects invalid delete criteria', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-run-delete-date-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const idleSummaryDbPath = path.join(runtimeRoot, 'runtime.sqlite');
  const logsRoot = path.join(runtimeRoot, 'logs');
  const requestsRoot = path.join(logsRoot, 'requests');
  const repoSearchFailedRoot = path.join(logsRoot, 'repo_search', 'failed');

  for (let index = 0; index < 6; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-summary-${ordinal}`;
    writeJson(path.join(requestsRoot, `request_${requestId}.json`), {
      requestId,
      question: `Summary run ${ordinal}`,
      backend: 'llama.cpp',
      model: 'Qwen3.5-9B-Q8_0.gguf',
      summary: `Summary output ${ordinal}`,
      createdAtUtc: `2026-04-03T10:${ordinal}:00.000Z`,
      inputTokens: 100 + index,
      outputTokens: 40 + index,
      requestDurationMs: 1000 + index,
    });
  }

  for (let index = 0; index < 6; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-repo-${ordinal}`;
    const artifactPath = path.join(repoSearchFailedRoot, `request_${requestId}.json`);
    writeJson(artifactPath, {
      requestId,
      prompt: `Repo search run ${ordinal}`,
      repoRoot: tempRoot,
      verdict: 'fail',
      totals: { commandsExecuted: 1 },
      createdAtUtc: `2026-04-01T11:${ordinal}:00.000Z`,
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath.replace(/\.json$/u, '.jsonl'),
      [
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:01.000Z`, kind: 'turn_model_response', text: '{"action":"finish"}' }),
        JSON.stringify({ at: `2026-04-01T11:${ordinal}:03.000Z`, kind: 'run_done', scorecard: { verdict: 'fail' } }),
      ].join('\n') + '\n',
      'utf8',
    );
  }

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const invalidPreviewResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs/preview`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'count',
        type: 'summary',
        count: 0,
      }),
    });
    assert.equal(invalidPreviewResponse.statusCode, 400);
    assert.match(String(invalidPreviewResponse.body.error || ''), /count/u);

    const previewResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs/preview`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'before_date',
        type: 'repo_search',
        beforeDate: '2026-04-02',
      }),
    });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.matchCount, 6);

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs`, {
      method: 'DELETE',
      body: JSON.stringify({
        mode: 'before_date',
        type: 'repo_search',
        beforeDate: '2026-04-02',
      }),
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.body.deletedCount, 6);
    assert.equal(asArray(deleteResponse.body.deletedRunIds).length, 6);
    assert.equal(readRunLogRowCount(idleSummaryDbPath), 6);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard before_date all-type delete wipes run history across tables while preserving benchmarks, running llama, and post-cutoff rows', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-run-delete-all-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const idleSummaryDbPath = path.join(runtimeRoot, 'runtime.sqlite');
  const requestsRoot = path.join(runtimeRoot, 'logs', 'requests');

  for (let index = 0; index < 6; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-summary-${ordinal}`;
    writeJson(path.join(requestsRoot, `request_${requestId}.json`), {
      requestId,
      question: `Summary run ${ordinal}`,
      backend: 'llama.cpp',
      model: 'Qwen3.5-9B-Q8_0.gguf',
      summary: `Summary output ${ordinal}`,
      createdAtUtc: `2026-04-01T10:${ordinal}:00.000Z`,
      inputTokens: 100 + index,
      outputTokens: 40 + index,
      requestDurationMs: 1000 + index,
    });
  }

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    seedRunHistoryFixtures(idleSummaryDbPath);

    const criteria = { mode: 'before_date', type: 'all', beforeDate: '2026-04-15' };

    const previewResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs/preview`, {
      method: 'POST',
      body: JSON.stringify(criteria),
    });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.matchCount, 11);

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs`, {
      method: 'DELETE',
      body: JSON.stringify(criteria),
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.body.deletedCount, 11);
    assert.equal(asArray(deleteResponse.body.deletedRunIds).length, 6);

    assert.equal(readRunLogRowCount(idleSummaryDbPath), 0);
    assert.equal(countRows(idleSummaryDbPath, 'SELECT COUNT(*) AS count FROM runtime_artifacts'), 2);
    assert.equal(countRows(idleSummaryDbPath, "SELECT COUNT(*) AS count FROM runtime_artifacts WHERE artifact_kind = 'benchmark_run'"), 1);
    assert.equal(countRows(idleSummaryDbPath, 'SELECT COUNT(*) AS count FROM inference_runs'), 2);
    assert.equal(countRows(idleSummaryDbPath, "SELECT COUNT(*) AS count FROM inference_runs WHERE id = 'mlr-running'"), 1);
    assert.equal(countRows(idleSummaryDbPath, 'SELECT COUNT(*) AS count FROM inference_run_log_chunks'), 1);
    assert.equal(countRows(idleSummaryDbPath, "SELECT COUNT(*) AS count FROM inference_run_log_chunks WHERE run_id = 'mlr-old'"), 0);
    assert.equal(countRows(idleSummaryDbPath, 'SELECT COUNT(*) AS count FROM idle_summary_snapshots'), 1);
    assert.equal(countRows(idleSummaryDbPath, 'SELECT COUNT(*) AS count FROM runtime_error_events'), 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard run-log delete cascades linked runtime artifacts and source files by request id', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-run-delete-linked-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const idleSummaryDbPath = path.join(runtimeRoot, 'runtime.sqlite');
  const repoSearchFailedRoot = path.join(runtimeRoot, 'logs', 'repo_search', 'failed');

  for (let index = 0; index < 5; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const requestId = `req-repo-${ordinal}`;
    const artifactPath = path.join(repoSearchFailedRoot, `request_${requestId}.json`);
    writeJson(artifactPath, {
      requestId,
      prompt: `Repo search run ${ordinal}`,
      repoRoot: tempRoot,
      verdict: 'fail',
      totals: { commandsExecuted: 1 },
      createdAtUtc: `2026-04-01T11:${ordinal}:00.000Z`,
    });
    fs.writeFileSync(
      artifactPath.replace(/\.json$/u, '.jsonl'),
      `${JSON.stringify({ at: `2026-04-01T11:${ordinal}:03.000Z`, kind: 'run_done', scorecard: { verdict: 'fail' } })}\n`,
      'utf8',
    );
  }

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const selectedSourcePath = path.join(runtimeRoot, 'logs', 'requests', 'request_req-repo-01.json');
    const selectedTranscriptPath = path.join(runtimeRoot, 'logs', 'requests', 'request_req-repo-01.jsonl');
    const retainedSourcePath = path.join(runtimeRoot, 'logs', 'requests', 'request_retained.json');
    fs.mkdirSync(path.dirname(selectedSourcePath), { recursive: true });
    fs.writeFileSync(selectedSourcePath, '{"requestId":"req-repo-01"}\n', 'utf8');
    fs.writeFileSync(selectedTranscriptPath, '{"kind":"run_done"}\n', 'utf8');
    fs.writeFileSync(retainedSourcePath, '{"requestId":"retained"}\n', 'utf8');

    const database = new Database(idleSummaryDbPath);
    try {
      database.prepare(`
        UPDATE run_logs
        SET source_paths_json = ?
        WHERE run_id = 'req-repo-01'
      `).run(JSON.stringify([selectedSourcePath, selectedTranscriptPath]));
      const insertArtifact = database.prepare(`
        INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `);
      insertArtifact.run('art-linked', 'repo_search_transcript', 'req-repo-01', 'linked', 'line', '2026-04-01T11:01:00.000Z', '2026-04-01T11:01:00.000Z');
      insertArtifact.run('art-unrelated', 'repo_search_transcript', 'req-unrelated', 'unrelated', 'line', '2026-04-01T11:01:00.000Z', '2026-04-01T11:01:00.000Z');
    } finally {
      database.close();
    }

    const criteria = { mode: 'before_date', type: 'repo_search', beforeDate: '2026-04-02' };

    const previewResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs/preview`, {
      method: 'POST',
      body: JSON.stringify(criteria),
    });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.body.matchCount, 6);

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/admin/run-logs`, {
      method: 'DELETE',
      body: JSON.stringify(criteria),
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.body.deletedCount, 6);
    assert.equal(asArray(deleteResponse.body.deletedRunIds).length, 5);

    assert.equal(readRunLogRowCount(idleSummaryDbPath), 0);
    assert.equal(countRows(idleSummaryDbPath, "SELECT COUNT(*) AS count FROM runtime_artifacts WHERE id = 'art-linked'"), 0);
    assert.equal(countRows(idleSummaryDbPath, "SELECT COUNT(*) AS count FROM runtime_artifacts WHERE id = 'art-unrelated'"), 1);
    assert.equal(fs.existsSync(selectedSourcePath), false);
    assert.equal(fs.existsSync(selectedTranscriptPath), false);
    assert.equal(fs.existsSync(retainedSourcePath), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
