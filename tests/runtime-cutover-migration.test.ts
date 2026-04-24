import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { getDefaultConfig, readConfig, writeConfig } from '../dist/status-server/config-store.js';
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

function removeDirectoryWithRetries(targetPath: string, attempts = 40, delayMs = 50): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

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
    removeDirectoryWithRetries(repoRoot);
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

test('runtime cutover migration imports and deletes legacy files that reappear after completion', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    runRuntimeCutoverMigration();

    const staleScriptPath = path.join(runtimeRoot, 'analyze_tool_calls.js');
    const staleTempPath = path.join(runtimeRoot, '6efed4f6745298.tmp');
    const staleLogPath = path.join(
      runtimeRoot,
      'logs',
      'managed-llama',
      '2026-04-13T16-02-13-708Z-1d8275cc-startup',
      'script.stdout.log',
    );
    fs.mkdirSync(path.dirname(staleLogPath), { recursive: true });
    fs.writeFileSync(staleScriptPath, 'console.log("legacy");\n', 'utf8');
    fs.writeFileSync(staleTempPath, 'temporary transcript\n', 'utf8');
    fs.writeFileSync(staleLogPath, 'managed llama stdout\n', 'utf8');

    runRuntimeCutoverMigration();

    assert.equal(fs.existsSync(staleScriptPath), false);
    assert.equal(fs.existsSync(staleTempPath), false);
    assert.equal(fs.existsSync(staleLogPath), false);

    const database = getRuntimeDatabase(getRuntimeDatabasePath());
    const artifacts = database.prepare(`
      SELECT artifact_kind, title, content_text
      FROM runtime_artifacts
      WHERE title IN (?, ?, ?)
      ORDER BY title ASC
    `).all(
      '6efed4f6745298.tmp',
      'analyze_tool_calls.js',
      'logs/managed-llama/2026-04-13T16-02-13-708Z-1d8275cc-startup/script.stdout.log',
    ) as Array<{ artifact_kind: string; title: string; content_text: string }>;
    assert.deepEqual(artifacts, [
      {
        artifact_kind: 'legacy_runtime_file_text',
        title: '6efed4f6745298.tmp',
        content_text: 'temporary transcript\n',
      },
      {
        artifact_kind: 'legacy_runtime_file_text',
        title: 'analyze_tool_calls.js',
        content_text: 'console.log("legacy");\n',
      },
      {
        artifact_kind: 'legacy_runtime_log_text',
        title: 'logs/managed-llama/2026-04-13T16-02-13-708Z-1d8275cc-startup/script.stdout.log',
        content_text: 'managed llama stdout\n',
      },
    ]);
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

test('runtime database initializes fresh app_config schema without re-adding v11 ncpu_moe columns', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();

    const database = getRuntimeDatabase(databasePath);
    const appConfigColumns = database.prepare('PRAGMA table_info(app_config)').all() as Array<{ name: string }>;
    const schemaVersion = database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version?: number } | undefined;

    assert.equal(appConfigColumns.filter((column) => column.name === 'llama_ncpu_moe').length, 1);
    assert.equal(appConfigColumns.filter((column) => column.name === 'server_ncpu_moe').length, 1);
    assert.equal(Number(schemaVersion?.version || 0), 18);
  });
});

test('runtime database migrates schema v10 to v11 without duplicating existing llama_ncpu_moe column', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runtime_schema (id, version) VALUES (1, 10);

      CREATE TABLE app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        backend TEXT NOT NULL,
        policy_mode TEXT NOT NULL,
        raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
        prompt_prefix TEXT,
        runtime_model TEXT,
        llama_base_url TEXT,
        llama_num_ctx INTEGER,
        llama_model_path TEXT,
        llama_temperature REAL,
        llama_top_p REAL,
        llama_top_k INTEGER,
        llama_min_p REAL,
        llama_presence_penalty REAL,
        llama_repetition_penalty REAL,
        llama_max_tokens INTEGER,
        llama_threads INTEGER,
        llama_ncpu_moe INTEGER,
        llama_flash_attention INTEGER CHECK (llama_flash_attention IN (0, 1) OR llama_flash_attention IS NULL),
        llama_parallel_slots INTEGER,
        llama_reasoning TEXT,
        thresholds_min_characters_for_summary INTEGER NOT NULL,
        thresholds_min_lines_for_summary INTEGER NOT NULL,
        interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
        interactive_wrapped_commands_json TEXT NOT NULL,
        interactive_idle_timeout_ms INTEGER NOT NULL,
        interactive_max_transcript_characters INTEGER NOT NULL,
        interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
        server_executable_path TEXT,
        server_base_url TEXT,
        server_bind_host TEXT,
        server_port INTEGER,
        server_model_path TEXT,
        server_num_ctx INTEGER,
        server_gpu_layers INTEGER,
        server_threads INTEGER,
        server_flash_attention INTEGER CHECK (server_flash_attention IN (0, 1) OR server_flash_attention IS NULL),
        server_parallel_slots INTEGER,
        server_batch_size INTEGER,
        server_ubatch_size INTEGER,
        server_cache_ram INTEGER,
        server_kv_cache_quant TEXT,
        server_max_tokens INTEGER,
        server_temperature REAL,
        server_top_p REAL,
        server_top_k INTEGER,
        server_min_p REAL,
        server_presence_penalty REAL,
        server_repetition_penalty REAL,
        server_reasoning TEXT,
        server_reasoning_budget INTEGER,
        server_reasoning_budget_message TEXT,
        server_startup_timeout_ms INTEGER,
        server_healthcheck_timeout_ms INTEGER,
        server_healthcheck_interval_ms INTEGER,
        server_verbose_logging INTEGER CHECK (server_verbose_logging IN (0, 1) OR server_verbose_logging IS NULL),
        server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
        server_llama_active_preset_id TEXT,
        operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{"summary":["find_text","read_lines","json_filter"],"read-only":["repo_rg","repo_get_content","repo_get_childitem","repo_select_string","repo_git","repo_pwd","repo_ls","repo_select_object","repo_where_object","repo_sort_object","repo_group_object","repo_measure_object","repo_foreach_object","repo_format_table","repo_format_list","repo_out_string","repo_convertto_json","repo_convertfrom_json","repo_get_unique","repo_join_string"],"full":[]}',
        presets_json TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);
    legacy.close();

    closeRuntimeDatabase();
    const migrated = getRuntimeDatabase(databasePath);
    const appConfigColumns = migrated.prepare('PRAGMA table_info(app_config)').all() as Array<{ name: string }>;
    const schemaVersion = migrated.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version?: number } | undefined;

    assert.equal(appConfigColumns.filter((column) => column.name === 'llama_ncpu_moe').length, 1);
    assert.equal(appConfigColumns.filter((column) => column.name === 'server_ncpu_moe').length, 1);
    assert.equal(Number(schemaVersion?.version || 0), 18);
  });
});

