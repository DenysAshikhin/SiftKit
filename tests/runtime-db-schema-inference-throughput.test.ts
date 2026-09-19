import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { z } from '../src/lib/zod.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeAllRuntimeDatabases,
  getRuntimeDatabase,
  getSchemaVersion,
} from '../src/state/runtime-db.js';
import { emptyInferenceThroughput, readTabbyThroughput } from '../src/lib/inference-throughput.js';
import { getDefaultMetrics, readMetrics, writeMetrics } from '../src/status-server/metrics.js';
import {
  buildIdleSummarySnapshot,
  persistIdleSummarySnapshot,
  queryRecentSnapshots,
} from '../src/status-server/idle-summary.js';
import {
  normalizeIdleSummarySnapshotRow,
  queryDashboardRunDetailFromDb,
  upsertRepoSearchRun,
  upsertRunArtifactPayload,
} from '../src/status-server/dashboard-runs.js';
import { UNRECORDED_RUN_IDENTITY } from '../src/status-server/dashboard-runs/run-identity.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const THROUGHPUT_TABLES = [
  'run_logs',
  'chat_messages',
  'benchmark_attempts',
  'runtime_metrics_totals',
  'idle_summary_snapshots',
] as const;

const ColumnInfoRowsSchema = z.array(z.object({
  cid: z.number(),
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.string().nullable(),
  pk: z.number(),
}));

type DatabaseInstance = InstanceType<typeof Database>;

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function tableInfo(database: DatabaseInstance, table: string) {
  return ColumnInfoRowsSchema.parse(database.prepare(
    `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`,
  ).all());
}

function columnNames(database: DatabaseInstance, table: string): string[] {
  return tableInfo(database, table).map((row) => row.name);
}

/** Rewinds a fresh database to the shape a marker-`version` build left: no throughput columns. */
function rewindToVersion(dbPath: string, version: number, extraSql = ''): void {
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  const database = new Database(dbPath);
  try {
    for (const table of THROUGHPUT_TABLES) {
      database.exec(`ALTER TABLE ${table} DROP COLUMN throughput_json`);
    }
    database.exec(`${extraSql} UPDATE runtime_schema SET version = ${String(version)} WHERE id = 1;`);
  } finally {
    database.close();
  }
}

const FOLD = readTabbyThroughput({ usage: {
  prompt_tokens: 286_806, prompt_tokens_details: { cached_tokens: 251_392 },
  prompt_time: 48.73, prompt_tokens_per_sec: 726.739_175_046_2,
  completion_tokens: 28_036, completion_time: 1_189.48, completion_tokens_per_sec: 23.569_963_345_3,
} });

