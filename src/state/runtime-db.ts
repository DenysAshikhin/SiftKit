import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from '../lib/zod.js';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';

import { SystemClock } from '../assistant/clock.js';
import {
  ASSISTANT_CORE_SCHEMA_SQL,
  ASSISTANT_FTS_SCHEMA_SQL,
  ASSISTANT_MEMORY_SCHEMA_SQL,
  ASSISTANT_DESKTOP_SCHEMA_SQL,
  ASSISTANT_MOBILE_SCHEMA_SQL,
  ASSISTANT_PROACTIVE_SCHEMA_SQL,
  seedAssistantRegistries,
} from '../assistant/storage/schema.js';
import { tableExists, tableHasColumn } from './migrations/schema-introspection.js';
import { MIGRATIONS } from './migrations/registry.js';

export type RuntimeDatabase = InstanceType<typeof Database>;

const VersionRowSchema = z.object({ version: z.number().nullable() });
const MetadataValueRowSchema = z.object({ value: z.string().nullable() });
const FreelistRowSchema = z.object({ freelist_count: z.number().nullable() });
const PageCountRowSchema = z.object({ page_count: z.number().nullable() });

export const CURRENT_SCHEMA_VERSION = 48;
export const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON = '{"summary":["find_text","read_lines","json_filter","json_get"],"read-only":["read","grep","find","ls","git"],"full":[]}';
const OBSOLETE_CHAT_HIDDEN_TOOL_CONTEXTS_TABLE = 'chat_' + 'hidden_' + 'tool_' + 'contexts';

let cachedDatabasePath: string | null = null;
let cachedDatabase: RuntimeDatabase | null = null;

function detectEffectiveSchemaVersion(database: RuntimeDatabase, storedVersion: number): number {
  if (storedVersion >= 13) {
    return storedVersion;
  }
  if (
    tableHasColumn(database, 'app_config', 'llama_ncpu_moe')
    && tableHasColumn(database, 'app_config', 'server_ncpu_moe')
  ) {
    return 11;
  }
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

export function getSchemaVersion(database: RuntimeDatabase): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  const rawRow = database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get();
  const row = rawRow == null ? undefined : VersionRowSchema.parse(rawRow);
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
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
      expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1)),
      prompt_prefix TEXT,
      runtime_model TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
      server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
      server_llama_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1)),
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '${DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON}',
      presets_json TEXT NOT NULL,
      web_search_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_search_usage (
      month TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
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
      speculative_accepted_tokens_total INTEGER NOT NULL,
      speculative_generated_tokens_total INTEGER NOT NULL,
      request_duration_ms_total INTEGER NOT NULL,
      wall_duration_ms_total INTEGER NOT NULL DEFAULT 0,
      stdin_wait_ms_total INTEGER NOT NULL DEFAULT 0,
      server_preflight_ms_total INTEGER NOT NULL DEFAULT 0,
      lock_wait_ms_total INTEGER NOT NULL DEFAULT 0,
      status_running_ms_total INTEGER NOT NULL DEFAULT 0,
      terminal_status_ms_total INTEGER NOT NULL DEFAULT 0,
      completed_request_count INTEGER NOT NULL,
      task_totals_json TEXT NOT NULL,
      tool_stats_json TEXT NOT NULL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS observed_budget_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      observed_telemetry_seen INTEGER NOT NULL CHECK (observed_telemetry_seen IN (0, 1)),
      last_known_chars_per_token REAL,
      observed_chars_total REAL,
      observed_tokens_total REAL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_preset_id TEXT NOT NULL,
      model_preset_json TEXT,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      web_search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_search_enabled IN (0, 1)),
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
      kind TEXT,
      content TEXT NOT NULL,
      input_tokens_estimate INTEGER NOT NULL,
      output_tokens_estimate INTEGER NOT NULL,
      thinking_tokens INTEGER NOT NULL,
      input_tokens_estimated INTEGER NOT NULL CHECK (input_tokens_estimated IN (0, 1)),
      output_tokens_estimated INTEGER NOT NULL CHECK (output_tokens_estimated IN (0, 1)),
      thinking_tokens_estimated INTEGER NOT NULL CHECK (thinking_tokens_estimated IN (0, 1)),
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      prompt_tokens_per_second REAL,
      output_tokens_per_second REAL,
      request_duration_ms INTEGER,
      prompt_eval_duration_ms INTEGER,
      generation_duration_ms INTEGER,
      request_started_at_utc TEXT,
      thinking_started_at_utc TEXT,
      thinking_ended_at_utc TEXT,
      answer_started_at_utc TEXT,
      answer_ended_at_utc TEXT,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      associated_tool_tokens INTEGER,
      thinking_content TEXT,
      tool_call_command TEXT,
      tool_call_turn INTEGER,
      tool_call_max_turns INTEGER,
      tool_call_exit_code INTEGER,
      tool_call_prompt_token_count INTEGER,
      tool_call_output_snippet TEXT,
      tool_call_output TEXT,
      created_at_utc TEXT NOT NULL,
      source_run_id TEXT,
      compressed_into_summary INTEGER NOT NULL CHECK (compressed_into_summary IN (0, 1)),
      grounding_status TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_updated
      ON runtime_artifacts(updated_at_utc DESC, id DESC);

    CREATE TABLE IF NOT EXISTS runtime_error_events (
      id TEXT PRIMARY KEY,
      created_at_utc TEXT NOT NULL,
      source TEXT NOT NULL,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      request_id TEXT,
      task_kind TEXT,
      status_code INTEGER NOT NULL,
      error_name TEXT NOT NULL,
      error_message TEXT NOT NULL,
      error_stack TEXT,
      cause_name TEXT,
      cause_message TEXT,
      cause_stack TEXT,
      diagnostic_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_created
      ON runtime_error_events(created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_route_created
      ON runtime_error_events(route, created_at_utc DESC);
  `);
  database.exec(`DROP TABLE IF EXISTS ${OBSOLETE_CHAT_HIDDEN_TOOL_CONTEXTS_TABLE}`);
}

export function ensureRuntimeErrorEventsSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_error_events (
      id TEXT PRIMARY KEY,
      created_at_utc TEXT NOT NULL,
      source TEXT NOT NULL,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      request_id TEXT,
      task_kind TEXT,
      status_code INTEGER NOT NULL,
      error_name TEXT NOT NULL,
      error_message TEXT NOT NULL,
      error_stack TEXT,
      cause_name TEXT,
      cause_message TEXT,
      cause_stack TEXT,
      diagnostic_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_created
      ON runtime_error_events(created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_route_created
      ON runtime_error_events(route, created_at_utc DESC);
  `);
}