test('runtime database migrates schema v5 GPU fields to schema v6 boolean-only status storage', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runtime_schema (id, version) VALUES (1, 5);

      CREATE TABLE app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        backend TEXT NOT NULL,
        policy_mode TEXT NOT NULL,
        raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
        prompt_prefix TEXT,
        runtime_model TEXT,
        llama_base_url TEXT,
        llama_num_ctx INTEGER,
        llama_model_path TEXT,
        llama_temperature REAL,
        llama_top_p REAL,
        llama_top_k INTEGER,
        llama_min_p REAL,
        llama_presence_penalty REAL,
        llama_repetition_penalty REAL,
        llama_max_tokens INTEGER,
        llama_gpu_layers INTEGER,
        llama_threads INTEGER,
        llama_flash_attention INTEGER CHECK (llama_flash_attention IN (0, 1) OR llama_flash_attention IS NULL),
        llama_parallel_slots INTEGER,
        llama_reasoning TEXT,
        thresholds_min_characters_for_summary INTEGER NOT NULL,
        thresholds_min_lines_for_summary INTEGER NOT NULL,
        interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
        interactive_wrapped_commands_json TEXT NOT NULL,
        interactive_idle_timeout_ms INTEGER NOT NULL,
        interactive_max_transcript_characters INTEGER NOT NULL,
        interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
        server_startup_script TEXT,
        server_shutdown_script TEXT,
        server_startup_timeout_ms INTEGER,
        server_healthcheck_timeout_ms INTEGER,
        server_healthcheck_interval_ms INTEGER,
        server_verbose_logging INTEGER CHECK (server_verbose_logging IN (0, 1) OR server_verbose_logging IS NULL),
        server_verbose_args_json TEXT NOT NULL,
        operation_mode_allowed_tools_json TEXT NOT NULL,
        presets_json TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
      INSERT INTO app_config (
        id, version, backend, policy_mode, raw_log_retention, prompt_prefix, runtime_model,
        llama_base_url, llama_num_ctx, llama_model_path, llama_temperature, llama_top_p,
        llama_top_k, llama_min_p, llama_presence_penalty, llama_repetition_penalty,
        llama_max_tokens, llama_gpu_layers, llama_threads, llama_flash_attention,
        llama_parallel_slots, llama_reasoning, thresholds_min_characters_for_summary,
        thresholds_min_lines_for_summary, interactive_enabled, interactive_wrapped_commands_json,
        interactive_idle_timeout_ms, interactive_max_transcript_characters, interactive_transcript_retention,
        server_startup_script, server_shutdown_script, server_startup_timeout_ms,
        server_healthcheck_timeout_ms, server_healthcheck_interval_ms, server_verbose_logging,
        server_verbose_args_json, operation_mode_allowed_tools_json, presets_json, updated_at_utc
      ) VALUES (
        1, '0.1.0', 'llama.cpp', 'conservative', 1, '', 'legacy-model',
        'http://127.0.0.1:8080', 4096, NULL, 0.2, 0.95,
        20, 0, 0, 1,
        1024, 999, -1, 1,
        1, 'off', 500,
        16, 1, '[]',
        1000, 60000, 1,
        NULL, NULL, 1000,
        1000, 1000, 0,
        '[]', '{"summary":["find_text"],"read-only":[],"full":[]}', '[]', '2026-04-01T00:00:00.000Z'
      );

      CREATE TABLE runtime_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status_text TEXT NOT NULL CHECK (status_text IN ('true', 'false', 'lock_requested', 'foreign_lock')),
        updated_at_utc TEXT NOT NULL
      );
      INSERT INTO runtime_status (id, status_text, updated_at_utc)
      VALUES (1, 'foreign_lock', '2026-04-01T00:00:00.000Z');
    `);
    legacy.close();

    closeRuntimeDatabase();
    const database = getRuntimeDatabase(databasePath);
    const versionRow = database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version: number };
    const appConfigColumns = database.prepare('PRAGMA table_info(app_config)').all() as Array<{ name: string }>;
    const runtimeStatusSql = database.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_status'
    `).get() as { sql: string };

    assert.equal(versionRow.version, 18);
    assert.equal(appConfigColumns.some((column) => column.name === 'llama_gpu_layers'), false);
    assert.equal(appConfigColumns.some((column) => column.name === 'server_kv_cache_quant'), true);
    assert.equal(appConfigColumns.some((column) => column.name === 'server_llama_presets_json'), true);
    assert.equal(appConfigColumns.some((column) => column.name === 'server_reasoning_budget_message'), true);
    assert.equal(readStatusText(databasePath), 'false');
    assert.match(runtimeStatusSql.sql, /status_text IN \('true', 'false'\)/u);
  });
});