test('a fresh database carries throughput_json on every canonical table', () => {
  const dbPath = tempDbPath('siftkit-throughput-fresh-');
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    for (const table of THROUGHPUT_TABLES) {
      assert.ok(columnNames(database, table).includes('throughput_json'), `${table} lacks throughput_json`);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a version 72 database upgrades to 73 with table layouts identical to a fresh bootstrap', () => {
  const freshPath = tempDbPath('siftkit-throughput-fresh-layout-');
  const upgradedPath = tempDbPath('siftkit-throughput-upgrade-72-');
  try {
    rewindToVersion(upgradedPath, 72);
    const upgraded = getRuntimeDatabase(upgradedPath);
    const fresh = getRuntimeDatabase(freshPath);
    assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
    for (const table of THROUGHPUT_TABLES) {
      assert.deepEqual(tableInfo(upgraded, table), tableInfo(fresh, table), `${table} layout drifted`);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a version 71 database chains through 72 to 73', () => {
  const dbPath = tempDbPath('siftkit-throughput-upgrade-71-');
  try {
    rewindToVersion(dbPath, 71, 'DROP TABLE chat_submissions;');
    const upgraded = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(upgraded), CURRENT_SCHEMA_VERSION);
    assert.ok(columnNames(upgraded, 'chat_submissions').length > 0);
    for (const table of THROUGHPUT_TABLES) {
      assert.ok(columnNames(upgraded, table).includes('throughput_json'), `${table} lacks throughput_json`);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

// A table the upgrade expects is gone: the step throws, the transaction rolls back, and the file
// stays at 72 with no column added anywhere.
test('a failed 72 to 73 upgrade leaves version 72 and no added column', () => {
  const dbPath = tempDbPath('siftkit-throughput-upgrade-failed-');
  rewindToVersion(dbPath, 72, 'DROP TABLE idle_summary_snapshots;');
  assert.throws(() => getRuntimeDatabase(dbPath), /idle_summary_snapshots/u);
  closeAllRuntimeDatabases();
  const database = new Database(dbPath, { readonly: true });
  try {
    const version = z.object({ version: z.number() }).parse(
      database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    ).version;
    assert.equal(version, 72);
    for (const table of ['run_logs', 'chat_messages', 'benchmark_attempts', 'runtime_metrics_totals']) {
      assert.equal(columnNames(database, table).includes('throughput_json'), false, `${table} gained a column`);
    }
  } finally {
    database.close();
  }
});

test('run_logs round-trips the fold, keeps it across partial writes, and rejects malformed JSON loudly', () => {
  const dbPath = tempDbPath('siftkit-throughput-run-logs-');
  try {
    const database = getRuntimeDatabase(dbPath);
    const requestId = 'run-with-fold';
    const upsert = (id: string, throughput: typeof FOLD | null) => upsertRepoSearchRun({
      database,
      requestId: id,
      taskKind: 'repo-search',
      identity: UNRECORDED_RUN_IDENTITY,
      prompt: 'measure',
      repoRoot: 'C:/repo',
      model: 'mock-model',
      backend: 'exl3',
      requestMaxTokens: null,
      maxTurns: 1,
      transcriptText: '',
      artifactPayload: { requestId: id },
      terminalState: 'completed',
      startedAtUtc: '2026-09-18T00:00:00.000Z',
      finishedAtUtc: '2026-09-18T00:00:01.000Z',
      requestDurationMs: 1000,
      promptTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      toolTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 1,
      promptEvalDurationMs: 10,
      generationDurationMs: 20,
      throughput,
    });
    upsert(requestId, FOLD);
    assert.deepEqual(queryDashboardRunDetailFromDb(database, requestId)?.run.throughput, FOLD);

    // A later status write without a fold must not erase the complete one.
    upsertRunArtifactPayload({
      database,
      requestId,
      artifactType: 'summary_request',
      artifactPayload: { requestId, question: 'measure' },
      identity: UNRECORDED_RUN_IDENTITY,
    });
    assert.deepEqual(queryDashboardRunDetailFromDb(database, requestId)?.run.throughput, FOLD);

    // A historical row that predates the column reads as unmeasured, never as zeros.
    upsert('run-historical', null);
    assert.equal(queryDashboardRunDetailFromDb(database, 'run-historical')?.run.throughput, null);

    database.prepare("UPDATE run_logs SET throughput_json = '{\"pp\":1}' WHERE run_id = ?").run(requestId);
    assert.throws(() => queryDashboardRunDetailFromDb(database, requestId), /run-with-fold.*throughput_json/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('runtime metrics totals round-trip the fold and read a null column as the empty fold', () => {
  const dbPath = tempDbPath('siftkit-throughput-metrics-');
  try {
    const database = getRuntimeDatabase(dbPath);
    writeMetrics(dbPath, { ...getDefaultMetrics(), throughput: FOLD });
    assert.deepEqual(readMetrics(dbPath).throughput, FOLD);
    database.exec('UPDATE runtime_metrics_totals SET throughput_json = NULL WHERE id = 1');
    assert.deepEqual(readMetrics(dbPath).throughput, emptyInferenceThroughput());
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('idle summary snapshots persist and read back the fold', () => {
  const dbPath = tempDbPath('siftkit-throughput-idle-');
  try {
    const database = getRuntimeDatabase(dbPath);
    persistIdleSummarySnapshot(database, buildIdleSummarySnapshot({ ...getDefaultMetrics(), throughput: FOLD }));
    const [row] = queryRecentSnapshots(database, 1);
    assert.ok(row);
    assert.deepEqual(normalizeIdleSummarySnapshotRow(row)?.throughput, FOLD);
    database.exec('UPDATE idle_summary_snapshots SET throughput_json = NULL');
    const [historical] = queryRecentSnapshots(database, 1);
    assert.ok(historical);
    assert.equal(normalizeIdleSummarySnapshotRow(historical)?.throughput, null);
  } finally {
    closeAllRuntimeDatabases();
  }
});