export function ensureRuntimeArtifactsSchema(database: RuntimeDatabase): void {
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
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_updated
      ON runtime_artifacts(updated_at_utc DESC, id DESC);
  `);
}

export function ensureChatMessageTimelineSchema(database: RuntimeDatabase): void {
  if (!tableExists(database, 'chat_messages')) {
    return;
  }
  const alterStatements: string[] = [];
  const columns: Array<{ name: string; sql: string }> = [
    { name: 'kind', sql: 'ALTER TABLE chat_messages ADD COLUMN kind TEXT;' },
    { name: 'tool_call_command', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_command TEXT;' },
    { name: 'tool_call_turn', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_turn INTEGER;' },
    { name: 'tool_call_max_turns', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_max_turns INTEGER;' },
    { name: 'tool_call_exit_code', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_exit_code INTEGER;' },
    { name: 'tool_call_prompt_token_count', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_prompt_token_count INTEGER;' },
    { name: 'tool_call_output_snippet', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_output_snippet TEXT;' },
    { name: 'tool_call_output', sql: 'ALTER TABLE chat_messages ADD COLUMN tool_call_output TEXT;' },
    { name: 'grounding_status', sql: 'ALTER TABLE chat_messages ADD COLUMN grounding_status TEXT;' },
    { name: 'images', sql: 'ALTER TABLE chat_messages ADD COLUMN images TEXT;' },
    { name: 'image_meta', sql: 'ALTER TABLE chat_messages ADD COLUMN image_meta TEXT;' },
    { name: 'removed_image_count', sql: 'ALTER TABLE chat_messages ADD COLUMN removed_image_count INTEGER;' },
  ];
  for (const column of columns) {
    if (!tableHasColumn(database, 'chat_messages', column.name)) {
      alterStatements.push(column.sql);
    }
  }
  if (alterStatements.length > 0) {
    database.exec(alterStatements.join('\n'));
  }
}

export function ensureInferenceRunAndBenchmarkMatrixSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inference_runs (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL
        CHECK (backend IN ('llama', 'exl3')),
      purpose TEXT NOT NULL,
      entrypoint_path TEXT,
      base_url TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'ready', 'failed', 'stopped', 'sync_completed')),
      exit_code INTEGER,
      error_message TEXT,
      started_at_utc TEXT NOT NULL,
      finished_at_utc TEXT,
      updated_at_utc TEXT NOT NULL,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      stdout_character_count INTEGER NOT NULL DEFAULT 0,
      stderr_character_count INTEGER NOT NULL DEFAULT 0,
      metrics_updated_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inference_runs_started
      ON inference_runs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_status_started
      ON inference_runs(status, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_backend_started
      ON inference_runs(backend, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS inference_run_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL
        CHECK (stream_kind IN (
          'launcher_stdout',
          'launcher_stderr',
          'engine_stdout',
          'engine_stderr',
          'startup_review',
          'startup_failure'
        )),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_run_stream
      ON inference_run_log_chunks(run_id, stream_kind, sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_created_at
      ON inference_run_log_chunks(created_at_utc);

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

export function ensureDashboardBenchmarkSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_question_presets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task_kind TEXT NOT NULL CHECK (task_kind IN ('repo-search', 'summary')),
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      seeded_key TEXT UNIQUE,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_question_presets_task_title
      ON benchmark_question_presets(task_kind, title COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS benchmark_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      question_preset_count INTEGER NOT NULL,
      case_count INTEGER NOT NULL,
      repetitions INTEGER NOT NULL,
      current_case_index INTEGER,
      current_prompt_index INTEGER,
      current_repeat_index INTEGER,
      restore_status TEXT NOT NULL CHECK (restore_status IN ('pending', 'completed', 'failed')),
      restore_error TEXT,
      original_config_json TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_sessions_status_started
      ON benchmark_sessions(status, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_benchmark_sessions_started
      ON benchmark_sessions(started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS benchmark_cases (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
      case_index INTEGER NOT NULL,
      label TEXT NOT NULL,
      managed_preset_id TEXT NOT NULL,
      managed_preset_label TEXT NOT NULL,
      managed_preset_json TEXT NOT NULL,
      spec_override_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(session_id, case_index)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_cases_session_index
      ON benchmark_cases(session_id, case_index ASC);

    CREATE TABLE IF NOT EXISTS benchmark_attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES benchmark_cases(id) ON DELETE CASCADE,
      question_preset_id TEXT NOT NULL REFERENCES benchmark_question_presets(id),
      task_kind TEXT NOT NULL CHECK (task_kind IN ('repo-search', 'summary')),
      prompt_title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      case_label TEXT NOT NULL,
      managed_preset_id TEXT NOT NULL,
      managed_preset_label TEXT NOT NULL,
      case_index INTEGER NOT NULL,
      prompt_index INTEGER NOT NULL,
      repeat_index INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
      output_text TEXT,
      error TEXT,
      run_id TEXT,
      managed_run_id TEXT,
      duration_ms INTEGER,
      prompt_tokens_per_second REAL,
      generation_tokens_per_second REAL,
      acceptance_rate REAL,
      output_tokens INTEGER,
      thinking_tokens INTEGER,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      output_quality_score INTEGER CHECK (output_quality_score BETWEEN 0 AND 10 OR output_quality_score IS NULL),
      tool_use_quality_score INTEGER CHECK (tool_use_quality_score BETWEEN 0 AND 10 OR tool_use_quality_score IS NULL),
      review_notes TEXT,
      reviewed_by TEXT,
      reviewed_at_utc TEXT,
      started_at_utc TEXT,
      completed_at_utc TEXT,
      updated_at_utc TEXT NOT NULL,
      UNIQUE(session_id, case_index, prompt_index, repeat_index)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_attempts_session_order
      ON benchmark_attempts(session_id, case_index ASC, prompt_index ASC, repeat_index ASC);
    CREATE INDEX IF NOT EXISTS idx_benchmark_attempts_status_updated
      ON benchmark_attempts(status, updated_at_utc DESC);

    CREATE TABLE IF NOT EXISTS benchmark_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
      attempt_id TEXT REFERENCES benchmark_attempts(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_llama')),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(session_id, attempt_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_logs_session_stream
      ON benchmark_logs(session_id, attempt_id, stream_kind, sequence ASC);
  `);
}

