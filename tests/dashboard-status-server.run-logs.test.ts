import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer } from '../dist/status-server/index.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';
import {
  removeDirectoryWithRetries,
  requestJson,
  type Dict,
  writeJson,
} from './helpers/dashboard-http.ts';

const requireFromHere = createRequire(__filename);
const Database = requireFromHere('better-sqlite3') as new (path: string, options?: { readonly?: boolean }) => {
  prepare: (sql: string) => { get: (...args: unknown[]) => Dict };
  close: () => void;
};

function readRunLogRowCount(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM run_logs').get() as Dict;
    return Number(row.count || 0);
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
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const cappedRunsResponse = await requestJson(`${baseUrl}/dashboard/runs?initial=1&limitPerGroup=20`);
    assert.equal(cappedRunsResponse.statusCode, 200);
    const runs = cappedRunsResponse.body.runs as Dict[];
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const groupedRunsResponse = await requestJson(`${baseUrl}/dashboard/runs?kind=summary`);
    assert.equal(groupedRunsResponse.statusCode, 200);
    const summaryRuns = groupedRunsResponse.body.runs as Dict[];
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
    const remainingSummaryRuns = afterDeleteResponse.body.runs as Dict[];
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
  const address = server.address() as AddressInfo;
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
    assert.equal((deleteResponse.body.deletedRunIds as unknown[]).length, 6);
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
