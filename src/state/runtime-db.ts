import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';

export type RuntimeDatabase = InstanceType<typeof Database>;

const CURRENT_SCHEMA_VERSION = 10;

let cachedDatabasePath: string | null = null;
let cachedDatabase: RuntimeDatabase | null = null;

function tableExists(database: RuntimeDatabase, name: string): boolean {
  const row = database.prepare(`
    SELECT 1 AS exists_flag
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name) as { exists_flag?: number } | undefined;
  return Number(row?.exists_flag) === 1;
}

function tableHasColumn(database: RuntimeDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }
  const escapedTableName = String(tableName).replace(/'/gu, "''");
  const row = database.prepare(`
    SELECT 1 AS exists_flag
    FROM pragma_table_info('${escapedTableName}')
    WHERE name = ?
    LIMIT 1
  `).get(columnName) as { exists_flag?: number } | undefined;
  return Number(row?.exists_flag) === 1;
}

function detectEffectiveSchemaVersion(database: RuntimeDatabase, storedVersion: number): number {
  if (tableHasColumn(database, 'app_config', 'server_reasoning_budget_message')) {
    return 10;
  }
  if (tableHasColumn(database, 'app_config', 'server_llama_presets_json')) {
    return 9;
  }
  if (tableHasColumn(database, 'app_config', 'server_kv_cache_quant')) {
    return 8;
  }
  if (tableHasColumn(database, 'app_config', 'server_reasoning_budget')) {
    return 7;
  }
  if (tableHasColumn(database, 'app_config', 'operation_mode_allowed_tools_json')) {
    return 5;
  }
  if (tableHasColumn(database, 'app_config', 'presets_json') || tableHasColumn(database, 'chat_sessions', 'preset_id')) {
    return 4;
  }
  return storedVersion;
}

function getSchemaVersion(database: RuntimeDatabase): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  const row = database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version?: number } | undefined;
  return Number.isFinite(row?.version) ? Number(row?.version) : 0;
}

function setSchemaVersion(database: RuntimeDatabase, version: number): void {
  database.prepare(`
    INSERT INTO runtime_schema (id, version)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version
  `).run(version);
}

function applyBaseSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
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

    CREATE TABLE IF NOT EXISTS runtime_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status_text TEXT NOT NULL
        CHECK (status_text IN ('true', 'false')),
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_metrics_totals (
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
      request_duration_ms_total INTEGER NOT NULL,
      completed_request_count INTEGER NOT NULL,
      task_totals_json TEXT NOT NULL,
      tool_stats_json TEXT NOT NULL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS observed_budget_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      observed_telemetry_seen INTEGER NOT NULL CHECK (observed_telemetry_seen IN (0, 1)),
      last_known_chars_per_token REAL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      context_window_tokens INTEGER NOT NULL,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      preset_id TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
      plan_repo_root TEXT NOT NULL,
      condensed_summary TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      input_tokens_estimate INTEGER NOT NULL,
      output_tokens_estimate INTEGER NOT NULL,
      thinking_tokens INTEGER NOT NULL,
      input_tokens_estimated INTEGER NOT NULL CHECK (input_tokens_estimated IN (0, 1)),
      output_tokens_estimated INTEGER NOT NULL CHECK (output_tokens_estimated IN (0, 1)),
      thinking_tokens_estimated INTEGER NOT NULL CHECK (thinking_tokens_estimated IN (0, 1)),
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      associated_tool_tokens INTEGER,
      thinking_content TEXT,
      created_at_utc TEXT NOT NULL,
      source_run_id TEXT,
      compressed_into_summary INTEGER NOT NULL CHECK (compressed_into_summary IN (0, 1)),
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS chat_hidden_tool_contexts (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source_message_id TEXT,
      created_at_utc TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_artifacts (
      id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      request_id TEXT,
      title TEXT,
      content_text TEXT,
      content_json TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_kind_created
      ON runtime_artifacts(artifact_kind, created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_request
      ON runtime_artifacts(request_id, created_at_utc DESC);
  `);
}

function ensureRuntimeArtifactsSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_artifacts (
      id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      request_id TEXT,
      title TEXT,
      content_text TEXT,
      content_json TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_kind_created
      ON runtime_artifacts(artifact_kind, created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_request
      ON runtime_artifacts(request_id, created_at_utc DESC);
  `);
}

function ensureManagedLlamaAndBenchmarkMatrixSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_llama_runs (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      script_path TEXT,
      base_url TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'ready', 'failed', 'stopped', 'sync_completed')),
      exit_code INTEGER,
      error_message TEXT,
      started_at_utc TEXT NOT NULL,
      finished_at_utc TEXT,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_llama_runs_started
      ON managed_llama_runs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_managed_llama_runs_status_started
      ON managed_llama_runs(status, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS managed_llama_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES managed_llama_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL
        CHECK (stream_kind IN (
          'startup_script_stdout',
          'startup_script_stderr',
          'llama_stdout',
          'llama_stderr',
          'startup_review',
          'startup_failure'
        )),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_llama_log_chunks_run_stream
      ON managed_llama_log_chunks(run_id, stream_kind, sequence ASC);

    CREATE TABLE IF NOT EXISTS benchmark_matrix_sessions (
      id TEXT PRIMARY KEY,
      manifest_path TEXT NOT NULL,
      fixture_root TEXT NOT NULL,
      config_url TEXT NOT NULL,
      prompt_prefix_file TEXT,
      request_timeout_seconds INTEGER NOT NULL,
      selected_run_ids_json TEXT NOT NULL,
      baseline_restore_status TEXT NOT NULL
        CHECK (baseline_restore_status IN ('pending', 'completed', 'failed')),
      baseline_restore_error TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      started_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_sessions_started
      ON benchmark_matrix_sessions(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_sessions_status_started
      ON benchmark_matrix_sessions(status, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS benchmark_matrix_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES benchmark_matrix_sessions(id) ON DELETE CASCADE,
      run_index INTEGER NOT NULL,
      run_identifier TEXT NOT NULL,
      label TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_path TEXT NOT NULL,
      start_script TEXT NOT NULL,
      prompt_prefix_file TEXT,
      reasoning TEXT NOT NULL CHECK (reasoning IN ('on', 'off', 'auto')),
      sampling_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      error_message TEXT,
      benchmark_run_uri TEXT,
      started_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      updated_at_utc TEXT NOT NULL,
      UNIQUE(session_id, run_index, run_identifier)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_runs_session_started
      ON benchmark_matrix_runs(session_id, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_runs_status_started
      ON benchmark_matrix_runs(status, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS benchmark_matrix_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES benchmark_matrix_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL
        CHECK (stream_kind IN (
          'launcher_stdout',
          'launcher_stderr',
          'benchmark_stdout',
          'benchmark_stderr',
          'stop_stdout',
          'stop_stderr',
          'force_stop_stdout',
          'force_stop_stderr'
        )),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_logs_run_stream
      ON benchmark_matrix_logs(run_id, stream_kind, sequence ASC);
  `);
}