function ensureRuntimeMetricsTotalsSchema(database: RuntimeDatabase): void {
  database.exec(`
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
      speculative_accepted_tokens_total INTEGER NOT NULL,
      speculative_generated_tokens_total INTEGER NOT NULL,
      request_duration_ms_total INTEGER NOT NULL,
      wall_duration_ms_total INTEGER NOT NULL DEFAULT 0,
      stdin_wait_ms_total INTEGER NOT NULL DEFAULT 0,
      server_preflight_ms_total INTEGER NOT NULL DEFAULT 0,
      lock_wait_ms_total INTEGER NOT NULL DEFAULT 0,
      status_running_ms_total INTEGER NOT NULL DEFAULT 0,
      terminal_status_ms_total INTEGER NOT NULL DEFAULT 0,
      completed_request_count INTEGER NOT NULL,
      task_totals_json TEXT NOT NULL,
      tool_stats_json TEXT NOT NULL,
      updated_at_utc TEXT
    );
  `);
}


export function applyAssistantCoreSchema(database: RuntimeDatabase): void {
  database.exec(ASSISTANT_CORE_SCHEMA_SQL);
  seedAssistantRegistries(database, new SystemClock(), randomUUID());
}

export function applyAssistantProactiveSchema(database: RuntimeDatabase): void {
  database.exec(ASSISTANT_PROACTIVE_SCHEMA_SQL);
  if (!tableHasColumn(database, 'app_config', 'assistant_json')) {
    database.exec("ALTER TABLE app_config ADD COLUMN assistant_json TEXT NOT NULL DEFAULT '{}';");
  }
  if (!tableHasColumn(database, 'graph_assertions', 'user_demoted')) {
    database.exec(`
      ALTER TABLE graph_assertions
      ADD COLUMN user_demoted INTEGER NOT NULL DEFAULT 0 CHECK (user_demoted IN (0, 1));
    `);
  }
  if (!tableHasColumn(database, 'candidate_assertions', 'user_notes')) {
    database.exec(
      "ALTER TABLE candidate_assertions ADD COLUMN user_notes TEXT NOT NULL DEFAULT '';",
    );
  }
}

