import {
  ASSISTANT_CORE_SCHEMA_SQL,
  ASSISTANT_DESKTOP_SCHEMA_SQL,
  ASSISTANT_FTS_SCHEMA_SQL,
  ASSISTANT_MEMORY_SCHEMA_SQL,
  ASSISTANT_MOBILE_SCHEMA_SQL,
  ASSISTANT_PROACTIVE_SCHEMA_SQL,
} from '../assistant/storage/schema.js';
import { getDefaultOperationModeAllowedTools } from '../presets.js';
import type { RuntimeDatabase } from './database-handle.js';

/**
 * Durable chat queue entries. Shared by the fresh bootstrap and the 66 -> 67 upgrade so the two
 * paths cannot drift: a row is a user message that is waiting (`pending`) or has been claimed by
 * one engine request at one turn boundary (`delivered`) but not yet written into chat history.
 * `delivered_turn` 0 marks the message an operation started with as its own prompt.
 */
export const CHAT_PENDING_MESSAGES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chat_pending_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    content TEXT NOT NULL,
    images_json TEXT NOT NULL,
    options_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
    delivered_request_id TEXT,
    delivered_turn INTEGER,
    delivered_at_utc TEXT,
    created_at_utc TEXT NOT NULL,
    UNIQUE (session_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_pending_messages_session ON chat_pending_messages(session_id, state, sequence);
`;

/**
 * Canonical chat display projection. This single definition backs both the fresh bootstrap and the
 * versioned rebuild in `schema-upgrades/chat-recovery.ts`, so an existing database repaired in place
 * cannot drift from a database created today. `tool_call_status` is the display lifecycle only; an
 * in-progress row is legitimately persisted, so `running` is a durable value, not a transient one.
 */
export const CHAT_MESSAGES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chat_messages (
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
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
    thinking_content TEXT,
    tool_call_command TEXT,
    tool_call_activity_kind TEXT,
    tool_call_activity_subject_kind TEXT,
    tool_call_activity_subject_value TEXT,
    tool_call_turn INTEGER,
    tool_call_max_turns INTEGER,
    tool_call_exit_code INTEGER,
    tool_call_prompt_token_count INTEGER,
    tool_call_output_snippet TEXT,
    tool_call_output TEXT,
    tool_call_status TEXT CHECK (tool_call_status IN ('running', 'done', 'stopped')),
    tool_call_execution_state TEXT,
    approval_decision TEXT,
    approval_tool_name TEXT,
    approval_command TEXT,
    approval_reason TEXT,
    created_at_utc TEXT NOT NULL,
    source_run_id TEXT,
    compressed_into_summary INTEGER NOT NULL CHECK (compressed_into_summary IN (0, 1)),
    grounding_status TEXT,
    position INTEGER NOT NULL,
    images TEXT,
    image_meta TEXT,
    removed_image_count INTEGER,
    PRIMARY KEY (session_id, id)
  );
`;

/**
 * Every column of {@link CHAT_MESSAGES_SCHEMA_SQL} in declaration order. The rebuild copies these
 * names explicitly, so a column added to the DDL without being added here fails loudly instead of
 * being silently dropped by a `SELECT *`.
 */
export const CHAT_MESSAGES_COLUMNS = [
  'session_id',
  'id',
  'role',
  'kind',
  'content',
  'input_tokens_estimate',
  'output_tokens_estimate',
  'thinking_tokens',
  'input_tokens_estimated',
  'output_tokens_estimated',
  'thinking_tokens_estimated',
  'prompt_cache_tokens',
  'prompt_eval_tokens',
  'prompt_tokens_per_second',
  'output_tokens_per_second',
  'request_duration_ms',
  'prompt_eval_duration_ms',
  'generation_duration_ms',
  'request_started_at_utc',
  'thinking_started_at_utc',
  'thinking_ended_at_utc',
  'answer_started_at_utc',
  'answer_ended_at_utc',
  'speculative_accepted_tokens',
  'speculative_generated_tokens',
  'thinking_content',
  'tool_call_command',
  'tool_call_activity_kind',
  'tool_call_activity_subject_kind',
  'tool_call_activity_subject_value',
  'tool_call_turn',
  'tool_call_max_turns',
  'tool_call_exit_code',
  'tool_call_prompt_token_count',
  'tool_call_output_snippet',
  'tool_call_output',
  'tool_call_status',
  'tool_call_execution_state',
  'approval_decision',
  'approval_tool_name',
  'approval_command',
  'approval_reason',
  'created_at_utc',
  'source_run_id',
  'compressed_into_summary',
  'grounding_status',
  'position',
  'images',
  'image_meta',
  'removed_image_count',
] as const;

/**
 * Columns this upgrade introduces. A marker-67 table cannot carry them, so the rebuild copies the
 * rest and leaves these null for rows that predate the journal.
 */
export const CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY = ['tool_call_execution_state'] as const;

/**
 * The durable chat journal. `chat_run_events` is the authority for Web conversation and execution
 * history; `chat_messages` and the context snapshot are projections of it that can be thrown away
 * and rebuilt. Shared by the fresh bootstrap and the 67 -> 68 upgrade so the two cannot drift.
 */
export const CHAT_JOURNAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chat_runs (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    record_kind TEXT NOT NULL CHECK (record_kind IN ('execution', 'baseline', 'history_revision')),
    operation_kind TEXT CHECK (operation_kind IN ('message', 'plan', 'repo-search', 'repo-agent', 'condense')),
    request_id TEXT,
    repo_agent_session_id TEXT,
    run_order INTEGER NOT NULL CHECK (run_order >= 1),
    owner_epoch TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    terminal_cause TEXT CHECK (terminal_cause IN (
      'completed', 'user_stop', 'approval_timeout', 'provider_failure',
      'execution_failure', 'storage_failure', 'server_restart'
    )),
    latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
    projected_sequence INTEGER NOT NULL DEFAULT 0 CHECK (projected_sequence >= 0),
    context_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
    effective_settings_json TEXT,
    provenance_json TEXT,
    -- Only a real model run has an operation kind and execution settings; a baseline or a user
    -- edit is a committed record, never a run that can be mistaken for one.
    CHECK ((record_kind = 'execution') = (operation_kind IS NOT NULL)),
    CHECK (record_kind = 'execution' OR effective_settings_json IS NULL),
    UNIQUE (session_id, run_order)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runs_request
    ON chat_runs(request_id) WHERE request_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runs_repo_agent
    ON chat_runs(repo_agent_session_id) WHERE repo_agent_session_id IS NOT NULL;
  -- One unfinished execution per session, enforced by the database rather than by whichever
  -- in-memory registry happens to be alive.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runs_active
    ON chat_runs(session_id) WHERE record_kind = 'execution' AND terminal_cause IS NULL;
  CREATE INDEX IF NOT EXISTS idx_chat_runs_session_order ON chat_runs(session_id, run_order);

  CREATE TABLE IF NOT EXISTS chat_run_events (
    operation_id TEXT NOT NULL REFERENCES chat_runs(operation_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    event_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    recorded_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    PRIMARY KEY (operation_id, sequence)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_run_events_event_id
    ON chat_run_events(operation_id, event_id);

  -- A rebuildable cache of replayed planner history. Never an independent authority: it is only
  -- ever what replaying events up to applied_sequence produces.
  CREATE TABLE IF NOT EXISTS chat_context_snapshots (
    operation_id TEXT PRIMARY KEY REFERENCES chat_runs(operation_id) ON DELETE CASCADE,
    applied_sequence INTEGER NOT NULL CHECK (applied_sequence >= 0),
    context_revision INTEGER NOT NULL CHECK (context_revision >= 0),
    messages_json TEXT NOT NULL,
    recovery_batch_json TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_session_recovery (
    session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
    baseline_version INTEGER NOT NULL CHECK (baseline_version >= 0),
    last_reconciled_run_order INTEGER NOT NULL CHECK (last_reconciled_run_order >= 0),
    status TEXT NOT NULL CHECK (status IN ('ok', 'recovery_needed', 'recovery_failed')),
    issues_json TEXT NOT NULL,
    owner_epoch TEXT,
    updated_at_utc TEXT NOT NULL
  );

  -- Web runtime ownership. Two servers can bind different ports against the same database, so a
  -- pid or a port cannot decide who may admit runs; a fenced, leased epoch can.
  CREATE TABLE IF NOT EXISTS chat_runtime_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    heartbeat_at_utc TEXT NOT NULL,
    lease_expires_at_utc TEXT NOT NULL
  );
`;

function sqlString(value: string): string {
  return value.replaceAll("'", "''");
}

export function initializeRuntimeSchema(database: RuntimeDatabase): void {
  const operationModeDefault = sqlString(JSON.stringify(getDefaultOperationModeAllowedTools()));
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );

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
      server_model_presets_json TEXT NOT NULL DEFAULT '[]',
      server_model_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1)),
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '${operationModeDefault}',
      presets_json TEXT NOT NULL,
      web_search_json TEXT NOT NULL DEFAULT '{}',
      assistant_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_search_usage (
      month TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS runtime_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status_text TEXT NOT NULL CHECK (status_text IN ('true', 'false')),
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
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS inference_runs (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL CHECK (backend IN ('exl3')),
      purpose TEXT NOT NULL,
      entrypoint_path TEXT,
      base_url TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'stopped', 'sync_completed')),
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
    CREATE INDEX IF NOT EXISTS idx_inference_runs_started ON inference_runs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_status_started ON inference_runs(status, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_backend_started ON inference_runs(backend, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS inference_run_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL CHECK (stream_kind IN (
        'launcher_stdout', 'launcher_stderr', 'engine_stdout', 'engine_stderr',
        'startup_review', 'startup_failure')),
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
      baseline_restore_status TEXT NOT NULL CHECK (baseline_restore_status IN ('pending', 'completed', 'failed')),
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
      stream_kind TEXT NOT NULL CHECK (stream_kind IN (
        'launcher_stdout', 'launcher_stderr', 'benchmark_stdout', 'benchmark_stderr',
        'stop_stdout', 'stop_stderr', 'force_stop_stdout', 'force_stop_stderr')),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_matrix_logs_run_stream
      ON benchmark_matrix_logs(run_id, stream_kind, sequence ASC);

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

  database.exec(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      run_kind TEXT NOT NULL
        CHECK (run_kind IN ('summary_request','failed_request','request_abandoned','repo_search','chat','plan','unknown')),
      run_group TEXT NOT NULL
        CHECK (run_group IN ('summary','repo_search','planner','chat','other')),
      operation_type TEXT,
      operation_preset_id TEXT,
      model_preset_id TEXT,
      operation_preset_json TEXT,
      model_preset_json TEXT,
      terminal_state TEXT NOT NULL
        CHECK (terminal_state IN ('completed','failed','abandoned','unknown')),
      started_at_utc TEXT,
      finished_at_utc TEXT,
      title TEXT NOT NULL,
      model TEXT,
      backend TEXT,
      repo_root TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      thinking_tokens INTEGER,
      tool_tokens INTEGER,
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      prompt_eval_duration_ms INTEGER,
      generation_duration_ms INTEGER,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      duration_ms INTEGER,
      provider_duration_ms INTEGER,
      wall_duration_ms INTEGER,
      request_json TEXT,
      planner_debug_json TEXT,
      failed_request_json TEXT,
      abandoned_request_json TEXT,
      repo_search_json TEXT,
      repo_search_transcript_jsonl TEXT,
      source_paths_json TEXT NOT NULL DEFAULT '[]',
      flushed_at_utc TEXT NOT NULL,
      source_deleted_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_logs_started ON run_logs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_group_started ON run_logs(run_group, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_kind_started ON run_logs(run_kind, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_request_id ON run_logs(request_id);
    CREATE INDEX IF NOT EXISTS idx_run_logs_dashboard_order
      ON run_logs(COALESCE(finished_at_utc, started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC);
  
      CREATE TABLE IF NOT EXISTS idle_summary_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emitted_at_utc TEXT NOT NULL,
        completed_request_count INTEGER NOT NULL,
        input_characters_total INTEGER NOT NULL,
        output_characters_total INTEGER NOT NULL,
        input_tokens_total INTEGER NOT NULL,
        output_tokens_total INTEGER NOT NULL,
        thinking_tokens_total INTEGER NOT NULL,
        tool_tokens_total INTEGER NOT NULL DEFAULT 0,
        prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0,
        prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0,
        speculative_accepted_tokens_total INTEGER NOT NULL DEFAULT 0,
        speculative_generated_tokens_total INTEGER NOT NULL DEFAULT 0,
        task_totals_json TEXT NOT NULL DEFAULT '{}',
        tool_stats_json TEXT NOT NULL DEFAULT '{}',
        saved_tokens INTEGER NOT NULL,
        saved_percent REAL,
        compression_ratio REAL,
        request_duration_ms_total INTEGER NOT NULL,
        avg_request_ms REAL,
        avg_tokens_per_second REAL
      );
      CREATE INDEX IF NOT EXISTS idx_idle_summary_snapshots_emitted
        ON idle_summary_snapshots(emitted_at_utc DESC, id DESC);
    `);

  database.exec(CHAT_MESSAGES_SCHEMA_SQL);
  database.exec(CHAT_PENDING_MESSAGES_SCHEMA_SQL);
  database.exec(CHAT_JOURNAL_SCHEMA_SQL);
  database.exec(ASSISTANT_CORE_SCHEMA_SQL);
  database.exec(ASSISTANT_FTS_SCHEMA_SQL);
  database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
  database.exec(ASSISTANT_PROACTIVE_SCHEMA_SQL);
  database.exec(ASSISTANT_DESKTOP_SCHEMA_SQL);
  database.exec(ASSISTANT_MOBILE_SCHEMA_SQL);
}