function ensureSchema(database: RuntimeDatabase): void {
  database.exec('PRAGMA foreign_keys = ON;');
  const storedVersion = getSchemaVersion(database);
  let currentVersion = detectEffectiveSchemaVersion(database, storedVersion);
  if (currentVersion > storedVersion) {
    setSchemaVersion(database, currentVersion);
  }
  if (currentVersion <= 0) {
    applyBaseSchema(database);
    ensureManagedLlamaAndBenchmarkMatrixSchema(database);
    setSchemaVersion(database, CURRENT_SCHEMA_VERSION);
    return;
  }
  if (currentVersion < 2) {
    ensureRuntimeArtifactsSchema(database);
    setSchemaVersion(database, 2);
    currentVersion = 2;
  }
  if (currentVersion < 3) {
    ensureManagedLlamaAndBenchmarkMatrixSchema(database);
    setSchemaVersion(database, 3);
    currentVersion = 3;
  }
  if (currentVersion < 4) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN presets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE chat_sessions ADD COLUMN preset_id TEXT;
    `);
    setSchemaVersion(database, 4);
    currentVersion = 4;
  }
  if (currentVersion < 5) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{"summary":["find_text","read_lines","json_filter"],"read-only":["repo_rg","repo_get_content","repo_get_childitem","repo_select_string","repo_git","repo_pwd","repo_ls","repo_select_object","repo_where_object","repo_sort_object","repo_group_object","repo_measure_object","repo_foreach_object","repo_format_table","repo_format_list","repo_out_string","repo_convertto_json","repo_convertfrom_json","repo_get_unique","repo_join_string"],"full":[]}';
    `);
    setSchemaVersion(database, 5);
    currentVersion = 5;
  }
  if (currentVersion < 6) {
    database.exec(`
      ALTER TABLE app_config RENAME TO app_config_v5;
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
        operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{"summary":["find_text","read_lines","json_filter"],"read-only":["repo_rg","repo_get_content","repo_get_childitem","repo_select_string","repo_git","repo_pwd","repo_ls","repo_select_object","repo_where_object","repo_sort_object","repo_group_object","repo_measure_object","repo_foreach_object","repo_format_table","repo_format_list","repo_out_string","repo_convertto_json","repo_convertfrom_json","repo_get_unique","repo_join_string"],"full":[]}',
        presets_json TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
      INSERT INTO app_config (
        id, version, backend, policy_mode, raw_log_retention, prompt_prefix, runtime_model,
        llama_base_url, llama_num_ctx, llama_model_path, llama_temperature, llama_top_p,
        llama_top_k, llama_min_p, llama_presence_penalty, llama_repetition_penalty, llama_max_tokens,
        llama_threads, llama_flash_attention, llama_parallel_slots, llama_reasoning,
        thresholds_min_characters_for_summary, thresholds_min_lines_for_summary, interactive_enabled,
        interactive_wrapped_commands_json, interactive_idle_timeout_ms, interactive_max_transcript_characters,
        interactive_transcript_retention, server_startup_script, server_shutdown_script,
        server_startup_timeout_ms, server_healthcheck_timeout_ms, server_healthcheck_interval_ms,
        server_verbose_logging, server_verbose_args_json, operation_mode_allowed_tools_json, presets_json, updated_at_utc
      )
      SELECT
        id, version, backend, policy_mode, raw_log_retention, prompt_prefix, runtime_model,
        llama_base_url, llama_num_ctx, llama_model_path, llama_temperature, llama_top_p,
        llama_top_k, llama_min_p, llama_presence_penalty, llama_repetition_penalty, llama_max_tokens,
        llama_threads, llama_flash_attention, llama_parallel_slots, llama_reasoning,
        thresholds_min_characters_for_summary, thresholds_min_lines_for_summary, interactive_enabled,
        interactive_wrapped_commands_json, interactive_idle_timeout_ms, interactive_max_transcript_characters,
        interactive_transcript_retention, server_startup_script, server_shutdown_script,
        server_startup_timeout_ms, server_healthcheck_timeout_ms, server_healthcheck_interval_ms,
        server_verbose_logging, server_verbose_args_json, operation_mode_allowed_tools_json, presets_json, updated_at_utc
      FROM app_config_v5;
      DROP TABLE app_config_v5;

      ALTER TABLE runtime_status RENAME TO runtime_status_v5;
      CREATE TABLE runtime_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status_text TEXT NOT NULL CHECK (status_text IN ('true', 'false')),
        updated_at_utc TEXT NOT NULL
      );
      INSERT INTO runtime_status (id, status_text, updated_at_utc)
      SELECT
        id,
        CASE
          WHEN lower(trim(status_text)) = 'true' THEN 'true'
          ELSE 'false'
        END,
        updated_at_utc
      FROM runtime_status_v5;
      DROP TABLE runtime_status_v5;
    `);
    setSchemaVersion(database, 6);
    currentVersion = 6;
  }
  if (currentVersion < 7) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_executable_path TEXT;
      ALTER TABLE app_config ADD COLUMN server_base_url TEXT;
      ALTER TABLE app_config ADD COLUMN server_bind_host TEXT;
      ALTER TABLE app_config ADD COLUMN server_port INTEGER;
      ALTER TABLE app_config ADD COLUMN server_model_path TEXT;
      ALTER TABLE app_config ADD COLUMN server_num_ctx INTEGER;
      ALTER TABLE app_config ADD COLUMN server_gpu_layers INTEGER;
      ALTER TABLE app_config ADD COLUMN server_threads INTEGER;
      ALTER TABLE app_config ADD COLUMN server_flash_attention INTEGER CHECK (server_flash_attention IN (0, 1) OR server_flash_attention IS NULL);
      ALTER TABLE app_config ADD COLUMN server_parallel_slots INTEGER;
      ALTER TABLE app_config ADD COLUMN server_batch_size INTEGER;
      ALTER TABLE app_config ADD COLUMN server_ubatch_size INTEGER;
      ALTER TABLE app_config ADD COLUMN server_cache_ram INTEGER;
      ALTER TABLE app_config ADD COLUMN server_max_tokens INTEGER;
      ALTER TABLE app_config ADD COLUMN server_temperature REAL;
      ALTER TABLE app_config ADD COLUMN server_top_p REAL;
      ALTER TABLE app_config ADD COLUMN server_top_k INTEGER;
      ALTER TABLE app_config ADD COLUMN server_min_p REAL;
      ALTER TABLE app_config ADD COLUMN server_presence_penalty REAL;
      ALTER TABLE app_config ADD COLUMN server_repetition_penalty REAL;
      ALTER TABLE app_config ADD COLUMN server_reasoning TEXT;
      ALTER TABLE app_config ADD COLUMN server_reasoning_budget INTEGER;
    `);
    setSchemaVersion(database, 7);
    currentVersion = 7;
  }
  if (currentVersion < 8) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_kv_cache_quant TEXT;
    `);
    setSchemaVersion(database, 8);
    currentVersion = 8;
  }
  if (currentVersion < 9) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_llama_presets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE app_config ADD COLUMN server_llama_active_preset_id TEXT;
    `);
    setSchemaVersion(database, 9);
    currentVersion = 9;
  }
  if (currentVersion < 10) {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_reasoning_budget_message TEXT;
    `);
    setSchemaVersion(database, 10);
    currentVersion = 10;
  }
  ensureRuntimeArtifactsSchema(database);
  ensureManagedLlamaAndBenchmarkMatrixSchema(database);
}