export function applyAssistantDesktopSchema(database: RuntimeDatabase): void {
  database.exec(ASSISTANT_DESKTOP_SCHEMA_SQL);
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
    ensureChatMessageTimelineSchema(database);
    ensureInferenceRunAndBenchmarkMatrixSchema(database);
    ensureDashboardBenchmarkSchema(database);
    ensureRuntimeErrorEventsSchema(database);
    applyAssistantCoreSchema(database);
    database.exec(ASSISTANT_FTS_SCHEMA_SQL);
    database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
    applyAssistantProactiveSchema(database);
    applyAssistantDesktopSchema(database);
    database.exec(ASSISTANT_MOBILE_SCHEMA_SQL);
    setSchemaVersion(database, CURRENT_SCHEMA_VERSION);
    return;
  }
  applyBaseSchema(database);
  ensureRuntimeMetricsTotalsSchema(database);
  for (const migration of MIGRATIONS) {
    if (currentVersion < migration.version) {
      migration.up(database);
      setSchemaVersion(database, migration.version);
      currentVersion = migration.version;
    }
  }
  ensureChatMessageTimelineSchema(database);
  ensureRuntimeArtifactsSchema(database);
  ensureInferenceRunAndBenchmarkMatrixSchema(database);
  ensureDashboardBenchmarkSchema(database);
  ensureRuntimeErrorEventsSchema(database);
}

/**
 * Opens an arbitrary database file, migrates it to `CURRENT_SCHEMA_VERSION`, and closes it.
 * A restore uses this so a backup taken on an older build lands on today's schema.
 */
export function migrateDatabaseFile(filePath: string): void {
  const database: RuntimeDatabase = new Database(resolve(filePath));
  try {
    configureRuntimeDatabase(database);
    ensureSchema(database);
  } finally {
    database.close();
  }
}

export function getRepoRuntimeRoot(startPath: string = process.cwd()): string {
  const repoRoot = findNearestSiftKitRepoRoot(startPath);
  const resolvedBaseRoot = repoRoot ? resolve(repoRoot) : resolve(startPath);
  return join(resolvedBaseRoot, '.siftkit');
}

export function getRuntimeDatabasePath(startPath: string = process.cwd()): string {
  return join(getRepoRuntimeRoot(startPath), 'runtime.sqlite');
}

function configureRuntimeDatabase(database: RuntimeDatabase): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

