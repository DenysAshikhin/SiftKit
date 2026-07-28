import type Database from 'better-sqlite3';

type DatabaseInstance = InstanceType<typeof Database>;

export type AppConfigMigrationFixtureOptions = {
  omitExpandReads?: boolean;
  omitInference?: boolean;
  omitServerExl3?: boolean;
  omitWebSearch?: boolean;
};

export function createAppConfigMigrationFixture(
  database: DatabaseInstance,
  options: AppConfigMigrationFixtureOptions = {},
): void {
  const columns = [
    'id INTEGER PRIMARY KEY CHECK (id = 1)',
    "version TEXT NOT NULL DEFAULT '1'",
    "policy_mode TEXT NOT NULL DEFAULT 'conservative'",
    'raw_log_retention INTEGER NOT NULL DEFAULT 0 CHECK (raw_log_retention IN (0, 1))',
    'prompt_prefix TEXT',
    'runtime_model TEXT',
    'thresholds_min_characters_for_summary INTEGER NOT NULL DEFAULT 0',
    'thresholds_min_lines_for_summary INTEGER NOT NULL DEFAULT 0',
    'interactive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (interactive_enabled IN (0, 1))',
    "interactive_wrapped_commands_json TEXT NOT NULL DEFAULT '[]'",
    'interactive_idle_timeout_ms INTEGER NOT NULL DEFAULT 0',
    'interactive_max_transcript_characters INTEGER NOT NULL DEFAULT 0',
    'interactive_transcript_retention INTEGER NOT NULL DEFAULT 0 CHECK (interactive_transcript_retention IN (0, 1))',
    "server_llama_presets_json TEXT NOT NULL DEFAULT '[]'",
    'server_llama_active_preset_id TEXT',
    'server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1))',
    "operation_mode_allowed_tools_json TEXT NOT NULL DEFAULT '{}'",
    "presets_json TEXT NOT NULL DEFAULT '[]'",
    "updated_at_utc TEXT NOT NULL DEFAULT ''",
  ];
  if (!options.omitExpandReads) {
    columns.push('expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1))');
  }
  if (!options.omitInference) {
    columns.push("inference_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!options.omitServerExl3) {
    columns.push("server_exl3_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!options.omitWebSearch) {
    columns.push("web_search_json TEXT NOT NULL DEFAULT '{}'");
  }
  database.exec(`CREATE TABLE app_config (${columns.join(',\n')});`);
}
