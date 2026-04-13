import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { getDefaultConfig, readConfig } from '../dist/status-server/config-store.js';
import { readStatusText } from '../dist/status-server/status-file.js';
import { getDefaultMetrics, readMetrics } from '../dist/status-server/metrics.js';
import { readObservedBudgetState } from '../dist/state/observed-budget.js';
import { readChatSessions } from '../dist/state/chat-sessions.js';
import { runRuntimeCutoverMigration } from '../dist/status-server/runtime-cutover.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
  getRuntimeDatabasePath,
  getRuntimeMetadataValue,
} from '../dist/state/runtime-db.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-cutover-migration-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(repoRoot);
    fn(repoRoot);
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('runtime cutover migration imports legacy files and deletes them', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const legacyConfigPath = path.join(runtimeRoot, 'config.json');
    const legacyStatusPath = path.join(runtimeRoot, 'status', 'inference.txt');
    const legacyMetricsPath = path.join(runtimeRoot, 'metrics', 'compression.json');
    const legacyObservedBudgetPath = path.join(runtimeRoot, 'metrics', 'observed-budget.json');
    const legacyChatSessionPath = path.join(runtimeRoot, 'chat', 'sessions', 'session_legacy-1.json');

    fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyStatusPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyMetricsPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyChatSessionPath), { recursive: true });

    const legacyConfig = getDefaultConfig();
    legacyConfig.PolicyMode = 'aggressive';
    fs.writeFileSync(legacyConfigPath, JSON.stringify(legacyConfig, null, 2), 'utf8');
    fs.writeFileSync(legacyStatusPath, 'true\n', 'utf8');

    const legacyMetrics = getDefaultMetrics();
    legacyMetrics.completedRequestCount = 5;
    legacyMetrics.outputTokensTotal = 42;
    fs.writeFileSync(legacyMetricsPath, JSON.stringify(legacyMetrics, null, 2), 'utf8');

    fs.writeFileSync(legacyObservedBudgetPath, JSON.stringify({
      observedTelemetrySeen: true,
      lastKnownCharsPerToken: 3.5,
      updatedAtUtc: '2026-04-01T00:00:00.000Z',
    }, null, 2), 'utf8');

    fs.writeFileSync(legacyChatSessionPath, JSON.stringify({
      id: 'legacy-1',
      title: 'Legacy chat session',
      model: 'gpt-5.4',
      contextWindowTokens: 128000,
      thinkingEnabled: true,
      mode: 'chat',
      planRepoRoot: repoRoot,
      condensedSummary: '',
      createdAtUtc: '2026-04-01T00:00:00.000Z',
      updatedAtUtc: '2026-04-01T00:00:00.000Z',
      messages: [],
      hiddenToolContexts: [],
    }, null, 2), 'utf8');

    runRuntimeCutoverMigration();

    assert.equal(fs.existsSync(legacyConfigPath), false);
    assert.equal(fs.existsSync(legacyStatusPath), false);
    assert.equal(fs.existsSync(legacyMetricsPath), false);
    assert.equal(fs.existsSync(legacyObservedBudgetPath), false);
    assert.equal(fs.existsSync(legacyChatSessionPath), false);

    const migratedConfig = readConfig(getRuntimeDatabasePath());
    assert.equal(migratedConfig.PolicyMode, 'aggressive');
    assert.equal(readStatusText(getRuntimeDatabasePath()), 'true');
    assert.equal(readMetrics(getRuntimeDatabasePath()).completedRequestCount, 5);
    assert.equal(readMetrics(getRuntimeDatabasePath()).outputTokensTotal, 42);
    assert.equal(readObservedBudgetState().observedTelemetrySeen, true);
    assert.equal(readObservedBudgetState().lastKnownCharsPerToken, 3.5);

    const sessions = readChatSessions(runtimeRoot);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'legacy-1');

    const marker = getRuntimeMetadataValue('runtime_cutover_v1_complete');
    assert.ok(typeof marker === 'string' && marker.length > 0);
  });
});

test('runtime cutover migration fails when legacy files reappear after completion', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    runRuntimeCutoverMigration();

    const legacyConfigPath = path.join(runtimeRoot, 'config.json');
    fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true });
    fs.writeFileSync(legacyConfigPath, '{}', 'utf8');

    assert.throws(
      () => runRuntimeCutoverMigration(),
      /legacy runtime files detected after migration/i,
    );
  });
});

test('runtime cutover migration is idempotent on fresh runtime roots', () => {
  withTempRepo(() => {
    runRuntimeCutoverMigration();
    runRuntimeCutoverMigration();
    const marker = getRuntimeMetadataValue('runtime_cutover_v1_complete');
    assert.ok(typeof marker === 'string' && marker.length > 0);
  });
});

test('runtime cutover migration heals legacy schema drift where runtime_artifacts is missing at schema version 1', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();
    getRuntimeDatabase(databasePath);
    closeRuntimeDatabase();

    const drifted = new Database(databasePath);
    drifted.exec(`
      DROP TABLE runtime_artifacts;
      DROP INDEX IF EXISTS idx_runtime_artifacts_kind_created;
      DROP INDEX IF EXISTS idx_runtime_artifacts_request;
      UPDATE runtime_schema SET version = 1 WHERE id = 1;
    `);
    drifted.close();

    runRuntimeCutoverMigration();
    closeRuntimeDatabase();

    const verify = new Database(databasePath, { readonly: true });
    const tableRow = verify.prepare(`
      SELECT 1 AS exists_flag
      FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_artifacts'
      LIMIT 1
    `).get() as { exists_flag?: number } | undefined;
    const indexRows = verify.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name IN ('idx_runtime_artifacts_kind_created', 'idx_runtime_artifacts_request')
      ORDER BY name ASC
    `).all() as Array<{ name?: string }>;
    verify.close();

    assert.equal(Number(tableRow?.exists_flag), 1);
    assert.deepEqual(indexRows.map((row) => String(row.name)), [
      'idx_runtime_artifacts_kind_created',
      'idx_runtime_artifacts_request',
    ]);
  });
});

test('runtime cutover migration ignores non-legacy managed-llama .log files', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const managedLlamaLogPath = path.join(
      runtimeRoot,
      'logs',
      'managed-llama',
      '2026-04-13T16-02-13-708Z-1d8275cc-startup',
      'llama.stderr.log',
    );
    fs.mkdirSync(path.dirname(managedLlamaLogPath), { recursive: true });
    fs.writeFileSync(managedLlamaLogPath, 'live stderr log\n', 'utf8');

    runRuntimeCutoverMigration();

    assert.equal(fs.existsSync(managedLlamaLogPath), true);
    const marker = getRuntimeMetadataValue('runtime_cutover_v1_complete');
    assert.ok(typeof marker === 'string' && marker.length > 0);
  });
});