export function getRepoRuntimeRoot(startPath: string = process.cwd()): string {
  const repoRoot = findNearestSiftKitRepoRoot(startPath);
  const resolvedBaseRoot = repoRoot ? path.resolve(repoRoot) : path.resolve(startPath);
  return path.join(resolvedBaseRoot, '.siftkit');
}

export function getRuntimeDatabasePath(startPath: string = process.cwd()): string {
  return path.join(getRepoRuntimeRoot(startPath), 'runtime.sqlite');
}

export function getRuntimeDatabase(databasePath: string = getRuntimeDatabasePath()): RuntimeDatabase {
  const resolvedPath = path.resolve(databasePath);
  if (cachedDatabase && cachedDatabasePath === resolvedPath) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.close();
    cachedDatabase = null;
    cachedDatabasePath = null;
  }
  ensureDirectory(path.dirname(resolvedPath));
  let database: RuntimeDatabase = new Database(resolvedPath);
  try {
    ensureSchema(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a database|SQLITE_NOTADB/iu.test(message)) {
      throw error;
    }
    try {
      database.close();
    } catch {
      // Best effort close before reset.
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const targetPath = `${resolvedPath}${suffix}`;
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
      }
    }
    database = new Database(resolvedPath);
    ensureSchema(database);
  }
  cachedDatabase = database;
  cachedDatabasePath = resolvedPath;
  return database;
}

export function closeRuntimeDatabase(): void {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.close();
  cachedDatabase = null;
  cachedDatabasePath = null;
}

export function getRuntimeMetadataValue(
  key: string,
  databasePath: string = getRuntimeDatabasePath(),
): string | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return null;
  }
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare(`
    SELECT value
    FROM runtime_metadata
    WHERE key = ?
    LIMIT 1
  `).get(normalizedKey) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

export function setRuntimeMetadataValue(
  key: string,
  value: string,
  databasePath: string = getRuntimeDatabasePath(),
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('Runtime metadata key is required.');
  }
  const database = getRuntimeDatabase(databasePath);
  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalizedKey,
    String(value || ''),
    new Date().toISOString(),
  );
}