function closeRuntimeDatabaseHandle(database: RuntimeDatabase): void {
  try {
    database.exec(`
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
    `);
  } catch {
    // Best effort before close.
  }
  database.close();
}

export function getRuntimeDatabase(databasePath: string = getRuntimeDatabasePath()): RuntimeDatabase {
  const resolvedPath = resolve(databasePath);
  if (cachedDatabase && cachedDatabasePath === resolvedPath) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    closeRuntimeDatabaseHandle(cachedDatabase);
    cachedDatabase = null;
    cachedDatabasePath = null;
  }
  ensureDirectory(dirname(resolvedPath));
  let database: RuntimeDatabase = new Database(resolvedPath);
  try {
    configureRuntimeDatabase(database);
    ensureSchema(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a database|SQLITE_NOTADB/iu.test(message)) {
      closeRuntimeDatabaseHandle(database);
      throw error;
    }
    try {
      closeRuntimeDatabaseHandle(database);
    } catch {
      // Best effort close before reset.
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const targetPath = `${resolvedPath}${suffix}`;
      if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true });
      }
    }
    database = new Database(resolvedPath);
    configureRuntimeDatabase(database);
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
  closeRuntimeDatabaseHandle(cachedDatabase);
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
  const rawRow = database.prepare(`
    SELECT value
    FROM runtime_metadata
    WHERE key = ?
    LIMIT 1
  `).get(normalizedKey);
  const row = rawRow == null ? undefined : MetadataValueRowSchema.parse(rawRow);
  return typeof row?.value === 'string' ? row.value : null;
}

export interface PruneRuntimeHistoryResult {
  retentionDays: number;
  cutoffUtc: string;
  deleted: { table: string; rows: number }[];
  vacuumed: boolean;
}

const RUNTIME_HISTORY_VACUUM_FREELIST_RATIO = 0.1;

export function pruneRuntimeHistory(
  retentionDays: number,
  databasePath: string = getRuntimeDatabasePath(),
): PruneRuntimeHistoryResult {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoffUtc = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const database = getRuntimeDatabase(databasePath);
  const deleted: { table: string; rows: number }[] = [];

  // inference_run_log_chunks cascade-deletes via FK ON DELETE CASCADE on the runs table.
  const deleteStatements: { table: string; sql: string }[] = [
    { table: 'runtime_artifacts', sql: 'DELETE FROM runtime_artifacts WHERE created_at_utc < ?' },
    {
      table: 'run_logs',
      sql: 'DELETE FROM run_logs WHERE COALESCE(finished_at_utc, started_at_utc, flushed_at_utc) < ?',
    },
    {
      table: 'inference_runs',
      sql: "DELETE FROM inference_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
    },
    { table: 'idle_summary_snapshots', sql: 'DELETE FROM idle_summary_snapshots WHERE emitted_at_utc < ?' },
    { table: 'runtime_error_events', sql: 'DELETE FROM runtime_error_events WHERE created_at_utc < ?' },
    { table: 'benchmark_runs', sql: 'DELETE FROM benchmark_runs WHERE created_at_utc < ?' },
  ];

  database.transaction(() => {
    for (const { table, sql } of deleteStatements) {
      if (!tableExists(database, table)) {
        deleted.push({ table, rows: 0 });
        continue;
      }
      const info = database.prepare(sql).run(cutoffUtc);
      deleted.push({ table, rows: Number(info.changes) || 0 });
    }
  })();

  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // Best-effort; continue.
  }

  let vacuumed = false;
  try {
    const rawFreelistRow = database.prepare('PRAGMA freelist_count').get();
    const rawPageRow = database.prepare('PRAGMA page_count').get();
    const freelistRow = rawFreelistRow == null ? undefined : FreelistRowSchema.parse(rawFreelistRow);
    const pageRow = rawPageRow == null ? undefined : PageCountRowSchema.parse(rawPageRow);
    const freelistCount = Number(freelistRow?.freelist_count) || 0;
    const pageCount = Number(pageRow?.page_count) || 0;
    if (pageCount > 0 && freelistCount / pageCount > RUNTIME_HISTORY_VACUUM_FREELIST_RATIO) {
      database.exec('VACUUM;');
      vacuumed = true;
    }
  } catch {
    // VACUUM cannot run inside an open transaction or while locks are held; best-effort.
  }

  return { retentionDays: days, cutoffUtc, deleted, vacuumed };
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
