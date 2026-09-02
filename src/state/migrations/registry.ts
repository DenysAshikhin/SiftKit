import type { Migration } from './types.js';
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import { tableExists, tableHasColumn } from './schema-introspection.js';
import {
  migrateAppConfigIdleAction,
  migrateAppConfigRemoveGlobalStartupContext,
  migrateAppConfigToPresetSourceOfTruth,
  migrateChatSessionsToModelPresetIdentity,
  migrateChatSessionsToModelPresetSnapshot,
  migrateRunLogsBackendToEngineIds,
} from './app-config-migrations.js';
import {
  ASSISTANT_CORE_SCHEMA_SQL,
  ASSISTANT_DESKTOP_SCHEMA_SQL,
  ASSISTANT_FTS_SCHEMA_SQL,
  ASSISTANT_MEMORY_SCHEMA_SQL,
  ASSISTANT_MOBILE_SCHEMA_SQL,
  backfillAssistantFtsRowids,
} from '../../assistant/storage/schema.js';
import {
  applyAssistantCoreSchema,
  applyAssistantDesktopSchema,
  applyAssistantProactiveSchema,
  ensureChatMessageTimelineSchema,
  ensureDashboardBenchmarkSchema,
  ensureInferenceRunAndBenchmarkMatrixSchema,
  ensureRuntimeArtifactsSchema,
  ensureRuntimeErrorEventsSchema,
} from './schema-helpers.js';
import {
  BACKGROUND_WORK_DECISIONS_METADATA_KEY,
  DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON,
  REMOVED_COMBINED_INPUT_IDLE_REASON,
} from './constants.js';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    up: (database) => {
    ensureRuntimeArtifactsSchema(database);
    },
  },
  {
    version: 3,
    up: (database) => {
    ensureInferenceRunAndBenchmarkMatrixSchema(database);
    },
  },
  {
    version: 4,
    up: (database) => {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN presets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE chat_sessions ADD COLUMN preset_id TEXT;
    `);
    },
  },
  {
    version: 5,
    up: (database) => {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '${DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON}';
    `);
    },
  },
  {
    version: 6,
    up: (database) => {
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
        operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '${DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON}',
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
    },
  },
  {
    version: 7,
    up: (database) => {
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
    },
  },
  {
    version: 8,
    up: (database) => {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_kv_cache_quant TEXT;
    `);
    },
  },
  {
    version: 9,
    up: (database) => {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_llama_presets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE app_config ADD COLUMN server_llama_active_preset_id TEXT;
    `);
    },
  },
  {
    version: 10,
    up: (database) => {
    database.exec(`
      ALTER TABLE app_config ADD COLUMN server_reasoning_budget_message TEXT;
    `);
    },
  },
  {
    version: 11,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'app_config', 'llama_ncpu_moe')) {
      alterStatements.push('ALTER TABLE app_config ADD COLUMN llama_ncpu_moe INTEGER;');
    }
    if (!tableHasColumn(database, 'app_config', 'server_ncpu_moe')) {
      alterStatements.push('ALTER TABLE app_config ADD COLUMN server_ncpu_moe INTEGER;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  { version: 12, up: () => {} },
  { version: 13, up: () => {} },
  {
    version: 14,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'speculative_accepted_tokens_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN speculative_accepted_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'speculative_generated_tokens_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN speculative_generated_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'wall_duration_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN wall_duration_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'stdin_wait_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN stdin_wait_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'server_preflight_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN server_preflight_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'lock_wait_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN lock_wait_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'status_running_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN status_running_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'runtime_metrics_totals', 'terminal_status_ms_total')) {
      alterStatements.push('ALTER TABLE runtime_metrics_totals ADD COLUMN terminal_status_ms_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'request_duration_ms')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN request_duration_ms INTEGER;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'speculative_accepted_tokens')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN speculative_accepted_tokens INTEGER;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'speculative_generated_tokens')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN speculative_generated_tokens INTEGER;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 15,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'chat_messages', 'request_started_at_utc')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN request_started_at_utc TEXT;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'thinking_started_at_utc')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN thinking_started_at_utc TEXT;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'thinking_ended_at_utc')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN thinking_ended_at_utc TEXT;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'answer_started_at_utc')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN answer_started_at_utc TEXT;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'answer_ended_at_utc')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN answer_ended_at_utc TEXT;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 16,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'chat_messages', 'prompt_eval_duration_ms')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN prompt_eval_duration_ms INTEGER;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'generation_duration_ms')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN generation_duration_ms INTEGER;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 17,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'chat_messages', 'prompt_tokens_per_second')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN prompt_tokens_per_second REAL;');
    }
    if (!tableHasColumn(database, 'chat_messages', 'output_tokens_per_second')) {
      alterStatements.push('ALTER TABLE chat_messages ADD COLUMN output_tokens_per_second REAL;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 19,
    up: (database) => {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'observed_budget_state', 'observed_chars_total')) {
      alterStatements.push('ALTER TABLE observed_budget_state ADD COLUMN observed_chars_total REAL;');
    }
    if (!tableHasColumn(database, 'observed_budget_state', 'observed_tokens_total')) {
      alterStatements.push('ALTER TABLE observed_budget_state ADD COLUMN observed_tokens_total REAL;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 20,
    up: (database) => {
    const alterStatements: string[] = [];
    if (tableExists(database, 'managed_llama_runs') && !tableHasColumn(database, 'managed_llama_runs', 'speculative_accepted_tokens')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN speculative_accepted_tokens INTEGER;');
    }
    if (tableExists(database, 'managed_llama_runs') && !tableHasColumn(database, 'managed_llama_runs', 'speculative_generated_tokens')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN speculative_generated_tokens INTEGER;');
    }
    if (tableExists(database, 'managed_llama_runs') && !tableHasColumn(database, 'managed_llama_runs', 'stdout_character_count')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN stdout_character_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (tableExists(database, 'managed_llama_runs') && !tableHasColumn(database, 'managed_llama_runs', 'stderr_character_count')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN stderr_character_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (tableExists(database, 'managed_llama_runs') && !tableHasColumn(database, 'managed_llama_runs', 'metrics_updated_at_utc')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN metrics_updated_at_utc TEXT;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    },
  },
  {
    version: 21,
    up: (database) => {
    ensureRuntimeErrorEventsSchema(database);
    },
  },
  {
    version: 22,
    up: (database) => {
    if (!tableHasColumn(database, 'app_config', 'server_external_server_enabled')) {
      database.exec('ALTER TABLE app_config ADD COLUMN server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1));');
    }
    },
  },
  {
    version: 23,
    up: (database) => {
    const legacyColumns = ['server_startup_script', 'server_shutdown_script', 'server_verbose_args_json'];
    for (const column of legacyColumns) {
      if (tableHasColumn(database, 'app_config', column)) {
        database.exec(`ALTER TABLE app_config DROP COLUMN ${column};`);
      }
    }
    },
  },
  {
    version: 24,
    up: (database) => {
    if (!tableHasColumn(database, 'app_config', 'server_sleep_idle_seconds')) {
      database.exec('ALTER TABLE app_config ADD COLUMN server_sleep_idle_seconds INTEGER;');
    }
    },
  },
  {
    version: 25,
    up: (database) => {
    ensureDashboardBenchmarkSchema(database);
    },
  },
  {
    version: 26,
    up: (database) => {
    migrateAppConfigToPresetSourceOfTruth(database);
    },
  },
  {
    version: 27,
    up: (database) => {
    ensureChatMessageTimelineSchema(database);
    },
  },
  {
    version: 29,
    up: (database) => {
    if (!tableHasColumn(database, 'app_config', 'web_search_json')) {
      database.exec("ALTER TABLE app_config ADD COLUMN web_search_json TEXT NOT NULL DEFAULT '{}';");
    }
    if (!tableHasColumn(database, 'chat_sessions', 'web_search_enabled')) {
      database.exec('ALTER TABLE chat_sessions ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_search_enabled IN (0, 1));');
    }
    },
  },
  {
    version: 30,
    up: (database) => {
    if (!tableHasColumn(database, 'chat_messages', 'grounding_status')) {
      database.exec('ALTER TABLE chat_messages ADD COLUMN grounding_status TEXT;');
    }
    },
  },
  {
    version: 31,
    up: (database) => {
    if (!tableHasColumn(database, 'app_config', 'inference_json')) {
      database.exec("ALTER TABLE app_config ADD COLUMN inference_json TEXT NOT NULL DEFAULT '{}';");
    }
    if (!tableHasColumn(database, 'app_config', 'server_exl3_json')) {
      database.exec("ALTER TABLE app_config ADD COLUMN server_exl3_json TEXT NOT NULL DEFAULT '{}';");
    }
    },
  },
  {
    version: 32,
    up: (database) => {
    if (tableHasColumn(database, 'app_config', 'backend')) {
      database.exec('ALTER TABLE app_config DROP COLUMN backend;');
    }
    },
  },
  {
    version: 33,
    up: (database) => {
    migrateChatSessionsToModelPresetIdentity(database);
    },
  },
  {
    version: 34,
    up: (database) => {
    // No backward compatibility: managed llama run history is disposable local telemetry
    // and its schema is llama-shaped. Drop it and let the backend-neutral tables be created.
    database.exec(`
      DROP TABLE IF EXISTS managed_llama_log_chunks;
      DROP TABLE IF EXISTS managed_llama_runs;
    `);
    },
  },
  {
    version: 35,
    up: (database) => {
    if (!tableHasColumn(database, 'app_config', 'expand_reads')) {
      database.exec('ALTER TABLE app_config ADD COLUMN expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1));');
    }
    },
  },
  {
    version: 36,
    up: (database) => {
    migrateAppConfigRemoveGlobalStartupContext(database);
    },
  },
  {
    version: 37,
    up: (database) => {
    migrateChatSessionsToModelPresetSnapshot(database);
    },
  },
  {
    version: 38,
    up: (database) => {
    migrateRunLogsBackendToEngineIds(database);
    },
  },
  {
    version: 39,
    up: (database) => {
    applyAssistantCoreSchema(database);
    },
  },
  {
    version: 40,
    up: (database) => {
    database.exec(ASSISTANT_FTS_SCHEMA_SQL);
    },
  },
  {
    version: 41,
    up: (database) => {
    database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
    },
  },
  {
    version: 42,
    up: (database) => {
    applyAssistantProactiveSchema(database);
    },
  },
  {
    version: 43,
    up: (database) => {
    applyAssistantDesktopSchema(database);
    },
  },
  {
    version: 44,
    up: (database) => {
    database.exec(ASSISTANT_MOBILE_SCHEMA_SQL);
    },
  },
  {
    version: 45,
    up: (database) => {
    database.exec(ASSISTANT_CORE_SCHEMA_SQL);
    },
  },
  {
    version: 46,
    up: (database) => {
    for (const table of ['graph_nodes', 'graph_assertions', 'memory_projections'] as const) {
      if (!tableHasColumn(database, table, 'fts_rowid')) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN fts_rowid INTEGER;`);
      }
    }
    database.exec(ASSISTANT_CORE_SCHEMA_SQL);
    database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
    database.exec(ASSISTANT_DESKTOP_SCHEMA_SQL);
    backfillAssistantFtsRowids(database);
    },
  },
  {
    version: 47,
    up: (database) => {
    migrateAppConfigIdleAction(database);
    },
  },
  {
    version: 48,
    up: (database) => {
    // Pre-v48 builds stamped the run-total prompt tokens onto every tool row;
    // the real per-call value is unknowable for them, so reset to "unknown".
    if (tableHasColumn(database, 'chat_messages', 'tool_call_prompt_token_count')) {
      database.exec('UPDATE chat_messages SET tool_call_prompt_token_count = NULL;');
    }
    },
  },
  {
    version: 49,
    up: (database) => {
    if (tableHasColumn(database, 'chat_messages', 'image_meta')) {
      database.exec(`
      UPDATE chat_messages
      SET input_tokens_estimate = 0,
          input_tokens_estimated = 0
      WHERE role = 'user'
        AND coalesce(kind, 'user_text') = 'user_text'
        AND trim(content) = ''
        AND image_meta IS NOT NULL
        AND json_array_length(image_meta) > 0;
      `);
    }
    },
  },
  {
    version: 50,
    up: (database) => {
    // The 2400-character condensed tail is gone: compaction now writes a real summary
    // message. Old sessions have no summary row to replay, so their flags reset and
    // their full history replays until the next compaction writes one.
    if (tableHasColumn(database, 'chat_sessions', 'condensed_summary')) {
      database.exec('ALTER TABLE chat_sessions DROP COLUMN condensed_summary;');
    }
    if (tableHasColumn(database, 'chat_messages', 'compressed_into_summary')) {
      database.exec('UPDATE chat_messages SET compressed_into_summary = 0;');
    }
    },
  },
  {
    version: 51,
    up: (database) => {
      if (!tableHasColumn(database, 'chat_messages', 'tool_call_activity_kind')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN tool_call_activity_kind TEXT;');
      }
      if (tableHasColumn(database, 'chat_messages', 'kind')) {
        database.exec(`
          UPDATE chat_messages
          SET tool_call_activity_kind = 'command'
          WHERE kind = 'assistant_tool_call'
            AND tool_call_activity_kind IS NULL;
        `);
      }
    },
  },
  {
    version: 52,
    up: (database) => {
      if (!tableHasColumn(database, 'chat_messages', 'tool_call_activity_subject_kind')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN tool_call_activity_subject_kind TEXT;');
      }
      if (!tableHasColumn(database, 'chat_messages', 'tool_call_activity_subject_value')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN tool_call_activity_subject_value TEXT;');
      }
      if (tableHasColumn(database, 'chat_messages', 'kind')) {
        database.exec(`
          UPDATE chat_messages
          SET tool_call_activity_subject_kind = 'none',
              tool_call_activity_subject_value = NULL
          WHERE kind = 'assistant_tool_call'
            AND tool_call_activity_subject_kind IS NULL;
        `);
      }
    },
  },
  {
    version: 53,
    up: (database) => {
      const hasOldName = tableHasColumn(database, 'chat_messages', 'tool_call_max_turns');
      const hasNewName = tableHasColumn(database, 'chat_messages', 'tool_call_limit');
      if (hasOldName && !hasNewName) {
        database.exec('ALTER TABLE chat_messages RENAME COLUMN tool_call_max_turns TO tool_call_limit;');
      } else if (hasOldName && hasNewName) {
        database.exec(`
          UPDATE chat_messages
          SET tool_call_limit = coalesce(tool_call_limit, tool_call_max_turns);
          ALTER TABLE chat_messages DROP COLUMN tool_call_max_turns;
        `);
      } else if (!hasNewName) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN tool_call_limit INTEGER;');
      }
    },
  },
  {
    version: 54,
    up: (database) => {
      if (!tableHasColumn(database, 'chat_messages', 'approval_decision')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN approval_decision TEXT;');
      }
      if (!tableHasColumn(database, 'chat_messages', 'approval_tool_name')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN approval_tool_name TEXT;');
      }
      if (!tableHasColumn(database, 'chat_messages', 'approval_command')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN approval_command TEXT;');
      }
      if (!tableHasColumn(database, 'chat_messages', 'approval_reason')) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN approval_reason TEXT;');
      }
    },
  },
  {
    // v53 named this column after a limit, but the value written to it was always the run's turn
    // cap. Restore the honest name; the persisted quantity is unchanged.
    version: 55,
    up: (database) => {
      const hasOldName = tableHasColumn(database, 'chat_messages', 'tool_call_limit');
      const hasNewName = tableHasColumn(database, 'chat_messages', 'tool_call_max_turns');
      if (hasOldName && !hasNewName) {
        database.exec('ALTER TABLE chat_messages RENAME COLUMN tool_call_limit TO tool_call_max_turns;');
      } else if (hasOldName && hasNewName) {
        database.exec(`
          UPDATE chat_messages
          SET tool_call_max_turns = coalesce(tool_call_max_turns, tool_call_limit);
          ALTER TABLE chat_messages DROP COLUMN tool_call_limit;
        `);
      } else if (!hasNewName) {
        database.exec('ALTER TABLE chat_messages ADD COLUMN tool_call_max_turns INTEGER;');
      }
    },
  },
  {
    // The idle gate split its combined input reason into mouse/keyboard reasons; persisted
    // history entries with the removed reason cannot be re-expressed truthfully, so they go.
    version: 56,
    up: (database) => {
      const key = BACKGROUND_WORK_DECISIONS_METADATA_KEY;
      const row = database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get(key);
      if (row === undefined || row === null) return;
      const histories = parseJsonText(
        z.object({ value: z.string() }).strict().parse(row).value,
        z.record(z.string(), z.array(z.looseObject({ reason: z.string() }))),
      );
      const kept = Object.fromEntries(
        Object.entries(histories).map(([ownerId, entries]) => [
          ownerId, entries.filter((entry) => entry.reason !== REMOVED_COMBINED_INPUT_IDLE_REASON),
        ]),
      );
      database.prepare('UPDATE runtime_metadata SET value = ? WHERE key = ?')
        .run(JSON.stringify(kept), key);
    },
  },
  {
    // The activity event stores both input signals instead of their minimum under the old
    // combined name. Rows written before the split carried one value; it seeds both columns.
    version: 57,
    up: (database) => {
      if (!tableHasColumn(database, 'assistant_activity_events', 'idle_seconds')) return;
      database.exec(`
        ALTER TABLE assistant_activity_events RENAME COLUMN idle_seconds TO mouse_idle_seconds;
        ALTER TABLE assistant_activity_events
          ADD COLUMN keyboard_idle_seconds INTEGER NOT NULL DEFAULT 0
          CHECK (keyboard_idle_seconds >= 0);
        UPDATE assistant_activity_events SET keyboard_idle_seconds = mouse_idle_seconds;
      `);
    },
  },
];
