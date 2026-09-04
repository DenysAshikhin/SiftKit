import { randomUUID } from 'node:crypto';

import { SystemClock } from '../../assistant/clock.js';
import {
  ASSISTANT_CORE_SCHEMA_SQL,
  ASSISTANT_DESKTOP_SCHEMA_SQL,
  ASSISTANT_PROACTIVE_SCHEMA_SQL,
  seedAssistantRegistries,
} from '../../assistant/storage/schema.js';
import type { RuntimeDatabase } from '../database-handle.js';
import { tableExists, tableHasColumn } from './schema-introspection.js';

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
        CHECK (backend IN ('exl3')),
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
      stream_kind TEXT NOT NULL CHECK (stream_kind IN ('orchestrator', 'attempt_stdout', 'attempt_stderr', 'managed_engine')),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(session_id, attempt_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_logs_session_stream
      ON benchmark_logs(session_id, attempt_id, stream_kind, sequence ASC);
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