test('runtime database migrates stored legacy planner tool names to canonical native ones', () => {
  withTempRepo(() => {
    const databasePath = getRuntimeDatabasePath();
    const config = getDefaultConfig();
    config.OperationModeAllowedTools = {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': ['repo_rg', 'repo_get_content', 'repo_get_childitem', 'repo_select_string', 'repo_git', 'repo_pwd', 'repo_ls'],
      full: [],
    };
    config.Presets = [
      {
        id: 'custom-search',
        label: 'Custom Search',
        presetKind: 'repo-search',
        operationMode: 'read-only',
        allowedTools: ['repo_get_content', 'repo_get_childitem', 'repo_ls', 'repo_select_string', 'repo_pwd', 'repo_git'],
        surfaces: ['web'],
      },
    ];
    writeConfig(databasePath, config);

    const prepared = getRuntimeDatabase(databasePath);
    prepared.prepare('UPDATE runtime_schema SET version = 12 WHERE id = 1').run();
    prepared.prepare(`
      UPDATE app_config
      SET operation_mode_allowed_tools_json = ?, presets_json = ?
      WHERE id = 1
    `).run(
      '{"summary":["find_text","read_lines","json_filter"],"read-only":["repo_rg","repo_get_content","repo_get_childitem","repo_select_string","repo_git","repo_pwd","repo_ls"],"full":[]}',
      '[{"id":"custom-search","label":"Custom Search","presetKind":"repo-search","operationMode":"read-only","allowedTools":["repo_get_content","repo_get_childitem","repo_ls","repo_select_string","repo_pwd","repo_git"],"surfaces":["web"]}]',
    );

    closeRuntimeDatabase();
    const migrated = getRuntimeDatabase(databasePath);
    const row = migrated.prepare(`
      SELECT operation_mode_allowed_tools_json, presets_json
      FROM app_config
      WHERE id = 1
    `).get() as {
      operation_mode_allowed_tools_json: string;
      presets_json: string;
    };
    const schemaVersion = migrated.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version?: number } | undefined;

    assert.equal(Number(schemaVersion?.version || 0), 18);
    assert.deepEqual(JSON.parse(row.operation_mode_allowed_tools_json), {
      summary: ['find_text', 'read_lines', 'json_filter', 'json_get'],
      'read-only': ['repo_rg', 'repo_read_file', 'repo_list_files', 'repo_git'],
      full: [],
    });
    const presets = JSON.parse(row.presets_json) as Array<{ id: string; allowedTools: string[] }>;
    const customSearchPreset = presets.find((preset) => preset.id === 'custom-search');
    assert.deepEqual(customSearchPreset?.allowedTools, [
      'repo_read_file',
      'repo_list_files',
      'repo_rg',
      'repo_git',
    ]);
  });
});

test('runtime cutover migration imports and deletes managed-llama .log files', () => {
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

    assert.equal(fs.existsSync(managedLlamaLogPath), false);
    const database = getRuntimeDatabase(getRuntimeDatabasePath());
    const artifact = database.prepare(`
      SELECT artifact_kind, title, content_text
      FROM runtime_artifacts
      WHERE title = ?
      LIMIT 1
    `).get(
      'logs/managed-llama/2026-04-13T16-02-13-708Z-1d8275cc-startup/llama.stderr.log',
    ) as { artifact_kind: string; title: string; content_text: string } | undefined;
    assert.deepEqual(artifact, {
      artifact_kind: 'legacy_runtime_log_text',
      title: 'logs/managed-llama/2026-04-13T16-02-13-708Z-1d8275cc-startup/llama.stderr.log',
      content_text: 'live stderr log\n',
    });
    const marker = getRuntimeMetadataValue('runtime_cutover_v1_complete');
    assert.ok(typeof marker === 'string' && marker.length > 0);
  });
});
